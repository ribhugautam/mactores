"use client";

import { useEffect, useRef } from "react";

/** The streaming log. Pinned to the newest line so a running encode reads top-down without fiddling. */
export function RunLog({ lines }: { lines: string[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [lines.length]);

  return (
    <div>
      <h2 className="mb-2 text-sm font-medium text-neutral-700">Log</h2>
      <div
        role="log"
        aria-live="polite"
        aria-label="Encode log"
        className="h-40 overflow-y-auto rounded-md border border-neutral-200 bg-neutral-900 p-3 font-mono text-xs text-neutral-200"
      >
        {lines.length === 0 ? (
          <p className="text-neutral-500">Waiting for the encoder…</p>
        ) : (
          <ul className="space-y-1">
            {lines.map((line, index) => (
              // Lines are append-only and never reordered, so the index is a stable key here.
              <li key={index}>{line}</li>
            ))}
          </ul>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
