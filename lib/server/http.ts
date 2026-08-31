import { z, type ZodType } from "zod";
import { getUserIdFromRequest } from "@/lib/server/auth";

export function json(data: unknown, init?: number | ResponseInit): Response {
  const responseInit: ResponseInit = typeof init === "number" ? { status: init } : (init ?? {});
  return new Response(JSON.stringify(data), {
    ...responseInit,
    headers: { "content-type": "application/json", ...(responseInit.headers ?? {}) },
  });
}

export function error(status: number, detail: string): Response {
  return json({ detail }, status);
}

/** Returns the authenticated userId, or throws a Response (401) to be caught by the handler. */
export function requireUser(req: Request): string {
  const userId = getUserIdFromRequest(req);
  if (!userId) throw error(401, "Not authenticated");
  return userId;
}

/**
 * Parse and validate a JSON body, or throw a 422 carrying field-level errors.
 *
 * The 422 shape (`{ detail, fieldErrors, formErrors }`) is what the client's ApiError reads, which
 * is how a server-side rejection lands on the right React Hook Form field rather than in a generic
 * banner. Same Zod schema on both sides, so the two can't drift.
 */
export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw error(400, "Expected a JSON body");
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const { fieldErrors, formErrors } = z.flattenError(parsed.error);
    throw json({ detail: "Validation failed", fieldErrors, formErrors }, 422);
  }
  return parsed.data;
}

/**
 * Runs a handler, turning a thrown Response (from requireUser / parseBody) into the response and
 * anything else into a 500. Lets handlers read as a straight line instead of nested try/catch.
 */
export async function handle(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Response) return e;
    console.error("Unhandled route error:", e);
    return error(500, "Unexpected server error");
  }
}

/** Wraps a handler so it only runs for an authenticated request. */
export async function withAuth(
  req: Request,
  handler: (userId: string) => Promise<Response> | Response,
): Promise<Response> {
  return handle(() => handler(requireUser(req)));
}
