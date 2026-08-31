"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { CreateJobInput } from "@/lib/schemas";
import { deriveTitle } from "@/lib/title";
import type { EncodeRun, Job } from "@/lib/types";

export const jobKeys = {
  all: ["jobs"] as const,
  detail: (id: string) => ["jobs", id] as const,
};

export const runKeys = {
  detail: (id: string) => ["runs", id] as const,
};

/** Marks a row the server hasn't confirmed yet, so the UI can render it as pending. */
export const OPTIMISTIC_PREFIX = "optimistic_";

export function isOptimistic(job: Job): boolean {
  return job.id.startsWith(OPTIMISTIC_PREFIX);
}

export function useJobs() {
  return useQuery({
    queryKey: jobKeys.all,
    queryFn: ({ signal }) => api.get<Job[]>("/api/jobs", signal),
    // The SSE stream only covers the job you have open, so a run that finishes while the user sits
    // on the list would leave a stale RUNNING badge behind. Poll to close that gap — but only
    // while something is actually running, so an idle list makes no requests at all.
    refetchInterval: (query) =>
      query.state.data?.some((job) => job.status === "RUNNING") ? 2_000 : false,
  });
}

export function useJob(id: string) {
  return useQuery({
    queryKey: jobKeys.detail(id),
    queryFn: ({ signal }) => api.get<Job>(`/api/jobs/${id}`, signal),
  });
}

/**
 * Create a job, showing it in the list immediately and rolling back if the server refuses.
 *
 * The optimistic row is built from the same `deriveTitle` the server uses, so the confirmed row
 * doesn't visibly rename itself a moment later. `onSettled` invalidates either way: after a
 * success to pick up the real id, after a failure to make sure the rollback matches the server.
 */
export function useCreateJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateJobInput) => api.post<Job>("/api/jobs", input),

    onMutate: async (input) => {
      // Stop an in-flight list refetch from landing on top of the optimistic row.
      await queryClient.cancelQueries({ queryKey: jobKeys.all });
      const previous = queryClient.getQueryData<Job[]>(jobKeys.all);

      const sourceUrl = input.sourceUrl.trim();
      const optimistic: Job = {
        id: `${OPTIMISTIC_PREFIX}${Date.now()}`,
        title: input.title?.trim() || deriveTitle(sourceUrl),
        sourceUrl,
        status: "NEW",
        createdAt: new Date().toISOString(),
      };

      queryClient.setQueryData<Job[]>(jobKeys.all, (old) => [optimistic, ...(old ?? [])]);
      return { previous };
    },

    onError: (_err, _input, context) => {
      if (context?.previous) queryClient.setQueryData(jobKeys.all, context.previous);
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: jobKeys.all });
    },
  });
}

/** Start (or retry) a run for a job. The server returns the existing run if one is in flight. */
export function useStartRun(jobId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post<{ runId: string }>("/api/runs", { jobId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: jobKeys.detail(jobId) });
      void queryClient.invalidateQueries({ queryKey: jobKeys.all });
    },
  });
}

/**
 * A run's authoritative state, including the `result` the stream doesn't carry.
 *
 * The SSE stream drives the live UI; this is what the page reads once the stream reports a
 * terminal stage. `enabled` keeps it from firing for a job that has never run.
 */
export function useRun(runId: string | null) {
  return useQuery({
    queryKey: runKeys.detail(runId ?? ""),
    queryFn: ({ signal }) => api.get<EncodeRun>(`/api/runs/${runId}`, signal),
    enabled: Boolean(runId),
  });
}
