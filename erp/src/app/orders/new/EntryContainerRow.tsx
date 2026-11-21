"use client";
// One container row of order entry's Parts & containers tab (the weights design §4.1 and §9.4).
// Markup only. The row keeps no state beyond what EntryOptionalSection keeps, and every change goes
// to the page as a patch of the draft row. It lives outside page.tsx so a markup test can render
// it: the page itself cannot be rendered in a test.
import { formatNumber } from "@/lib/format";
import { tareTotal } from "@/lib/net-weight";
import { TARE_EACH_LB, TARE_TOTAL_LB } from "@/lib/weight-terms";
import { entryTareEach, typeDefaultTare } from "@/lib/container-tare-prefill";
import { SCALE_GROSS } from "@/lib/order-boxes";
import { EntryOptionalSection } from "./EntryWorkspace";
import type { ContainerDraft, ContainerTypeOption } from "./order-draft";
import { INPUT_COMPACT } from "@/lib/ui-classes";

export function EntryContainerRow({ container: c, index, containerTypes, errorFieldIds, onChange, onRemove }: {
  container: ContainerDraft;
  index: number;
  containerTypes: readonly ContainerTypeOption[];
  /** Every field the page's present refusals point at, in the page's order (none when there is no
   *  refusal). A refusal on this row opens the optional section wherever it stands in that list, so
   *  each refused box in it is in view and the first can take the cursor. */
  errorFieldIds: readonly string[];
  onChange: (patch: Partial<ContainerDraft>) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const prefix = `entry-container-${c.id}-`;
  // What the Tare each box shows: the operator's own text once the box was typed in, a cleared box
  // included, and until then the picked type's default. The default is never written to the draft,
  // so a change of type below writes `typeId` alone and an untyped box follows the new type.
  const shown = entryTareEach(c.tareEachOverride, typeDefaultTare(containerTypes, c.typeId));
  return (
    <div className="mb-4 border-b border-line pb-3 text-sm">
      <div className="grid items-end gap-3 sm:grid-cols-5">
        <label className="block">
          Type
          <select id={`${prefix}type`} value={c.typeId ?? ""} onChange={(e) => onChange({ typeId: e.target.value || null })}
                  aria-label={`Container ${n} type`}
                  className={`${INPUT_COMPACT} mt-1 w-full`}>
            <option value="">— choose —</option>
            {containerTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="block">
          Containers
          <input id={`${prefix}count`} value={c.count} inputMode="numeric" onChange={(e) => onChange({ count: e.target.value })}
                 aria-label={`Container ${n} count`} className={`${INPUT_COMPACT} mt-1 w-full`} />
        </label>
        <label className="block">
          Pieces (total)
          <input id={`${prefix}pieces`} value={c.pieces} inputMode="numeric" onChange={(e) => onChange({ pieces: e.target.value })}
                 aria-label={`Container ${n} pieces`} className={`${INPUT_COMPACT} mt-1 w-full`} />
        </label>
        <label className="block">
          {TARE_EACH_LB}
          <input id={`${prefix}tareEach`} value={shown} inputMode="decimal" onChange={(e) => onChange({ tareEachOverride: e.target.value })}
                 aria-label={`Container ${n} tare each`} className={`${INPUT_COMPACT} mt-1 w-full`} />
        </label>
        <div>{TARE_TOTAL_LB}<p className="mt-1 rounded border bg-surface-50 px-2 py-1">
          {formatNumber(tareTotal({ count: c.count, tareEach: shown }), 2)}
        </p></div>
      </div>
      <div className="mt-3"><EntryOptionalSection title="Container weights & IDs"
        forceOpen={!!(c.scaleGross || c.customerContainerId) || errorFieldIds.some((id) => id.startsWith(prefix))}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            {SCALE_GROSS.label}
            <input id={`${prefix}scaleGross`} value={c.scaleGross} inputMode="decimal" onChange={(e) => onChange({ scaleGross: e.target.value })}
                   aria-label={`Container ${n} scale gross`} className={`${INPUT_COMPACT} mt-1 w-full`} />
          </label>
          <label className="block">
            Cust Cont Id
            {/* §3.22 (Task 17): the customer's own bin id — the ticket's "Cust Cont
                Id" column. Sibling of the hub ContainersSection's identical column
                (the sibling-grid rule, spec §11). */}
            <input id={`${prefix}customerContainerId`} value={c.customerContainerId} onChange={(e) => onChange({ customerContainerId: e.target.value })}
                   aria-label={`Container ${n} customer container id`} className={`${INPUT_COMPACT} mt-1 w-full`} />
          </label>
        </div>
      </EntryOptionalSection></div>
      <button type="button" onClick={onRemove} className="mt-2 text-xs text-red-600">Remove</button>
    </div>
  );
}
