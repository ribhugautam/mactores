/**
 * The fallback title for a job whose source URL came in without one.
 *
 * Shared rather than duplicated: the server uses it when creating a job, and the client uses it to
 * label the optimistic row it shows before the server answers. If the two disagreed, a created job
 * would visibly rename itself the moment the real response landed.
 */
export function deriveTitle(sourceUrl: string): string {
  try {
    const path = new URL(sourceUrl).pathname.replace(/\/+$/, "");
    const last = path.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : "Untitled encode";
  } catch {
    return "Untitled encode";
  }
}
