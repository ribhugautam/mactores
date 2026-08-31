"use client";

import Link from "next/link";
import { JobForm } from "@/components/job-form";
import { StatusBadge } from "@/components/status-badge";
import { isOptimistic, useJobs } from "@/lib/client/hooks";

export default function JobsPage() {
  const jobs = useJobs();

  return (
    <div className="space-y-8">
      <section>
        <h1 className="mb-4 text-xl font-semibold">New encode job</h1>
        <JobForm />
      </section>

      <section>
        <h2 className="mb-4 text-xl font-semibold">Jobs</h2>

        {jobs.isLoading && <p className="text-sm text-neutral-500">Loading jobs…</p>}

        {jobs.isError && (
          <div className="text-sm text-red-600">
            Couldn’t load jobs.{" "}
            <button onClick={() => jobs.refetch()} className="underline">
              Retry
            </button>
          </div>
        )}

        {jobs.data?.length === 0 && <p className="text-sm text-neutral-500">No jobs yet.</p>}

        {jobs.data && jobs.data.length > 0 && (
          <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {jobs.data.map((job) =>
              isOptimistic(job) ? (
                // Shown immediately on create, before the server has given it an id. Not a link:
                // there is nothing at /jobs/optimistic_… yet.
                <li
                  key={job.id}
                  className="flex items-center justify-between gap-3 px-4 py-3 opacity-60"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{job.title}</p>
                    <p className="truncate text-xs text-neutral-500">{job.sourceUrl}</p>
                  </div>
                  <span className="text-xs text-neutral-500">Creating…</span>
                </li>
              ) : (
                <li key={job.id}>
                  <Link
                    href={`/jobs/${job.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-neutral-50"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{job.title}</p>
                      <p className="truncate text-xs text-neutral-500">{job.sourceUrl}</p>
                    </div>
                    <StatusBadge value={job.status} />
                  </Link>
                </li>
              ),
            )}
          </ul>
        )}
      </section>
    </div>
  );
}
