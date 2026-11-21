"use client";
import { useState } from "react";
import type { Gate } from "@/lib/permission-ui";
import { useUnsavedSection } from "@/lib/use-unsaved-section";
import { saveButtonTitle } from "@/lib/waiting-titles";
import { DiscardButton } from "./DiscardButton";
import { UnsavedBadge } from "./UnsavedBadge";
import { BUTTON_PRIMARY } from "@/lib/ui-classes";

/**
 * The one Save-button shape every EXPLICIT-SAVE grid shares, at eight sites: the four order-hub
 * sections (Containers, Serials, Charges, Loads), the three grids of a saved shipment's order panel
 * (Lines, Containers, Serials) and the invoice's lines. tests/save-button-wiring.test.ts holds the
 * census.
 *
 * Its title is `saveButtonTitle` (src/lib/waiting-titles.ts): a closed gate's own reason first.
 * Under an open gate it carries none while the grid is dirty or while its save is in flight, when
 * its label reads "Saving…" (owner answer 9, 2026-10-16); otherwise the grid is clean, and it says
 * "No unsaved changes", or what to do with `alsoUnsaved`'s work (#487). The button has no recovery
 * flag of its own. A grid's recovery beat reaches it through the gate it is handed:
 * `gridGate(pageGate, grid.mode)` on the hub and the shipment panel (shipment-gates.ts), and the
 * invoice's own `recoveryGate`.
 *
 * It also declares the section to the unsaved-edit guard. A detail page runs two save models at
 * once: the fields at the top of the order hub save on BLUR, while these grids need this button
 * clicked, and nothing on screen said which was which. Registering from inside the button means a
 * section that USES this button cannot acquire an explicit Save without also announcing what is at
 * risk when someone navigates away.
 *
 * That is not, by itself, a guarantee about the app — and !272 originally claimed it was. It binds
 * only the editors that adopt this button, and several explicit-save editors did not: the invoice
 * lines grid, the template editor, cert results, process steps, the quote page, custom fields and
 * the receivables apply panel all held a draft while `unsavedLabels()` stayed empty. The census
 * that actually holds the line is tests/unsaved-registration-sweep.test.ts, which fails on any
 * explicit-save editor that does not register; those that cannot use this button call
 * `useUnsavedSection` directly.
 *
 * Its amber badge is `UnsavedBadge`, which the editors that register themselves draw too (#640).
 *
 * `section` is the human name the prompt uses ("Containers has unsaved changes…"), so it is a
 * separate prop from `label`: the button reads "Save containers", the sentence needs "Containers".
 */
export function SaveButton({ label, section, scope, gate, dirty, onSave, onDiscard, alsoUnsaved = false }: {
  label: string;
  /** Human name of the section for the navigation prompt — capitalised, e.g. "Containers". */
  section: string;
  /**
   * Names the ROWS this button saves, where `section` names them for a human — `serials:<lineId>`,
   * `shipment-order:<shipperOrderId>`. Pass it wherever a control on the page destroys this
   * section's rows on their own, so that control can refuse on exactly these edits
   * (`useUnsavedInScope`) instead of on any dirty grid anywhere. Sections nothing destroys
   * piecemeal leave it out, and nothing changes for them.
   */
  scope?: string;
  gate: Gate;
  dirty: boolean;
  /** Return the actual save promise so only this grid's Discard waits for its result. */
  onSave: () => Promise<void>;
  /** Reset this grid and any entry fields included in `alsoUnsaved`, without a server write. */
  onDiscard: () => void;
  /**
   * Work held in this section that this button CANNOT save — a value typed into an entry field but
   * not yet committed into the grid. It arms the navigation guard without enabling Save, because
   * the two questions are different: "is anything at risk if we leave" and "is there anything this
   * click would write". Serials' "Add serial(s)" range box is the case that found this (Codex P1 on
   * !272): the text is real work, reloading loses it, and a blur during unload cannot arm the
   * listener in time — but Save has nothing to send until the range is expanded into rows. Held
   * while the grid is clean, the gate open and no save of this button in flight, it titles Save with
   * what to do with that text, never "No unsaved changes".
   */
  alsoUnsaved?: boolean;
}) {
  useUnsavedSection(dirty || alsoUnsaved, section, scope);
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try { await onSave(); } finally { setSaving(false); }
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={() => void save()} disabled={!gate.allowed || !dirty || saving}
              title={saveButtonTitle({ gate, dirty, alsoUnsaved, saving })}
              className={BUTTON_PRIMARY}>
        {saving ? "Saving…" : label}
      </button>
      <DiscardButton section={section} dirty={dirty || alsoUnsaved} pending={saving} onDiscard={onDiscard} />
      {/* Deliberately `dirty`, never `alsoUnsaved` (the badge's header says why). */}
      <UnsavedBadge dirty={dirty} />
    </span>
  );
}
