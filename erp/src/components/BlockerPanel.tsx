// Shared "why can't I delete this" panel. First lived only in ReferenceTable.tsx; part-fields
// (Task 13) is the second screen needing the identical shape (linked blocker rows + an Excel
// export link), which is the brief's stated ceiling for extracting rather than copying a second
// time — see CLAUDE.md's "blocked deletes need discoverable blockers" note. A refused delete is
// not a dead end: this says plainly what is using the row, links to each one, and offers an
// export instead of leaving the admin to guess (the Visual Shop trap this app is escaping).
// `model` mirrors src/server/reference-blockers.ts's own Blocker type (kept as a separate literal
// here rather than imported, same as always — client components must not import src/server/**).
// Optional: only rows produced by `findBlockers` carry it (the registry entry's own Prisma model
// identity, e.g. "customerSurcharge" — genuine identity, not a rendered string, which is what
// lets a caller discriminate reliably; see that file's comment for why `entityLabel`/`label`
// alone cannot). admin/surcharges/page.tsx's "Clear override" button is the first consumer (fix
// wave 1, Fix 3 review; this field was `label` in that wave — fix wave 2 review found that
// discriminator to be a tautology and replaced it with this one).
import { NOTICE } from "@/lib/ui-classes";
export type Blocker = { entityLabel: string; name: string; id: string; href: string | null; model?: string };

export function BlockerPanel({
  label, rowName, list, exportHref, onDismiss, action = "delete", note,
}: {
  /** Lowercase singular noun for the row being blocked, e.g. "material" or "part field". */
  label: string;
  rowName: string;
  list: Blocker[];
  exportHref: string;
  onDismiss: () => void;
  /** Present-tense verb phrase for the blocked action, e.g. "delete" or "change the type of".
   *  Defaults to "delete" — the panel's original and still most common caller. */
  action?: string;
  /** Optional guidance for callers where the block may be permanent. Naming what is blocking is
   *  only most of the job: if no action the user can take will ever clear the block, saying so —
   *  and saying what to do instead — is the difference between a guard and the Visual Shop dead
   *  end this whole mechanism exists to avoid. */
  note?: string;
}) {
  return (
    <div className={`${NOTICE.warning} mt-4`}>
      <div className="mb-2 font-medium">
        Cannot {action} {label} “{rowName}” — {list.length} record(s) use it:
      </div>
      <ul className="mb-2 space-y-1">
        {list.map((b) => (
          <li key={`${b.entityLabel}-${b.id}`}>
            <span className="text-ink-500">{b.entityLabel}</span>{" "}
            {b.href ? <a href={b.href} data-navigation="document" className="text-link-700 underline">{b.name}</a> : <span>{b.name}</span>}
          </li>
        ))}
      </ul>
      {note && <p className="mb-2 text-ink-800">{note}</p>}
      <div className="flex gap-3">
        <a href={exportHref} className="text-link-700 underline">Export list to Excel</a>
        <button onClick={onDismiss} className="text-ink-500">dismiss</button>
      </div>
    </div>
  );
}
