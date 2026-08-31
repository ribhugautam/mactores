import { randomUUID } from "node:crypto";
import { deriveTitle } from "@/lib/title";
import {
  FAIL_URL,
  isTerminalStage,
  type ActiveStage,
  type EncodeResult,
  type EncodeRun,
  type Job,
  type JobStatus,
  type Rendition,
  type RunEvent,
} from "@/lib/types";

// In-memory store. A single Node process in `next dev`, so module-level Maps are fine.

const jobs = new Map<string, Job>();
const runs = new Map<string, RunRecord>();

interface RunRecord {
  id: string;
  jobId: string;
  sourceUrl: string;
  startedAt: number; // epoch ms
}

/** Re-exported so server code has one obvious import for it. Defined in the shared contract. */
export { FAIL_URL };

// --- the encode run state machine ---
//
// A run is a *pure function of elapsed time*. Nothing is mutated as it advances and no timer owns
// its state, which buys three things: `GET /api/runs/:id` and the SSE stream can never disagree; a
// client that reconnects mid-run resumes at the right place with no server-side session; and the
// whole machine is unit-testable by passing a fake `now`.

interface StageWindow {
  stage: ActiveStage;
  durationMs: number;
  /** Spread evenly across the window, so a long stage still produces a moving log. */
  messages: readonly [string, ...string[]];
}

const TIMELINE: readonly StageWindow[] = [
  { stage: "QUEUED", durationMs: 2_000, messages: ["Queued — waiting for an encoder slot"] },
  {
    stage: "DOWNLOADING",
    durationMs: 7_000,
    messages: ["Connecting to source…", "Downloading source media…", "Source download complete"],
  },
  {
    stage: "PROBING",
    durationMs: 4_000,
    messages: ["Probing container…", "Detected video: h264 · audio: aac"],
  },
  {
    stage: "TRANSCODING",
    durationMs: 12_000,
    messages: ["Transcoding 1080p…", "Transcoding 720p…", "Transcoding 480p…"],
  },
  {
    stage: "PACKAGING",
    durationMs: 5_000,
    messages: ["Muxing MP4 outputs…", "Writing HLS manifests…"],
  },
];

/** ~30s end to end, inside the 20-40s the brief asks for. */
export const RUN_DURATION_MS = TIMELINE.reduce((total, w) => total + w.durationMs, 0);

/** Chosen to land inside TRANSCODING, so the failure interrupts real work rather than the queue. */
const FAIL_AT_MS = 15_000;

const FAIL_MESSAGE = "Decode error at 00:00:07 — moov atom not found, the source stream is corrupt";

/** A run's state and the log line that goes with it. One computation, two typed views. */
interface RunState {
  run: EncodeRun;
  message: string;
}

function computeState(record: RunRecord, now: number): RunState {
  const elapsed = Math.max(0, now - record.startedAt);
  const willFail = record.sourceUrl === FAIL_URL;

  if (willFail && elapsed >= FAIL_AT_MS) {
    return {
      run: {
        id: record.id,
        jobId: record.jobId,
        stage: "FAILED",
        progressPct: percentAt(FAIL_AT_MS),
        error: FAIL_MESSAGE,
      },
      message: FAIL_MESSAGE,
    };
  }

  if (elapsed >= RUN_DURATION_MS) {
    return {
      run: {
        id: record.id,
        jobId: record.jobId,
        stage: "COMPLETED",
        progressPct: 100,
        result: buildResult(record),
      },
      message: "Encode complete",
    };
  }

  const { window, elapsedInWindow } = windowAt(elapsed);
  const windowProgress = elapsedInWindow / window.durationMs;
  const messageIndex = Math.min(
    window.messages.length - 1,
    Math.floor(windowProgress * window.messages.length),
  );

  return {
    run: {
      id: record.id,
      jobId: record.jobId,
      stage: window.stage,
      progressPct: percentAt(elapsed),
    },
    message: window.messages[messageIndex] ?? window.messages[0],
  };
}

/** Which stage window `elapsed` falls in. Only called for elapsed < RUN_DURATION_MS. */
function windowAt(elapsed: number): { window: StageWindow; elapsedInWindow: number } {
  let cursor = 0;
  for (const window of TIMELINE) {
    if (elapsed < cursor + window.durationMs) {
      return { window, elapsedInWindow: elapsed - cursor };
    }
    cursor += window.durationMs;
  }
  // Unreachable given the guard in computeState, but the fallback keeps this total, not partial.
  const last = TIMELINE[TIMELINE.length - 1] as StageWindow;
  return { window: last, elapsedInWindow: last.durationMs - 1 };
}

/** Overall progress across the whole run. Capped at 99 so only COMPLETED ever reads 100. */
function percentAt(elapsed: number): number {
  return Math.min(99, Math.max(0, Math.round((elapsed / RUN_DURATION_MS) * 100)));
}

/** Compute a run's current state. Pure: the same record and `now` always give the same answer. */
export function computeRun(record: RunRecord, now: number = Date.now()): EncodeRun {
  return computeState(record, now).run;
}

/** The same computation, shaped as the payload the SSE stream pushes. */
export function computeRunEvent(record: RunRecord, now: number = Date.now()): RunEvent {
  const { run, message } = computeState(record, now);
  return {
    stage: run.stage,
    progressPct: run.progressPct,
    message,
    ...(run.error ? { error: run.error } : {}),
  };
}

// --- results ---
//
// Derived deterministically from the source URL so repeated reads of a completed run agree with
// each other. A Math.random() here would make the results table flicker on every refetch.

function buildResult(record: RunRecord): EncodeResult {
  const seed = hash32(record.sourceUrl);
  const durationSec = 90 + (seed % 511);

  const renditions: Rendition[] = [
    { label: "1080p", width: 1920, height: 1080, sizeMb: sizeMb(5_000, durationSec) },
    { label: "720p", width: 1280, height: 720, sizeMb: sizeMb(2_800, durationSec) },
    { label: "480p", width: 854, height: 480, sizeMb: sizeMb(1_400, durationSec) },
  ];

  const warnings: string[] = [];
  if (!/\.[a-z0-9]{2,4}$/i.test(safePathname(record.sourceUrl))) {
    warnings.push("Source had no file extension; container was detected from the first bytes.");
  }
  if (seed % 3 === 0) {
    warnings.push("Audio track was mono; upmixed to stereo for the 1080p rendition.");
  }

  return { durationSec, renditions, warnings };
}

function sizeMb(bitrateKbps: number, durationSec: number): number {
  return Math.round(((bitrateKbps * durationSec) / 8 / 1024) * 10) / 10;
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/** FNV-1a. Not cryptographic — just a stable seed so fake results look plausible and hold still. */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// --- job/run CRUD ---

/**
 * A job's status is *derived* from its latest run rather than stored alongside it. Two copies of
 * the same fact eventually disagree — a job stuck on RUNNING after its run failed is exactly the
 * impossible state the brief asks us to design out.
 */
function withDerivedStatus(job: Job, now: number): Job {
  return { ...job, status: deriveStatus(job, now) };
}

function deriveStatus(job: Job, now: number): JobStatus {
  if (!job.latestRunId) return "NEW";
  const record = runs.get(job.latestRunId);
  if (!record) return "NEW";
  const stage = computeRun(record, now).stage;
  if (stage === "COMPLETED") return "COMPLETED";
  if (stage === "FAILED") return "FAILED";
  return "RUNNING";
}

export function listJobs(now: number = Date.now()): Job[] {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((job) => withDerivedStatus(job, now));
}

export function getJob(id: string, now: number = Date.now()): Job | null {
  const job = jobs.get(id);
  return job ? withDerivedStatus(job, now) : null;
}

export function createJob(input: { sourceUrl: string; title?: string }): Job {
  const id = `j_${randomUUID().slice(0, 8)}`;
  const sourceUrl = input.sourceUrl.trim();
  const job: Job = {
    id,
    title: input.title?.trim() || deriveTitle(sourceUrl),
    sourceUrl,
    status: "NEW",
    createdAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  return job;
}

/**
 * Start a run for a job.
 *
 * If the job's latest run is still in flight this returns that run instead of starting a second
 * one, so a double-clicked "Start encode" cannot fork the job into two concurrent encodes. Once a
 * run reaches a terminal stage a fresh one is created — that is what "Retry" does.
 */
export function startRun(jobId: string, now: number = Date.now()): RunRecord | null {
  const job = jobs.get(jobId);
  if (!job) return null;

  const existing = job.latestRunId ? runs.get(job.latestRunId) : undefined;
  if (existing && !isTerminalStage(computeRun(existing, now).stage)) {
    return existing;
  }

  const record: RunRecord = {
    id: `r_${randomUUID().slice(0, 8)}`,
    jobId,
    sourceUrl: job.sourceUrl,
    startedAt: now,
  };
  runs.set(record.id, record);
  job.latestRunId = record.id;
  return record;
}

export function getRunRecord(id: string): RunRecord | null {
  return runs.get(id) ?? null;
}

export function getRun(id: string, now: number = Date.now()): EncodeRun | null {
  const record = runs.get(id);
  return record ? computeRun(record, now) : null;
}

/** Test-only: the module-level Maps outlive a single test file otherwise. */
export function __resetStore(): void {
  jobs.clear();
  runs.clear();
}

export type { RunRecord };
