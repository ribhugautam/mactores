import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_TTL_SEC,
  getUserIdFromRequest,
  issueAccessToken,
  issueTokens,
  verifyRefreshToken,
  verifyToken,
} from "@/lib/server/auth";

const T0 = 1_700_000_000_000;
const USER = "u_demo";

function bearer(token: string): Request {
  return new Request("http://localhost/api/jobs", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("token issuance", () => {
  it("issues an access token that verifies now and expires on schedule", () => {
    const { accessToken } = issueTokens(USER, T0);

    expect(verifyToken(accessToken, "access", T0)?.sub).toBe(USER);
    expect(verifyToken(accessToken, "access", T0 + (ACCESS_TOKEN_TTL_SEC - 1) * 1_000)).not.toBeNull();
    expect(verifyToken(accessToken, "access", T0 + ACCESS_TOKEN_TTL_SEC * 1_000)).toBeNull();
  });

  it("issues a refresh token that outlives the access token", () => {
    const { refreshToken } = issueTokens(USER, T0);
    const wellPastAccessExpiry = T0 + 60 * 60 * 1_000;

    expect(verifyToken(refreshToken, "refresh", wellPastAccessExpiry)?.sub).toBe(USER);
  });
});

describe("token verification", () => {
  it("refuses to accept a refresh token where an access token is required, and vice versa", () => {
    const { accessToken, refreshToken } = issueTokens(USER, T0);

    // Without the type check, a leaked refresh token would be a 7-day API key.
    expect(verifyToken(refreshToken, "access", T0)).toBeNull();
    expect(getUserIdFromRequest(bearer(refreshToken))).toBeNull();
    expect(verifyRefreshToken(accessToken)).toBeNull();
  });

  it("rejects a token whose payload has been edited", () => {
    const token = issueAccessToken(USER, T0);
    const [payload, signature] = token.split(".");

    const forged = Buffer.from(JSON.stringify({ sub: "u_admin", typ: "access", exp: 9e9 })).toString(
      "base64url",
    );
    expect(verifyToken(`${forged}.${signature}`, "access", T0)).toBeNull();

    // ...and one whose signature has been edited.
    expect(verifyToken(`${payload}.${signature}x`, "access", T0)).toBeNull();
  });

  it("rejects malformed tokens instead of throwing", () => {
    for (const bad of ["", "nonsense", "a.b.c", "not-base64.sig"]) {
      expect(verifyToken(bad, "access", T0)).toBeNull();
    }
  });
});

describe("getUserIdFromRequest", () => {
  it("reads a valid bearer token", () => {
    const token = issueAccessToken(USER);
    expect(getUserIdFromRequest(bearer(token))).toBe(USER);
  });

  it("returns null for a missing or non-bearer Authorization header", () => {
    const token = issueAccessToken(USER);

    expect(getUserIdFromRequest(new Request("http://localhost/api/jobs"))).toBeNull();
    expect(
      getUserIdFromRequest(
        new Request("http://localhost/api/jobs", { headers: { authorization: token } }),
      ),
    ).toBeNull();
    expect(
      getUserIdFromRequest(
        new Request("http://localhost/api/jobs", {
          headers: { authorization: `Basic ${token}` },
        }),
      ),
    ).toBeNull();
  });

  it("does not accept a token passed in the query string", () => {
    // The SSE stream authenticates by header too, so there is deliberately no query-param path in.
    const token = issueAccessToken(USER);
    const req = new Request(`http://localhost/api/runs/r_1/events?access_token=${token}`);
    expect(getUserIdFromRequest(req)).toBeNull();
  });
});
