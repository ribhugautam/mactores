import { z } from "zod";

// Schemas are shared between client (React Hook Form resolver) and server (Route Handler validation),
// so the same rules apply in both places and field errors map cleanly back to the form.

/**
 * A syntactically valid http(s) media URL.
 *
 * Deliberately does NOT require a media file extension: real sources are routinely extensionless
 * (signed CDN URLs, `/assets/12345`, HLS manifests behind a redirect), so an extension allowlist
 * would reject valid input for no real safety gain. What we can check cheaply and correctly is the
 * shape: parseable, http(s), a real host, and an actual path rather than a bare origin.
 *
 * One `superRefine` with early returns rather than a chain of `.refine()` calls, so a bad value
 * produces exactly one message instead of a pile of them.
 */
export const sourceUrlSchema = z
  .string()
  .trim()
  .min(1, "Source URL is required")
  .superRefine((value, ctx) => {
    if (value.length === 0) return; // already reported by .min(1)

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Enter a full URL, e.g. https://cdn.example.com/video.mp4" });
      return;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ctx.addIssue({ code: "custom", message: "Only http:// and https:// sources are supported" });
      return;
    }

    if (!url.hostname) {
      ctx.addIssue({ code: "custom", message: "The URL is missing a host" });
      return;
    }

    const path = url.pathname.replace(/\/+$/, "");
    if (path.length === 0) {
      ctx.addIssue({ code: "custom", message: "Point at a media file, not just a domain" });
    }
  });

export const createJobSchema = z.object({
  sourceUrl: sourceUrlSchema,
  title: z
    .string()
    .trim()
    .max(80, "Keep the title under 80 characters")
    .optional()
    .or(z.literal("")),
});
export type CreateJobInput = z.infer<typeof createJobSchema>;

export const loginSchema = z.object({
  email: z.string().min(1, "Email is required").email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const startRunSchema = z.object({
  jobId: z.string().min(1, "jobId is required"),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, "refreshToken is required"),
});
