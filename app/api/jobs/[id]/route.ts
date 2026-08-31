import { error, handle, json, requireUser } from "@/lib/server/http";
import { getJob } from "@/lib/server/store";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    requireUser(req);
    const { id } = await ctx.params;

    const job = getJob(id);
    if (!job) return error(404, "Job not found");

    return json(job);
  });
}
