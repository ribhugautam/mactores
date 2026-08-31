import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  setTokens,
} from "@/lib/client/token-store";

export class ApiError extends Error {
  status: number;
  /** Field-level errors from a 422, keyed by form field name. */
  fieldErrors?: Record<string, string[]>;
  constructor(status: number, message: string, fieldErrors?: Record<string, string[]>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

/** Fired when auth is unrecoverable. The auth provider listens for this and logs the user out. */
export const AUTH_LOGOUT_EVENT = "encodr:logout";

async function parseError(res: Response): Promise<ApiError> {
  let detail = res.statusText || "Request failed";
  let fieldErrors: Record<string, string[]> | undefined;
  try {
    const body = await res.json();
    if (body?.detail) detail = body.detail;
    if (body?.fieldErrors) {
      fieldErrors = body.fieldErrors;
      detail = "Validation failed";
    }
  } catch {
    /* non-JSON body */
  }
  return new ApiError(res.status, detail, fieldErrors);
}

/** The single place the access token is turned into a header. Shared with the SSE stream. */
export function authHeader(): Record<string, string> {
  const access = getAccessToken();
  return access ? { authorization: `Bearer ${access}` } : {};
}

/** Give up on auth: drop the tokens and let the provider route back to /signin. */
export function signalAuthFailure(): void {
  clearTokens();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_LOGOUT_EVENT));
  }
}

// --- silent refresh ---
//
// Access tokens live 60s, so in a normal session several queries will 401 within the same tick.
// Holding the in-flight promise here means those callers all await ONE POST /api/auth/refresh
// instead of stampeding the endpoint with N — and, more importantly, they can't race each other
// into overwriting a fresh token with a staler one.

let refreshInFlight: Promise<string | null> | null = null;

/** Returns the new access token, or null if the session is unrecoverable. */
export function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async (): Promise<string | null> => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return null;

    try {
      // Deliberately a bare fetch, not `request()` — the refresh call must never recurse back
      // into the 401 handler.
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return null;

      const { accessToken } = (await res.json()) as { accessToken: string };
      setTokens({ accessToken });
      return accessToken;
    } catch {
      return null; // network failure — treat as "couldn't refresh"
    }
  })();

  // Clear the slot once settled so the *next* 401 starts a fresh attempt rather than reusing a
  // resolved (possibly failed) promise forever.
  void refreshInFlight.finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { ...authHeader() };
  if (options.body !== undefined) headers["content-type"] = "application/json";

  return fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let res = await send(path, options);

  // A 401 from /api/auth/* is a real credential failure, not an expired access token — retrying
  // it would just fail again and log the user out on a bad password.
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      signalAuthFailure();
      throw await parseError(res);
    }

    // Exactly one retry. If it still 401s, the problem isn't a stale token.
    res = await send(path, options);
    if (res.status === 401) {
      signalAuthFailure();
      throw await parseError(res);
    }
  }

  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
};
