"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { optionsSelectTitle, type OptionsRead } from "@/lib/options-read";
import { CERT_SCOPES, CERT_SCOPE_LABELS } from "@/lib/cert-constants";
import type { EditGuard } from "@/lib/use-edit-guard";
import { decimalRefusal } from "@/lib/decimal-entry";
import { readWholeNumber, wholeNumberRefusal } from "@/lib/whole-number-entry";
import { LOAD_QTY, REQUEST_DAYS_OVERRIDE } from "@/lib/whole-number-boxes";
import { EACH_WEIGHT, LOAD_WEIGHT } from "@/lib/part-boxes";
import { EACH_WEIGHT_LB } from "@/lib/weight-terms";
import type { Part } from "./page";
import { SavedMark } from "@/components/SavedMark";
import { useSavedMarks } from "@/lib/use-saved-marks";
import { CARD, INPUT_COMPACT, LINK } from "@/lib/ui-classes";

type MaterialOption = { id: string; name: string; active: boolean };

export function IdentitySection({
  part, perms, save: saveField, patchDraft, editGuard, onError, onOptionsError,
}: {
  part: Part;
  perms: string[] | undefined;
  save: (patch: Record<string, unknown>) => Promise<boolean>;
  patchDraft: (patch: Partial<Part>) => void;
  editGuard: EditGuard;
  onError: (message: string | null) => void;
  onOptionsError: (message: string) => void;
}) {
  const [materials, setMaterials] = useState<MaterialOption[]>([]);
  // F9: a failed material-options fetch used to report through the shared `onError`, the same
  // state a later successful field save resets to null — so a save elsewhere on this page could
  // silently erase the warning while the Material select sat enabled with an empty options list
  // (the customers/[id]/page.tsx F4 precedent this mirrors). `onOptionsError` writes into the
  // page's own persistent `loadError` instead, which no section save clears, and `materialsRead`
  // below disables the select until the fetch actually succeeds so a stale/blank assignment can't
  // be clobbered by a "successful" interaction with an empty list.
  //
  // includeInactive=1: the assigned material (part.materialId) may since have been marked
  // inactive by an admin — the R3 pattern from customers/[id]/page.tsx's Terms/Parent selects.
  // Without it, a controlled <select> whose value matches no <option> silently falls back to the
  // blank choice, misrepresenting stored data and risking clobbering a real material on the next
  // interaction.
  const [materialsRead, setMaterialsRead] = useState<OptionsRead>("loading");
  useEffect(() => {
    api<MaterialOption[]>("/api/picklists/material?includeInactive=1").then((data) => {
      setMaterials(data);
      setMaterialsRead("ready");
    }).catch((e) => { setMaterialsRead("failed"); onOptionsError((e as Error).message); });
  }, [onOptionsError]);

  const canEdit = gate(perms, "parts.edit");

  // Blur-save guard, now the page-level editGuard (use-edit-guard.ts — the customers/[id]/
  // page.tsx noteFocusC shape): the no-op half is unchanged (only fields the user actually
  // changed reach the network), and registering WHICH Part property is under the cursor is what
  // lets the page's reload merge preserve the field mid-typing when a sibling save's §5.13
  // rollback (or any other reload) lands.
  const noteFocus = (key: keyof Part & string) => editGuard.onFocusField(key);
  function onBlurSave(
    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
    opts: { trim?: boolean },
    commit: (value: string, atFocus: string) => void | false | string,
  ) {
    editGuard.onBlurSave(e, commit, opts);
  }
  // Enter commits a single-line box as its blur does, the cursor kept in it (owner ruling R7): the
  // same options and commit, through the guard, whose fresh session makes the blur after it send
  // nothing. A commit that puts a refused figure back answers `false`.
  function onEnterSave(
    e: React.KeyboardEvent<HTMLInputElement>,
    opts: { trim?: boolean },
    commit: (value: string, atFocus: string) => void | false | string,
  ) {
    editGuard.onEnterCommit(e, commit, opts);
  }
  // The page's save, and the one Saved mark (R7): each field a landed save carried reads Saved
  // while its box shows it, a weight read as a figure.
  const savedMarks = useSavedMarks();
  async function save(patch: Record<string, unknown>): Promise<boolean> {
    const ok = await saveField(patch);
    if (ok) {
      for (const [field, value] of Object.entries(patch)) {
        savedMarks.mark(field, String(value ?? ""), { decimal: field === "eachWeight" || field === "loadWeight" });
      }
    }
    return ok;
  }

  // Each weight's and Load weight's blur commits. Each is read by the box's own rule
  // (`part-boxes.ts`) BEFORE a request; a refused figure is named, nothing is sent, and the box goes
  // back to what it held at focus (`atFocus`, the Load quantity revert's shape below). Each weight is
  // required, so its blank is refused; a blank Load weight clears it.
  function commitEachWeight(v: string, atFocus: string) {
    const refused = decimalRefusal(EACH_WEIGHT.label, v, EACH_WEIGHT.box, { required: true });
    if (refused) {
      patchDraft({ eachWeight: atFocus });
      onError(refused);
      return false; // the box is back on a value it was given (the guard's Enter contract)
    }
    void save({ eachWeight: v });
  }
  function commitLoadWeight(v: string, atFocus: string) {
    if (v.trim() === "") { void save({ loadWeight: null }); return ""; }
    const refused = decimalRefusal(LOAD_WEIGHT.label, v, LOAD_WEIGHT.box);
    if (refused) {
      patchDraft({ loadWeight: atFocus });
      onError(refused);
      return false; // the box is back on a value it was given (the guard's Enter contract)
    }
    void save({ loadWeight: v });
  }
  // Load quantity's and Request days override's blur commits (owner ruling 19, 2026-10-22, G5-4): each
  // is read by the whole-number rule (`whole-number-entry.ts`, the box's own bounds in
  // `whole-number-boxes.ts`) BEFORE a request, so `1e2` is refused where `Number()` took it as 100
  // and a 0 or a 4000 is refused here, by the box's sentence, instead of by the server's zod path.
  // A refused box is named, nothing is sent, and the box goes back to what it held at focus
  // (`atFocus`), as the decimal commits above do. A blank clears the figure: Load quantity's "no cap",
  // and the override's "use the customer's, then the plant default" (spec §7.1's chain).
  function commitLoadQty(v: string, atFocus: string) {
    if (v.trim() === "") { void save({ loadQty: null }); return ""; }
    const refused = wholeNumberRefusal(v, LOAD_QTY);
    if (refused) {
      patchDraft({ loadQty: atFocus });
      onError(refused);
      return false; // the box is back on a value it was given (the guard's Enter contract)
    }
    const reading = readWholeNumber(v, LOAD_QTY);
    if (!reading.ok) return;
    void save({ loadQty: reading.value });
    return String(reading.value); // the box shows the number ("2" for "002")
  }
  function commitRequestDaysOverride(v: string, atFocus: string) {
    if (v.trim() === "") { void save({ requestDaysOverride: null }); return ""; }
    const refused = wholeNumberRefusal(v, REQUEST_DAYS_OVERRIDE);
    if (refused) {
      patchDraft({ requestDaysOverride: atFocus });
      onError(refused);
      return false; // the box is back on a value it was given (the guard's Enter contract)
    }
    const reading = readWholeNumber(v, REQUEST_DAYS_OVERRIDE);
    if (!reading.ok) return;
    void save({ requestDaysOverride: reading.value });
    return String(reading.value); // the box shows the number ("2" for "002")
  }

  return (
    <>
    {/* The two cards (the UX redesign PR 9; owner 2026-11-01 on #824): every box, handler and
        sentence as it was in the one Identity card. */}
    <section id="part-identity" className={`${CARD} mb-6`}>
      <h2 className="mb-2 font-medium">Part identity</h2>
      {/* Customer is read-only and never an input — customerId is immutable (updatePart rejects
          any patch carrying it outright). */}
      <p className="mb-3 text-sm">
        Customer:{" "}
        <Link href={`/customers/${part.customerId}`} className={LINK}>
          {part.customerCode} · {part.customerName}
        </Link>
      </p>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">
          Part number
          <input aria-label="Part number" value={part.partNumber} onFocus={noteFocus("partNumber")} readOnly={!canEdit.allowed} title={canEdit.title}
                 onChange={(e) => patchDraft({ partNumber: e.target.value })}
                 onBlur={(e) => onBlurSave(e, { trim: true }, (partNumber) => void save({ partNumber }))}
                 onKeyDown={(e) => onEnterSave(e, { trim: true }, (partNumber) => void save({ partNumber }))}
                 className={`${INPUT_COMPACT} mt-1 w-full font-mono read-only:bg-surface-50`} />
          <SavedMark label="Part number" show={savedMarks.shows("partNumber", part.partNumber)} />
        </label>
        <label className="block text-sm">
          Name
          <input aria-label="Name" value={part.name} onFocus={noteFocus("name")} readOnly={!canEdit.allowed} title={canEdit.title}
                 onChange={(e) => patchDraft({ name: e.target.value })}
                 onBlur={(e) => onBlurSave(e, { trim: true }, (name) => void save({ name }))}
                 onKeyDown={(e) => onEnterSave(e, { trim: true }, (name) => void save({ name }))}
                 className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          <SavedMark label="Name" show={savedMarks.shows("name", part.name)} />
        </label>
        <label className="col-span-2 block text-sm">
          Description
          <textarea value={part.description} rows={2} onFocus={noteFocus("description")} readOnly={!canEdit.allowed}
                    title={canEdit.title}
                    onChange={(e) => patchDraft({ description: e.target.value })}
                    onBlur={(e) => onBlurSave(e, {}, (description) => void save({ description }))}
                    className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
        </label>
        {/* Phase 7 Task 15: presentation vocabulary (spec §5.7 ruling 4) — names the part's process
            for the traveler's Process: slot, bound live at print, blank prints nothing. A plain
            optional text field; controlled off `part.processName` (which the id-keyed PartDetail
            reloads fresh per record, §5.12), read-only without parts.edit (§5.16). */}
        <label className="col-span-2 block text-sm">
          Process name
          <input aria-label="Process name" value={part.processName} onFocus={noteFocus("processName")} readOnly={!canEdit.allowed} title={canEdit.title}
                 onChange={(e) => patchDraft({ processName: e.target.value })}
                 onBlur={(e) => onBlurSave(e, { trim: true }, (processName) => void save({ processName }))}
                 onKeyDown={(e) => onEnterSave(e, { trim: true }, (processName) => void save({ processName }))}
                 className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          <SavedMark label="Process name" show={savedMarks.shows("processName", part.processName)} />
          <span className="mt-1 block text-xs text-ink-500">
            Prints on the traveler&apos;s Process: line (e.g. Austemper). Blank prints nothing.
          </span>
        </label>
        <label className="block text-sm">
          Material
          <select value={part.materialId ?? ""} disabled={!canEdit.allowed || materialsRead !== "ready"}
                  title={optionsSelectTitle(canEdit, materialsRead)}
                  onChange={(e) => void save({ materialId: e.target.value || null })}
                  className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`}>
            <option value="">— none —</option>
            {materials.map((m) => (
              <option key={m.id} value={m.id}>{m.name}{!m.active && " (inactive)"}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          {EACH_WEIGHT_LB}
          <input aria-label={EACH_WEIGHT_LB} value={part.eachWeight} inputMode="decimal" onFocus={noteFocus("eachWeight")} readOnly={!canEdit.allowed}
                 title={canEdit.title}
                 onChange={(e) => patchDraft({ eachWeight: e.target.value })}
                 onBlur={(e) => onBlurSave(e, {}, commitEachWeight)}
                 onKeyDown={(e) => onEnterSave(e, {}, commitEachWeight)}
                 className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          <SavedMark label={EACH_WEIGHT_LB} show={savedMarks.shows("eachWeight", String(part.eachWeight ?? ""))} />
        </label>
      </div>
      <div className="mt-3 flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={part.active} disabled={!canEdit.allowed} title={canEdit.title}
                 onChange={(e) => void save({ active: e.target.checked })} />
          Active
        </label>
      </div>
    </section>
    <section id="load-defaults" className={`${CARD} mb-6`}>
      <h2 className="mb-2 font-medium">Load and order defaults</h2>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">
          Load quantity
          {/* Server-side loadQty is a real int (z.number().int().min(1), not decimalField's
              number-or-decimal-string): read here by the whole-number rule and sent as a number
              (`commitLoadQty`), never the typed text, which would otherwise JSON.stringify a
              non-numeric value to `null` (JSON has no NaN) and silently clear the field. */}
          <input aria-label="Load quantity" value={part.loadQty ?? ""} inputMode="numeric" onFocus={noteFocus("loadQty")} readOnly={!canEdit.allowed}
                 title={canEdit.title}
                 onChange={(e) => patchDraft({ loadQty: e.target.value })}
                 onBlur={(e) => onBlurSave(e, {}, commitLoadQty)}
                 onKeyDown={(e) => onEnterSave(e, {}, commitLoadQty)}
                 className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          <SavedMark label="Load quantity" show={savedMarks.shows("loadQty", String(part.loadQty ?? ""))} />
        </label>
        <label className="block text-sm">
          Load weight (lb)
          <input aria-label="Load weight (lb)" value={part.loadWeight ?? ""} inputMode="decimal" onFocus={noteFocus("loadWeight")} readOnly={!canEdit.allowed}
                 title={canEdit.title}
                 onChange={(e) => patchDraft({ loadWeight: e.target.value })}
                 onBlur={(e) => onBlurSave(e, {}, commitLoadWeight)}
                 onKeyDown={(e) => onEnterSave(e, {}, commitLoadWeight)}
                 className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          <SavedMark label="Load weight (lb)" show={savedMarks.shows("loadWeight", String(part.loadWeight ?? ""))} />
        </label>
        <label className="block text-sm">
          Request days override
          {/* Same real-int shape as Load quantity above (z.number().int().min(0).max(3650)), read by
              the whole-number rule and sent as a number (`commitRequestDaysOverride`). Blank
              clears the override, falling back to the customer's own override, then the plant
              default (spec §7.1's most-specific-wins chain — orders.ts). */}
          <input aria-label="Request days override" value={part.requestDaysOverride ?? ""} inputMode="numeric" onFocus={noteFocus("requestDaysOverride")}
                 readOnly={!canEdit.allowed} title={canEdit.title}
                 onChange={(e) => patchDraft({ requestDaysOverride: e.target.value })}
                 onBlur={(e) => onBlurSave(e, {}, commitRequestDaysOverride)}
                 onKeyDown={(e) => onEnterSave(e, {}, commitRequestDaysOverride)}
                 className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          <SavedMark label="Request days override" show={savedMarks.shows("requestDaysOverride", String(part.requestDaysOverride ?? ""))} />
          <span className="mt-1 block text-xs text-ink-500">Blank uses the plant/customer default.</span>
        </label>
      </div>
      <div className="mt-3 flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={part.serializationRequired} disabled={!canEdit.allowed}
                 title={canEdit.title}
                 onChange={(e) => void save({ serializationRequired: e.target.checked })} />
          Serialization required
        </label>
      </div>
      {/* Certification chain (spec §6.1, Task 17): three-state, never a checkbox — an explicit
          "No" and "inherit" are different answers (a part can override a cert-required customer
          back DOWN), and the Inherit option names what it currently resolves to (customer
          default, else plant setting — `inheritedCert*`, computed server-side) so choosing it is
          never a blind fallback. Selects save on change like Material above; §5.16 gating. */}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="block text-sm">
          Certification required
          <select value={part.certRequired === null ? "" : part.certRequired ? "yes" : "no"}
                  disabled={!canEdit.allowed} title={canEdit.title}
                  onChange={(e) => void save({ certRequired: e.target.value === "" ? null : e.target.value === "yes" })}
                  className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`}>
            <option value="">Inherit — currently {part.inheritedCertRequired ? "Yes" : "No"}</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label className="block text-sm">
          Certification scope
          <select value={part.certScope ?? ""} disabled={!canEdit.allowed} title={canEdit.title}
                  onChange={(e) => void save({ certScope: e.target.value === "" ? null : e.target.value })}
                  className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`}>
            <option value="">Inherit — currently {CERT_SCOPE_LABELS[part.inheritedCertScope]}</option>
            {CERT_SCOPES.map((s) => <option key={s} value={s}>{CERT_SCOPE_LABELS[s]}</option>)}
          </select>
        </label>
      </div>
    </section>
    </>
  );
}
