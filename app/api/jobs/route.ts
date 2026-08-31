import { createJobSchema } from "@/lib/schemas";
import { handle, json, parseBody, requireUser } from "@/lib/server/http";
import { createJob, listJobs } from "@/lib/server/store";

export async function GET(req: Request) {
  return handle(() => {
    requireUser(req);
    return json(listJobs());
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    requireUser(req);
    const input = await parseBody(req, createJobSchema);

    // `title` comes through as "" when the optional field is left blank; normalise it away so the
    // store falls back to deriving a title from the URL.
    const job = createJob({ sourceUrl: input.sourceUrl, title: input.title || undefined });
    return json(job, 201);
  });
}
