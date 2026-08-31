import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, AUTH_LOGOUT_EVENT } from "@/lib/client/api";
import { clearTokens, getAccessToken, setTokens } from "@/lib/client/token-store";

// The 401 -> silent refresh -> single retry flow. Worth testing properly: it's invisible when it
// works, and when it's wrong it either logs people out mid-session or hammers the refresh endpoint.

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authorizationOf(call: unknown[]): string | undefined {
  const init = call[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string> | undefined)?.authorization;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  clearTokens();
  setTokens({ accessToken: "stale-access", refreshToken: "valid-refresh" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("401 handling", () => {
  it("refreshes once and replays the original request with the new token", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { detail: "Not authenticated" }))
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: "fresh-access" }))
      .mockResolvedValueOnce(jsonResponse(200, [{ id: "j_1" }]));

    await expect(api.get("/api/jobs")).resolves.toEqual([{ id: "j_1" }]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/auth/refresh");

    expect(authorizationOf(fetchMock.mock.calls[0] ?? [])).toBe("Bearer stale-access");
    // The retry must carry the refreshed token, not replay the expired one.
    expect(authorizationOf(fetchMock.mock.calls[2] ?? [])).toBe("Bearer fresh-access");
    expect(getAccessToken()).toBe("fresh-access");
  });

  it("retries exactly once — a second 401 gives up rather than looping", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { detail: "Not authenticated" }))
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: "fresh-access" }))
      .mockResolvedValueOnce(jsonResponse(401, { detail: "Not authenticated" }));

    await expect(api.get("/api/jobs")).rejects.toBeInstanceOf(ApiError);

    // request, refresh, retry. Nothing more.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("shares ONE refresh across requests that 401 at the same time", async () => {
    let refreshCalls = 0;

    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === "/api/auth/refresh") {
        refreshCalls += 1;
        // Yield, so any un-shared caller has every chance to fire its own refresh.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return jsonResponse(200, { accessToken: "fresh-access" });
      }

      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      return auth === "Bearer fresh-access"
        ? jsonResponse(200, { ok: true })
        : jsonResponse(401, { detail: "Not authenticated" });
    });

    await Promise.all([
      api.get("/api/jobs"),
      api.get("/api/jobs"),
      api.get("/api/runs/r_1"),
      api.get("/api/jobs/j_1"),
    ]);

    expect(refreshCalls).toBe(1);
  });

  it("clears auth and asks the app to sign out when the refresh fails", async () => {
    const onLogout = vi.fn();
    window.addEventListener(AUTH_LOGOUT_EVENT, onLogout);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { detail: "Not authenticated" }))
      .mockResolvedValueOnce(jsonResponse(401, { detail: "Invalid or expired refresh token" }));

    await expect(api.get("/api/jobs")).rejects.toBeInstanceOf(ApiError);

    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();
    window.removeEventListener(AUTH_LOGOUT_EVENT, onLogout);
  });

  it("does not try to refresh a failed sign-in", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { detail: "Invalid email or password" }));

    // A wrong password is not an expired token; refreshing would just fail and log the user out.
    await expect(
      api.post("/api/auth/login", { email: "demo@encodr.dev", password: "nope" }),
    ).rejects.toMatchObject({ status: 401, message: "Invalid email or password" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("error shaping", () => {
  it("surfaces a 422's field errors so the form can map them", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, {
        detail: "Validation failed",
        fieldErrors: { sourceUrl: ["Only http:// and https:// sources are supported"] },
      }),
    );

    const error = await api.post("/api/jobs", { sourceUrl: "ftp://x/y.mp4" }).catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).fieldErrors?.sourceUrl?.[0]).toMatch(/http/);
  });
});
