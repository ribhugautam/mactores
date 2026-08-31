import { error, handle, requireUser } from "@/lib/server/http";
import { computeRunEvent, getRunRecord } from "@/lib/server/store";
import { isTerminalStage } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Fast enough to feel live, slow enough that a 30s run produces ~60 frames, not thousands. */
const TICK_MS = 500;

/** Hint to the browser's SSE reconnect backoff after a transient drop. */
const RECONNECT_HINT_MS = 1_000;

/**
 * The live progress stream.
 *
 * Auth is a plain `Authorization: Bearer` header, same as every other route — the client opens
 * this with `@microsoft/fetch-event-source` rather than native `EventSource` precisely so it can
 * set one. See the README for why that beat a query-param token.
 *
 * Because a run's state is a pure function of elapsed time (see lib/server/store.ts), this handler
 * holds no per-connection state: it samples on a timer and pushes what changed. That makes
 * reconnect free — a client that drops and comes back simply resumes sampling at the current
 * point, so there's no replay buffer or Last-Event-ID bookkeeping to get wrong.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    requireUser(req);
    const { id } = await ctx.params;

    const record = getRunRecord(id);
    if (!record) return error(404, "Run not found");

    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let timer: ReturnType<typeof setInterval> | undefined;
        let closed = false;
        let lastFrame: string | null = null;

        const close = () => {
          if (closed) return;
          closed = true;
          if (timer) clearInterval(timer);
          req.signal.removeEventListener("abort", close);
          try {
            controller.close();
          } catch {
            // Already closed by the runtime after a client disconnect — nothing to do.
          }
        };

        const push = () => {
          if (closed) return;

          const event = computeRunEvent(record, Date.now());
          const frame = JSON.stringify(event);

          // Only send on change: the tick is faster than the state moves, and a client that sees
          // the same frame twice would double up its log.
          if (frame !== lastFrame) {
            lastFrame = frame;
            controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
          }

          // A terminal run has nothing left to say. Closing here (rather than letting the client
          // hang up) is what stops a completed run leaking a timer per viewer.
          if (isTerminalStage(event.stage)) close();
        };

        // The client may navigate away or unmount mid-run; that aborts the request and must take
        // the interval down with it.
        req.signal.addEventListener("abort", close);
        if (req.signal.aborted) {
          close();
          return;
        }

        controller.enqueue(encoder.encode(`retry: ${RECONNECT_HINT_MS}\n\n`));
        push(); // Send the current state immediately so a late subscriber isn't blank for 500ms.
        if (!closed) timer = setInterval(push, TICK_MS);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Tells nginx-style proxies not to buffer the stream into uselessness.
        "x-accel-buffering": "no",
      },
    });
  });
}
