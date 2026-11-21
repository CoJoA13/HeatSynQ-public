"use client";
import { useState } from "react";
import { api, UnreadableAnswerError } from "@/lib/fetcher";
import { BUTTON_PRIMARY_COMPACT } from "@/lib/ui-classes";

type Result = { created: number; errors: { row: number; message: string }[] };
/** What the panel shows: the server's answer, or a failure in its place. `created` is null when the
 *  import ran but its answer could not be read, so no count is shown (#547). */
type Shown = { created: number | null; errors: Result["errors"] };

export function PasteGrid(
  { endpoint, columns, onDone }: { endpoint: string; columns: string[]; onDone: () => void },
) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      setResult(await api<Result>(endpoint, {
        method: "POST", body: JSON.stringify({ text }),
      }));
      onDone();
    } catch (e) {
      // #547: a 2xx whose answer could not be read means the import ran, but how many rows it
      // created, and which it refused, were in that answer. Its sentence shows with no count, and
      // `onDone` runs as after a landed import, so the list shows the rows that were created (the
      // owner's answer of 2026-10-18 to the plan's question 5).
      if (e instanceof UnreadableAnswerError) {
        setResult({ created: null, errors: [{ row: 0, message: e.message }] });
        onDone();
        return;
      }
      setResult({ created: 0, errors: [{ row: 0, message: (e as Error).message }] });
    } finally { setBusy(false); }
  }

  return (
    <div className="mt-4 rounded border bg-surface-0 p-3">
      <p className="mb-2 text-sm">
        Paste from a spreadsheet. Columns, in order: <strong>{columns.join(" · ")}</strong>
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6}
                placeholder={`4010\tHeat Treat Revenue`}
                className="w-full rounded border p-2 font-mono text-xs" />
      <button onClick={submit} disabled={busy || !text.trim()}
              className={`${BUTTON_PRIMARY_COMPACT} mt-2`}>
        {busy ? "Importing…" : "Import rows"}
      </button>
      {result && (
        <div className="mt-3 text-sm">
          {result.created !== null && <p className="text-success-700">{result.created} row(s) created.</p>}
          {result.errors.length > 0 && (
            <ul className="mt-1 text-red-700">
              {result.errors.map((e) => (
                <li key={e.row}>{e.row ? `Row ${e.row}: ` : ""}{e.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
