"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { ProgressBar } from "@/components/progress-bar";
import { ResultsTable } from "@/components/results-table";
import { RunLog } from "@/components/run-log";
import { StatusBadge } from "@/components/status-badge";
import { jobKeys, runKeys, useJob, useRun, useStartRun } from "@/lib/client/hooks";
import { useRunStream } from "@/lib/client/use-run-stream";
import { isTerminalStage, type Stage } from "@/lib/types";

export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const queryClient = useQueryClient();

  const jobQuery = useJob(id);
  const job = jobQuery.data;

  // A run started in this session wins over the job's cached latestRunId, so a retry switches the
  // stream across immediately instead of waiting for the job query to refetch.
  const [startedRunId, setStartedRunId] = useState<string | null>(null);
  useEffect(() => {
    setStartedRunId(null);
  }, [id]);

  const runId = startedRunId ?? job?.latestRunId ?? null;

  // The stream tells us *when* the run ended; the server is still the authority on what it
  // produced, so a terminal event refetches the run (for the result) and the job (for its status).
  const onTerminal = useCallback(() => {
    if (runId) void queryClient.invalidateQueries({ queryKey: runKeys.detail(runId) });
    void queryClient.invalidateQueries({ queryKey: jobKeys.detail(id) });
    void queryClient.invalidateQueries({ queryKey: jobKeys.all });
  }, [queryClient, runId, id]);

  const stream = useRunStream(runId, onTerminal);
  const runQuery = useRun(runId);
  const startRun = useStartRun(id);

  // Every hook is above this line: the early returns below must not change the hook order.
  if (jobQuery.isLoading) return <p className="text-sm text-neutral-500">Loading job…</p>;
  if (jobQuery.isError || !job) {
    return (
      <div className="text-sm text-red-600">
        Job not found.{" "}
        <Link href="/jobs" className="underline">
          Back to jobs
        </Link>
      </div>
    );
  }

  // Prefer the live stream, fall back to the fetched run — which is what renders when you open a
  // job whose encode finished before you got here.
  const stage: Stage | null = stream.stage ?? runQuery.data?.stage ?? null;
  const progressPct = stream.stage !== null ? stream.progressPct : (runQuery.data?.progressPct ?? 0);

  const failed = stage === "FAILED";
  const completed = stage === "COMPLETED";
  const running = stage !== null && !isTerminalStage(stage);

  const runError = failed ? (runQuery.data?.error ?? stream.error ?? "The encode failed.") : null;
  // A transport problem is a different thing from a failed encode; don't dress one as the other.
  const connectionError = !failed && stream.error ? stream.error : null;
  const result = runQuery.data?.stage === "COMPLETED" ? runQuery.data.result : undefined;

  const startLabel = !runId ? "Start encode" : failed ? "Retry encode" : "Run again";

  return (
    <div className="space-y-6">
      <Link href="/jobs" className="text-sm text-neutral-500 hover:underline">
        ← All jobs
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">{job.title}</h1>
          <p className="truncate text-sm text-neutral-500">{job.sourceUrl}</p>
        </div>
        <StatusBadge value={job.status} />
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={() =>
            startRun.mutate(undefined, {
              onSuccess: ({ runId: started }) => setStartedRunId(started),
            })
          }
          disabled={running || startRun.isPending}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {running ? "Encoding…" : startRun.isPending ? "Starting…" : startLabel}
        </button>

        {runId && (
          <span className="font-mono text-xs text-neutral-400" title="Run id">
            {runId}
          </span>
        )}

        {stream.connected && (
          <span className="flex items-center gap-1.5 text-xs text-neutral-500">
            <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" aria-hidden />
            live
          </span>
        )}
      </div>

      {startRun.isError && (
        <p role="alert" className="text-sm text-red-600">
          {startRun.error instanceof Error ? startRun.error.message : "Couldn’t start the run"}
        </p>
      )}

      {runId && (
        <section className="space-y-4 rounded-md border border-neutral-200 p-4">
          <div className="flex items-center justify-between gap-3">
            <StatusBadge value={stage ?? "QUEUED"} />
            <span className="text-sm tabular-nums text-neutral-600">{progressPct}%</span>
          </div>

          <ProgressBar value={completed ? 100 : progressPct} failed={failed} />

          {runError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3">
              <p className="text-sm font-medium text-red-800">Encode failed</p>
              <p className="mt-1 text-sm text-red-700">{runError}</p>
              <p className="mt-2 text-xs text-red-600">
                Use “Retry encode” above to start a fresh run for this job.
              </p>
            </div>
          )}

          {connectionError && (
            <p role="status" className="text-xs text-amber-700">
              {connectionError}
            </p>
          )}

          <RunLog lines={stream.log} />

          {completed && result && <ResultsTable result={result} />}
          {completed && !result && (
            <p className="text-sm text-neutral-500">Loading results…</p>
          )}
        </section>
      )}

      {!runId && (
        <p className="rounded-md border border-dashed border-neutral-300 p-4 text-sm text-neutral-500">
          This job hasn’t been encoded yet. Start a run to watch its progress live.
        </p>
      )}
    </div>
  );
}
