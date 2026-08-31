import type { EncodeResult } from "@/lib/types";

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** What the encode produced. Server-derived — the stream never carries this. */
export function ResultsTable({ result }: { result: EncodeResult }) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-neutral-700">Output</h2>
        <p className="text-xs text-neutral-500">
          Duration {formatDuration(result.durationSec)} · {result.renditions.length} renditions
        </p>
      </div>

      <table className="w-full border-collapse overflow-hidden rounded-md border border-neutral-200 text-sm">
        <thead className="bg-neutral-100 text-left text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">
              Rendition
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Resolution
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              Size
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200">
          {result.renditions.map((rendition) => (
            <tr key={rendition.label}>
              <td className="px-4 py-2 font-medium">{rendition.label}</td>
              <td className="px-4 py-2 text-neutral-600">
                {rendition.width}×{rendition.height}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-neutral-600">
                {rendition.sizeMb.toFixed(1)} MB
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {result.warnings.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-amber-800">
            Warnings
          </h3>
          <ul className="list-inside list-disc space-y-1 text-xs text-amber-900">
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
