// The two shared load-state renders (P6 step 3; #634, #632 bug a). Client-safe.
//
// `PageStatus` is a detail page's pre-load branch: "Loading…" while its first read is out, and a
// failed read in the red the page's own banner uses once loaded, where it used to print as bare
// text in the look of "Loading…". It never carries `whitespace-pre-line`, so the E2E readers that
// find a page's refusal list by that class (`e2e/lib/refusal-lines.mjs`) never take it for one.
// Each page passes its own `??` chain as `error`, so which state owns the message is unchanged
// (CLAUDE.md "Initial page-load errors and action errors have separate owners").
//
// `ListStatus` draws a read-backed list's every state but its rows, from `listStatus`
// (src/lib/list-status.ts): the caller's denial and empty sentences, its error, and "Loading…"
// until a read for the list's key has landed, never the empty sentence before then.
import type { ReactNode } from "react";
import type { ListStatus as Status } from "@/lib/list-status";
import { NOTICE, TEXT_MUTED } from "@/lib/ui-classes";

export function PageStatus({ error, children }: { error?: string | null; children?: ReactNode }) {
  return (
    <div className="p-6">
      {error
        ? <p role="alert" className={NOTICE.refusal}>{error}</p>
        : <p className={TEXT_MUTED}>Loading…</p>}
      {children}
    </div>
  );
}

export function ListStatus({ status, denied, error, empty }: {
  status: Exclude<Status, "rows">;
  denied?: string | null;
  error?: string | null;
  empty: string;
}) {
  if (status === "denied") return <p className={TEXT_MUTED}>{denied}</p>;
  if (status === "error") return error ? <p className="text-sm text-red-700">{error}</p> : null;
  if (status === "loading") return <p className={TEXT_MUTED}>Loading…</p>;
  return <p className={TEXT_MUTED}>{empty}</p>;
}
