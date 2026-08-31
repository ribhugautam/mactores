"use client";

import { useEffect, useRef, useState } from "react";
import { EventStreamContentType, fetchEventSource } from "@microsoft/fetch-event-source";
import { authHeader, refreshAccessToken, signalAuthFailure } from "@/lib/client/api";
import { isTerminalStage, type RunEvent, type Stage } from "@/lib/types";

export interface RunStreamState {
  stage: Stage | null;
  progressPct: number;
  log: string[];
  error: string | null;
  connected: boolean;
  done: boolean;
}

const initialState: RunStreamState = {
  stage: null,
  progressPct: 0,
  log: [],
  error: null,
  connected: false,
  done: false,
};

const RETRY_MS = 1_000;
/** After this many consecutive failures we stop reconnecting and surface the problem. */
const MAX_RETRIES = 5;

/** Ends the stream for good — no reconnect. */
class FatalStreamError extends Error {}
/** Signals "try again with what we just fixed" (a refreshed token, a dropped connection). */
class RetryableStreamError extends Error {}

function stamp(message: string): string {
  return `${new Date().toLocaleTimeString()}  ${message}`;
}

/**
 * Subscribe to a run's live progress.
 *
 * Uses `@microsoft/fetch-event-source` rather than native `EventSource` for one reason: it can set
 * an `Authorization` header, so the stream authenticates exactly like every other request instead
 * of needing a second token mechanism.
 *
 * Lifecycle: one AbortController per runId. It is aborted on unmount, when runId changes, and as
 * soon as a terminal stage arrives — so navigating away mid-encode leaves no open connection and
 * no timer running on the server.
 */
export function useRunStream(runId: string | null, onTerminal?: () => void): RunStreamState {
  const [state, setState] = useState<RunStreamState>(initialState);

  // Held in a ref so a caller passing an inline arrow function doesn't tear the stream down and
  // rebuild it on every render.
  const onTerminalRef = useRef(onTerminal);
  useEffect(() => {
    onTerminalRef.current = onTerminal;
  }, [onTerminal]);

  useEffect(() => {
    if (!runId) {
      setState(initialState);
      return;
    }

    setState(initialState);

    const controller = new AbortController();
    let disposed = false;
    let done = false;
    let failures = 0;
    let lastMessage: string | null = null;

    /** Drops any update that arrives after unmount. */
    const update = (fn: (prev: RunStreamState) => RunStreamState) => {
      if (!disposed) setState(fn);
    };

    void fetchEventSource(`/api/runs/${runId}/events`, {
      signal: controller.signal,
      // Keep streaming in a background tab: an encode that finishes while the user is elsewhere
      // should still land in the UI (and still close its connection) rather than stalling.
      openWhenHidden: true,

      // The header is built per attempt, not once — so a reconnect after a silent refresh carries
      // the NEW access token rather than replaying the expired one.
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        for (const [key, value] of Object.entries(authHeader())) headers.set(key, value);
        return window.fetch(input, { ...init, headers });
      },

      async onopen(response) {
        const contentType = response.headers.get("content-type") ?? "";
        if (response.ok && contentType.startsWith(EventStreamContentType)) {
          failures = 0;
          update((prev) => ({ ...prev, connected: true, error: null }));
          return;
        }

        if (response.status === 401) {
          // Same shared refresh the fetch wrapper uses, so a stream and a query that expire
          // together still only trigger one refresh.
          const refreshed = await refreshAccessToken();
          if (!refreshed) {
            signalAuthFailure();
            throw new FatalStreamError("Session expired");
          }
          throw new RetryableStreamError("Token refreshed, reconnecting");
        }

        throw new FatalStreamError(`Couldn't open the progress stream (HTTP ${response.status})`);
      },

      onmessage(message) {
        if (!message.data) return;

        let event: RunEvent;
        try {
          event = JSON.parse(message.data) as RunEvent;
        } catch {
          return; // ignore a malformed frame rather than killing the stream
        }

        const terminal = isTerminalStage(event.stage);
        if (terminal) done = true;

        const isNewLine = event.message !== lastMessage;
        if (isNewLine) lastMessage = event.message;

        update((prev) => ({
          stage: event.stage,
          progressPct: event.progressPct,
          log: isNewLine ? [...prev.log, stamp(event.message)] : prev.log,
          error: event.error ?? prev.error,
          connected: !terminal,
          done: terminal,
        }));

        if (terminal) {
          onTerminalRef.current?.();
          // Nothing more is coming; close from our side rather than waiting on the server.
          controller.abort();
        }
      },

      onclose() {
        // The server closes when the run ends. Any other close is a transient drop — throwing
        // routes it into onerror, which reconnects; the run resumes correctly because progress is
        // derived from elapsed time, not from what we've already received.
        if (!done) throw new RetryableStreamError("Stream closed before the run finished");
      },

      onerror(err) {
        if (err instanceof FatalStreamError) throw err; // stop retrying

        failures += 1;
        update((prev) => ({ ...prev, connected: false }));

        if (failures > MAX_RETRIES) {
          throw new FatalStreamError("Lost connection to the progress stream");
        }
        return RETRY_MS;
      },
    }).catch((err: unknown) => {
      update((prev) => ({
        ...prev,
        connected: false,
        // A run that failed server-side already set `error`; don't overwrite it with transport noise.
        error: prev.error ?? (err instanceof Error ? err.message : "Progress stream error"),
      }));
    });

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [runId]);

  return state;
}
