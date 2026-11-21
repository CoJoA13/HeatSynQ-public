// The Configuration screens' tabs (spec 2026-10-30-ux-redesign-design.md §4.4; the UX redesign PR 11,
// owner 2026-11-01 on #826): every panel stays mounted, and none of these sections registers unsaved
// work (they are blur-saves and row actions, and the template editor's one Save draft sits in its
// header), so every `sections` is empty. A Settings tab is a server group, so a new group shows up
// without a list here. Client-safe; the E2E helpers read the labels from the page.
import type { RecordTab } from "./record-tabs";

export const SETTINGS_TAB_LABEL = "Settings categories";
export const ACCOUNTING_TAB_LABEL = "Accounting categories";
export const SURCHARGE_TAB_LABEL = "Surcharge sections";
export const PART_FIELD_TAB_LABEL = "Part field sections";
export const EDITOR_TAB_LABEL = "Template sections";

/** Settings the working form leaves out: they issue no numbers (the file's note). The settings stay. */
export const HIDDEN_SETTING_KEYS: ReadonlySet<string> = new Set(["invoice_number_next", "cert_number_next"]);

export function settingsTabs(groups: string[]): RecordTab[] {
  return groups.map((g) => ({ key: g.toLowerCase(), label: g, sections: [] }));
}

export function accountingTabs(): RecordTab[] {
  return [
    { key: "gl", label: "GL mappings", sections: [] },
    { key: "tax", label: "Tax & certification", sections: [] },
    { key: "statement", label: "Statement finance charge", sections: [] },
  ];
}

export function surchargeTabs(): RecordTab[] {
  return [
    { key: "list", label: "Surcharge list", sections: [], ids: ["surcharge-list", "new-surcharge"] },
    { key: "selected", label: "Selected surcharge", sections: [], ids: ["selected-surcharge"] },
    { key: "history", label: "History", sections: [], ids: ["surcharge-history"] },
  ];
}

export function partFieldTabs(): RecordTab[] {
  return [
    { key: "fields", label: "Field definitions", sections: [], ids: ["field-definitions"] },
    { key: "history", label: "History", sections: [] },
  ];
}

/** The editor's tabs (owner 2026-11-02 on #828, amending #826's four). A contract with no standing
 *  text has no Wording tab, and one with no column table no Fields & widths: a tab holds something.
 *  A canvas template (its config holds a layout; design 2026-11-07 §8) shows Design in place of
 *  Sections and Fields & widths, which its paper does not read; the other tabs are unchanged. */
export function editorTabs({ wording, widths, canvas }: { wording: boolean; widths: boolean; canvas: boolean }): RecordTab[] {
  return [
    ...(canvas
      ? [{ key: "design", label: "Design", sections: [], ids: ["canvas-design"] }]
      : [
        { key: "sections", label: "Sections", sections: [] },
        ...(widths ? [{ key: "widths", label: "Fields & widths", sections: [], ids: ["column-widths"] }] : []),
      ]),
    { key: "appearance", label: "Appearance", sections: [] },
    ...(wording ? [{ key: "wording", label: "Wording", sections: [] }] : []),
    { key: "preview", label: "Preview", sections: [] },
    { key: "versions", label: "Versions", sections: [] },
  ];
}
