"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ApiError } from "@/lib/client/api";
import { useCreateJob } from "@/lib/client/hooks";
import { createJobSchema, type CreateJobInput } from "@/lib/schemas";
import { FAIL_URL } from "@/lib/types";

/** The form's own fields, so a server error for an unknown key can't be silently dropped. */
const FIELDS = ["sourceUrl", "title"] as const;
type FieldName = (typeof FIELDS)[number];

function isFieldName(name: string): name is FieldName {
  return (FIELDS as readonly string[]).includes(name);
}

export function JobForm() {
  const createJob = useCreateJob();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateJobInput>({
    resolver: zodResolver(createJobSchema),
    defaultValues: { sourceUrl: "", title: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await createJob.mutateAsync(values);
      reset();
    } catch (err) {
      // The server validates with the same Zod schema and returns per-field messages on a 422;
      // put them back on the fields they belong to instead of in a generic banner.
      if (err instanceof ApiError && err.fieldErrors) {
        let mapped = false;
        for (const [field, messages] of Object.entries(err.fieldErrors)) {
          const message = messages?.[0];
          if (!message) continue;
          if (isFieldName(field)) {
            setError(field, { type: "server", message });
            mapped = true;
          }
        }
        // A field error we have no input for still has to be visible somewhere.
        if (mapped) return;
      }
      setFormError(err instanceof Error ? err.message : "Couldn't create the job");
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div>
        <label htmlFor="sourceUrl" className="mb-1 block text-sm font-medium">
          Source URL
        </label>
        <input
          id="sourceUrl"
          {...register("sourceUrl")}
          placeholder="https://cdn.example.com/videos/clip.mp4"
          aria-invalid={errors.sourceUrl ? "true" : "false"}
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
        {errors.sourceUrl && (
          <p role="alert" className="mt-1 text-xs text-red-600">
            {errors.sourceUrl.message}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="title" className="mb-1 block text-sm font-medium">
          Title <span className="font-normal text-neutral-500">(optional)</span>
        </label>
        <input
          id="title"
          {...register("title")}
          placeholder="Derived from the URL if left blank"
          aria-invalid={errors.title ? "true" : "false"}
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
        {errors.title && (
          <p role="alert" className="mt-1 text-xs text-red-600">
            {errors.title.message}
          </p>
        )}
      </div>

      {formError && (
        <p role="alert" className="text-sm text-red-600">
          {formError}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isSubmitting}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isSubmitting ? "Creating…" : "Create job"}
        </button>
        <button
          type="button"
          onClick={() => setValue("sourceUrl", FAIL_URL, { shouldValidate: true })}
          className="text-xs text-neutral-500 underline hover:text-neutral-700"
        >
          Use the failing demo URL
        </button>
      </div>
    </form>
  );
}
