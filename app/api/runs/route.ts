import { startRunSchema } from "@/lib/schemas";
import { error, handle, json, parseBody, requireUser } from "@/lib/server/http";
import { startRun } from "@/lib/server/store";

export async function POST(req: Request) {
  return handle(async () => {
    requireUser(req);
    const { jobId } = await parseBody(req, startRunSchema);

    const record = startRun(jobId);
    if (!record) return error(404, "Job not found");

    // startRun is idempotent while a run is in flight, so a double submit returns the same runId
    // rather than forking the job into two encodes.
    return json({ runId: record.id }, 201);
  });
}
