import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetStore,
  computeRun,
  createJob,
  getJob,
  RUN_DURATION_MS,
  startRun,
  type RunRecord,
} from "@/lib/server/store";
import { FAIL_URL, isTerminalStage, type Stage } from "@/lib/types";

// The run state machine is the piece most likely to be wrong in a way nothing else catches, and
// it's pure, so it can be tested exhaustively with a fake clock instead of 30s of real waiting.

const T0 = 1_700_000_000_000;
const HEALTHY_URL = "https://cdn.example.com/videos/clip.mp4";

function startRunAt(sourceUrl: string): RunRecord {
  const job = createJob({ sourceUrl });
  const record = startRun(job.id, T0);
  if (!record) throw new Error("expected startRun to return a record");
  return record;
}

beforeEach(() => {
  __resetStore();
});

describe("computeRun", () => {
  it("walks the stages in order, on the documented boundaries", () => {
    const record = startRunAt(HEALTHY_URL);

    const expected: [elapsed: number, stage: Stage][] = [
      [0, "QUEUED"],
      [1_999, "QUEUED"],
      [2_000, "DOWNLOADING"],
      [8_999, "DOWNLOADING"],
      [9_000, "PROBING"],
      [12_999, "PROBING"],
      [13_000, "TRANSCODING"],
      [24_999, "TRANSCODING"],
      [25_000, "PACKAGING"],
      [29_999, "PACKAGING"],
      [30_000, "COMPLETED"],
    ];

    for (const [elapsed, stage] of expected) {
      expect(computeRun(record, T0 + elapsed).stage, `at +${elapsed}ms`).toBe(stage);
    }
  });

  it("reports progress that only ever moves forward, and hits 100 only on COMPLETED", () => {
    const record = startRunAt(HEALTHY_URL);
    let previous = -1;

    for (let elapsed = 0; elapsed <= RUN_DURATION_MS; elapsed += 250) {
      const run = computeRun(record, T0 + elapsed);
      expect(run.progressPct, `at +${elapsed}ms`).toBeGreaterThanOrEqual(previous);
      previous = run.progressPct;

      if (run.stage !== "COMPLETED") {
        // A 100% bar next to a still-running stage is the classic progress-UI lie.
        expect(run.progressPct, `at +${elapsed}ms`).toBeLessThan(100);
      }
    }

    expect(computeRun(record, T0 + RUN_DURATION_MS).progressPct).toBe(100);
  });

  it("clamps a clock that runs backwards to the start of the run", () => {
    const record = startRunAt(HEALTHY_URL);
    expect(computeRun(record, T0 - 5_000).stage).toBe("QUEUED");
    expect(computeRun(record, T0 - 5_000).progressPct).toBe(0);
  });

  it("fails the corrupt source part-way through TRANSCODING, and stays failed", () => {
    const record = startRunAt(FAIL_URL);

    expect(computeRun(record, T0 + 14_999).stage).toBe("TRANSCODING");

    const failed = computeRun(record, T0 + 15_000);
    expect(failed.stage).toBe("FAILED");
    expect(failed.error).toMatch(/corrupt/i);
    expect(failed.result).toBeUndefined();

    // Long past the point a healthy run would have completed, it must not "recover".
    const later = computeRun(record, T0 + 10 * RUN_DURATION_MS);
    expect(later.stage).toBe("FAILED");
    expect(later.progressPct).toBe(failed.progressPct);
  });

  it("produces a result on COMPLETED that doesn't change between reads", () => {
    const record = startRunAt(HEALTHY_URL);

    const first = computeRun(record, T0 + RUN_DURATION_MS);
    const second = computeRun(record, T0 + RUN_DURATION_MS + 60_000);

    expect(first.result).toBeDefined();
    expect(first.result?.renditions).toHaveLength(3);
    expect(first.result?.durationSec).toBeGreaterThan(0);
    // A refetch of a finished run must not re-roll the numbers under the results table.
    expect(second.result).toEqual(first.result);
  });

  it("only ever reports a stage the contract knows about", () => {
    const record = startRunAt(HEALTHY_URL);
    for (let elapsed = 0; elapsed <= RUN_DURATION_MS + 1_000; elapsed += 500) {
      const { stage } = computeRun(record, T0 + elapsed);
      const known = isTerminalStage(stage) || !isTerminalStage(stage);
      expect(known).toBe(true);
      expect(stage).toMatch(/^(QUEUED|DOWNLOADING|PROBING|TRANSCODING|PACKAGING|COMPLETED|FAILED)$/);
    }
  });
});

describe("job status", () => {
  it("is derived from the latest run rather than stored", () => {
    const job = createJob({ sourceUrl: HEALTHY_URL });
    expect(getJob(job.id, T0)?.status).toBe("NEW");

    startRun(job.id, T0);
    expect(getJob(job.id, T0 + 5_000)?.status).toBe("RUNNING");
    expect(getJob(job.id, T0 + RUN_DURATION_MS)?.status).toBe("COMPLETED");
  });

  it("reports FAILED for a job whose latest run failed", () => {
    const job = createJob({ sourceUrl: FAIL_URL });
    startRun(job.id, T0);
    expect(getJob(job.id, T0 + 20_000)?.status).toBe("FAILED");
  });
});

describe("startRun", () => {
  it("returns the in-flight run instead of forking a second encode", () => {
    const job = createJob({ sourceUrl: HEALTHY_URL });
    const first = startRun(job.id, T0);
    const again = startRun(job.id, T0 + 3_000);

    expect(again?.id).toBe(first?.id);
  });

  it("starts a fresh run once the previous one is terminal — that's Retry", () => {
    const job = createJob({ sourceUrl: FAIL_URL });
    const first = startRun(job.id, T0);
    const retry = startRun(job.id, T0 + 20_000);

    expect(retry?.id).not.toBe(first?.id);
    expect(getJob(job.id, T0 + 20_000)?.latestRunId).toBe(retry?.id);
  });

  it("returns null for a job that doesn't exist", () => {
    expect(startRun("j_nope", T0)).toBeNull();
  });
});
