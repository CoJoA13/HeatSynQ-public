"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ReferenceTable } from "@/components/ReferenceTable";
import { PICK_LIST_ORDER, REFERENCE_LABELS, pickListKind, type ReferenceKind } from "@/lib/reference-constants";
import { askDiscard } from "@/lib/use-unsaved-section";

/** `useSearchParams` suspends during prerender, and Next refuses to build a page that reads it
 *  outside a Suspense boundary: the `Close.tsx` precedent. */
export default function ReferencePage() {
  return <Suspense fallback={<div className="p-6">Loading…</div>}><PickLists /></Suspense>;
}

function PickLists() {
  // A link names its list in the query (#708): the Close screen's and the setup checklist's. The
  // query is read as it changes too, because a link in the setup banner can be followed from this
  // page, which stays mounted. A query that names no list leaves the screen as it is.
  const linked = pickListKind(useSearchParams().get("kind"));
  const [kind, setKind] = useState<ReferenceKind>(linked ?? "containerType");
  useEffect(() => { if (linked) setKind(linked); }, [linked]);
  // The selector is drawn inside the table's keyed body, so choosing a list remounts it and the
  // chosen button: the cursor goes back to the new one, or a keyboard user lands on the page itself.
  const listRef = useRef<HTMLUListElement>(null);
  const chosen = useRef(false);
  useEffect(() => {
    if (!chosen.current) return;
    chosen.current = false;
    listRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
  }, [kind]);
  // Choosing a list remounts the table, which drops a discount box waiting on its partner, and the
  // Shell's guard sees only links: this button asks for itself (Codex P2 on #864).
  async function choose(next: ReferenceKind) {
    if (next === kind) return;
    // Choosing a list leaves no page, so it names its own loss (owner answer 2026-11-04).
    if (!(await askDiscard({ action: "Choose another list and discard them?" }))) return;
    chosen.current = true;
    setKind(next);
  }
  return (
    <ReferenceTable key={kind} kind={kind} selector={<>
        {/* L4c (#239): the list column no longer stretches to the detail table's height. A flex
            row's default `align-items: stretch` made this `<ul>` as tall as whatever pick list
            was selected, so its border ran on for ~75px of empty white below the last kind — a
            box drawn around nothing. The width is the one this batch gave all five columns
            (S2c). Neither class is named in this comment: tests/admin-screens.test.tsx pins
            both by reading this file, and a comment that quotes them satisfies the pin without
            the markup doing anything (the board-search-scan precedent, found by mutation). */}
        <ul ref={listRef} className="w-72 shrink-0 self-start divide-y rounded border bg-surface-0 text-sm">
          {PICK_LIST_ORDER.map((k) => (
            <li key={k} className={k === kind ? "bg-link-50 font-medium" : ""}>
              <button type="button" onClick={() => void choose(k)}
                      aria-current={k === kind ? "true" : undefined}
                      className={`w-full cursor-pointer px-3 py-2 text-left ${k === kind ? "" : "hover:bg-surface-50"}`}>
                {REFERENCE_LABELS[k].plural}
              </button>
            </li>
          ))}
        </ul>
    </>} />
  );
}
