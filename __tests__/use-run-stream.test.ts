import { act, renderHook } from "@testing-library/react";
import type { FetchEventSourceInit } from "@microsoft/fetch-event-source";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRunStream } from "@/lib/client/use-run-stream";
import type { RunEvent } from "@/lib/types";

// The brief's headline risk is leaked streams and zombie timers, so this drives the hook's
// lifecycle directly: the transport is mocked, and we assert on the AbortSignal it was handed.

vi.mock("@microsoft/fetch-event-source", () => ({
  EventStreamContentType: "text/event-stream",
  fetchEventSource: vi.fn(),
}));

const { fetchEventSource } = await import("@microsoft/fetch-event-source");
const mockedFetchEventSource = vi.mocked(fetchEventSource);

let options: FetchEventSourceInit;
let url: string;

function emit(event: Partial<RunEvent> & Pick<RunEvent, "stage">) {
  const payload: RunEvent = { progressPct: 0, message: "…", ...event };
  act(() => {
    options.onmessage?.({ id: "", event: "", data: JSON.stringify(payload), retry: undefined });
  });
}

beforeEach(() => {
  mockedFetchEventSource.mockReset();
  mockedFetchEventSource.mockImplementation((input, init) => {
    url = String(input);
    options = init ?? {};
    return new Promise(() => {}); // stays open until something aborts it
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useRunStream", () => {
  it("does not open a connection without a runId", () => {
    renderHook(() => useRunStream(null));
    expect(mockedFetchEventSource).not.toHaveBeenCalled();
  });

  it("subscribes to the run's event endpoint and tracks stage and progress", () => {
    const { result } = renderHook(() => useRunStream("r_1"));
    expect(url).toBe("/api/runs/r_1/events");

    emit({ stage: "DOWNLOADING", progressPct: 20, message: "Downloading source media…" });

    expect(result.current.stage).toBe("DOWNLOADING");
    expect(result.current.progressPct).toBe(20);
    expect(result.current.done).toBe(false);
  });

  it("appends a log line per distinct message, not per frame", () => {
    const { result } = renderHook(() => useRunStream("r_1"));

    emit({ stage: "TRANSCODING", progressPct: 50, message: "Transcoding 1080p…" });
    emit({ stage: "TRANSCODING", progressPct: 52, message: "Transcoding 1080p…" });
    emit({ stage: "TRANSCODING", progressPct: 60, message: "Transcoding 720p…" });

    // Three frames, two messages: the progress bar moves, the log doesn't stutter.
    expect(result.current.log).toHaveLength(2);
    expect(result.current.log[0]).toContain("Transcoding 1080p…");
    expect(result.current.log[1]).toContain("Transcoding 720p…");
    expect(result.current.progressPct).toBe(60);
  });

  it("closes the connection and notifies the caller on a terminal stage", () => {
    const onTerminal = vi.fn();
    const { result } = renderHook(() => useRunStream("r_1", onTerminal));

    emit({ stage: "PACKAGING", progressPct: 90, message: "Writing HLS manifests…" });
    expect(options.signal?.aborted).toBe(false);

    emit({ stage: "COMPLETED", progressPct: 100, message: "Encode complete" });

    expect(result.current.done).toBe(true);
    expect(result.current.connected).toBe(false);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    // Nothing further is coming — the stream must not be left open.
    expect(options.signal?.aborted).toBe(true);
  });

  it("surfaces a failed run's error", () => {
    const { result } = renderHook(() => useRunStream("r_1"));

    emit({
      stage: "FAILED",
      progressPct: 50,
      message: "Decode error",
      error: "moov atom not found",
    });

    expect(result.current.stage).toBe("FAILED");
    expect(result.current.error).toBe("moov atom not found");
    expect(result.current.done).toBe(true);
  });

  it("aborts the stream on unmount", () => {
    const { unmount } = renderHook(() => useRunStream("r_1"));
    const signal = options.signal;

    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("tears down the old stream and resets state when the runId changes", () => {
    const { result, rerender } = renderHook(({ id }: { id: string }) => useRunStream(id), {
      initialProps: { id: "r_1" },
    });

    emit({ stage: "TRANSCODING", progressPct: 60, message: "Transcoding 720p…" });
    const firstSignal = options.signal;

    rerender({ id: "r_2" });

    expect(firstSignal?.aborted).toBe(true);
    expect(url).toBe("/api/runs/r_2/events");
    // The previous run's progress must not bleed into the new one.
    expect(result.current.stage).toBeNull();
    expect(result.current.progressPct).toBe(0);
    expect(result.current.log).toEqual([]);
  });

  it("ignores a malformed frame instead of tearing the stream down", () => {
    const { result } = renderHook(() => useRunStream("r_1"));

    emit({ stage: "PROBING", progressPct: 30, message: "Probing container…" });
    act(() => {
      options.onmessage?.({ id: "", event: "", data: "{not json", retry: undefined });
    });

    expect(result.current.stage).toBe("PROBING");
    expect(result.current.log).toHaveLength(1);
    expect(options.signal?.aborted).toBe(false);
  });
});
