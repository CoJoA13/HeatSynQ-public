import { describe, expect, it } from "vitest";
import { buildContainerTags } from "@/server/pdf/container-tags";
import { DEFAULT_CONFIG as DEFAULT_TAG_CONFIG } from "@/lib/template-contracts/container-tag";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LOGO_WIDTH,
  STALE_DRAFT_MESSAGE,
  canMoveField,
  canvasSaveBlock,
  canMoveSection,
  clearLogoPlacement,
  editorOffers,
  editorWithholds,
  setFieldLabelBlank,
  LABEL_SIZE_LABELS,
  fieldMoveGate,
  lockIndex,
  moveField,
  moveSection,
  parseMeasure,
  previewRecordSpec,
  printedBudgetRefusals,
  printedWidthWarning,
  resolveSaveError,
  resolveSaveSettle,
  sectionMoveGate,
  seedFailureMessage,
  seedRequest,
  setFieldLabel,
  setFieldWidth,
  setFonts,
  setFormat,
  setLayout,
  setLogoPlacement,
  setLogoWidth,
  setPageFooter,
  setTextBlock,
  sharedWidthNotice,
  tableBudgets,
  toggleFieldVisible,
  toggleSectionVisible,
  widthBudgetError,
  withArticle,
} from "@/lib/template-editor";
import { validateContractConfig } from "@/lib/template-contracts/types";
import { ApiError, UnreadableAnswerError, WRITE_ANSWER_UNREADABLE } from "@/lib/fetcher";
import { CANVAS_RECORD_WORDS, DESIGNER_WORDS } from "@/lib/canvas-designer";
import type { CanvasMeasure } from "@/lib/template-canvas";
import { COLUMN_TABLE_LAYOUTS } from "@/lib/template-printed-width";
import { barcode, layoutOf, standardLayout } from "./helpers/canvas-fixtures";
import {
  CERT_CONTRACT,
  CERT_DEFAULT_CONFIG,
  CONTAINER_TAG_CONTRACT,
  CONTENT_WIDTH,
  INVOICE_CONTRACT,
  INVOICE_DEFAULT_CONFIG,
  TEMPLATE_DOC_TYPES,
  TRAVELER_CONTRACT,
  TRAVELER_DEFAULT_CONFIG,
  TemplateConfigError,
  contractFor,
  defaultConfigFor,
  validateConfig,
  type TemplateConfig,
  type TemplateContract,
  type TemplateDocTypeString,
} from "@/lib/template-contracts";

// Pure module, no DB, no DOM: the config-editing logic the editor's panels are thin wrappers over
// (Phase 7 Task 17). Every function is immutable — the input config is never mutated — and the
// width-budget check mirrors the server's own guardrail so the editor surfaces it early. The
// panels themselves (the rendered UI) are proven in the templates-admin E2E flow.

/** A deep JSON copy — a fresh working config per test, and a guard that a mutation didn't touch
 *  the input (compare the input to its pre-call clone). */
function clone(config: TemplateConfig): TemplateConfig {
  return JSON.parse(JSON.stringify(config)) as TemplateConfig;
}

const traveler = () => clone(TRAVELER_DEFAULT_CONFIG);
const invoice = () => clone(INVOICE_DEFAULT_CONFIG);

function sectionVisible(config: TemplateConfig, key: string): boolean {
  return config.sections.find((s) => s.key === key)!.visible;
}
function field(config: TemplateConfig, sectionKey: string, fieldKey: string) {
  return config.sections.find((s) => s.key === sectionKey)!.fields.find((f) => f.key === fieldKey)!;
}
function sectionOrder(config: TemplateConfig): string[] {
  return config.sections.map((s) => s.key);
}

describe("show/hide", () => {
  it("toggleSectionVisible flips visibility without mutating the input", () => {
    const before = traveler();
    const snapshot = clone(before);
    const after = toggleSectionVisible(before, "lines");
    expect(sectionVisible(after, "lines")).toBe(false);
    expect(toggleSectionVisible(after, "lines")).toEqual(before); // flips back
    expect(before).toEqual(snapshot); // input untouched
  });

  it("toggleFieldVisible flips a field's visibility", () => {
    const after = toggleFieldVisible(traveler(), "lines", "line_qty");
    expect(field(after, "lines", "line_qty").visible).toBe(false);
  });
});

describe("label override", () => {
  it("setFieldLabel sets an override, and '' clears it back to the contract default (null)", () => {
    const named = setFieldLabel(traveler(), "lines", "line_qty", "Qty");
    expect(field(named, "lines", "line_qty").label).toBe("Qty");
    const cleared = setFieldLabel(named, "lines", "line_qty", "");
    expect(field(cleared, "lines", "line_qty").label).toBeNull();
  });

  it("does not mutate the input", () => {
    const before = traveler();
    const snapshot = clone(before);
    setFieldLabel(before, "lines", "line_qty", "Qty");
    expect(before).toEqual(snapshot);
  });
});

describe("column widths", () => {
  it("setFieldWidth sets an override; null clears it", () => {
    const wide = setFieldWidth(traveler(), "lines", "line_qty", 90);
    expect(field(wide, "lines", "line_qty").width).toBe(90);
    expect(field(setFieldWidth(wide, "lines", "line_qty", null), "lines", "line_qty").width).toBeNull();
  });

  it("tableBudgets: the default traveler config is within budget", () => {
    const budgets = tableBudgets(TRAVELER_CONTRACT, traveler());
    expect(budgets.length).toBeGreaterThan(0);
    expect(budgets.every((b) => !b.over)).toBe(true);
  });

  it("tableBudgets: over-budget column widths report over-budget, matching the server's budget rule", () => {
    // The traveler's "lines" table: [78, "*", 78, 88]; the flex column counts 0. Each field width
    // must stay <=564 (the per-field shape cap), so blow the budget with the SUM of two legal
    // widths: line_qty 300 + line_each_weight 78 + line_weight 300 = 678 > 564.
    const bad = setFieldWidth(setFieldWidth(traveler(), "lines", "line_qty", 300),
      "lines", "line_weight", 300);
    const linesBudget = tableBudgets(TRAVELER_CONTRACT, bad).find((b) => b.table === "lines")!;
    expect(linesBudget.over).toBe(true);
    expect(linesBudget.budget).toBe(564);
    expect(linesBudget.total).toBe(300 + 78 + 300); // "*" counts 0
    // The client shows this early; the SERVER still refuses the hand-built config via the budget
    // rule (TemplateConfigError, NOT a per-field shape ZodError — every field here is <=564).
    expect(() => validateConfig("TRAVELER", bad)).toThrow(TemplateConfigError);
  });

  it("tableBudgets: hiding a column frees its budget (only visible columns count)", () => {
    // Widen line_qty over budget, then hide the flex part column — still over; hide line_qty's
    // section-mates until under. Simpler: widen to exactly the edge and confirm the hide drops it.
    const wide = setFieldWidth(traveler(), "lines", "line_weight", 400); // 78+0+78+400 = 556, ok
    expect(tableBudgets(TRAVELER_CONTRACT, wide).find((b) => b.table === "lines")!.over).toBe(false);
    const wider = setFieldWidth(wide, "lines", "line_qty", 200); // 200+0+78+400 = 678 > 564
    expect(tableBudgets(TRAVELER_CONTRACT, wider).find((b) => b.table === "lines")!.over).toBe(true);
    const hidden = toggleFieldVisible(wider, "lines", "line_weight"); // drops 400 → 278, ok
    expect(tableBudgets(TRAVELER_CONTRACT, hidden).find((b) => b.table === "lines")!.over).toBe(false);
  });
});

describe("section reorder respecting pins", () => {
  // Traveler section order: header(0), lines(1), quantities(2), process(3), inspections(4),
  // steps(5, PINNED non-reorderable), footer(6). steps must stay at index 5.
  it("moves two reorderable neighbours", () => {
    const moved = moveSection(traveler(), TRAVELER_CONTRACT, "header", 1);
    expect(sectionOrder(moved).slice(0, 2)).toEqual(["lines", "header"]);
  });

  it("canMoveSection: a pinned section cannot move in either direction", () => {
    expect(canMoveSection(traveler(), TRAVELER_CONTRACT, "steps", -1)).toBe(false);
    expect(canMoveSection(traveler(), TRAVELER_CONTRACT, "steps", 1)).toBe(false);
    expect(moveSection(traveler(), TRAVELER_CONTRACT, "steps", -1)).toEqual(traveler());
  });

  it("canMoveSection: a move that would displace a pinned neighbour is blocked", () => {
    // inspections(4) down would swap into steps(5) — blocked, keeping steps at its index.
    expect(canMoveSection(traveler(), TRAVELER_CONTRACT, "inspections", 1)).toBe(false);
    // footer(6) up would swap with steps — blocked; footer is otherwise reorderable.
    expect(canMoveSection(traveler(), TRAVELER_CONTRACT, "footer", -1)).toBe(false);
  });

  it("canMoveSection: a config section the contract lacks cannot move, and does not block its neighbours", () => {
    // Not a state the validator lets through (it refuses an unknown section key); the predicate
    // answers for it all the same, and this holds the answer it has always given.
    const contract = { ...TRAVELER_CONTRACT, sections: TRAVELER_CONTRACT.sections.filter((cs) => cs.key !== "lines") };
    for (const dir of [-1, 1] as const) expect(canMoveSection(traveler(), contract, "lines", dir), `lines ${dir}`).toBe(false);
    expect(moveSection(traveler(), contract, "lines", 1)).toEqual(traveler());
    expect(canMoveSection(traveler(), contract, "header", 1)).toBe(true);
    expect(canMoveSection(traveler(), contract, "quantities", -1)).toBe(true);
  });

  it("canMoveSection: false at the list boundaries", () => {
    expect(canMoveSection(traveler(), TRAVELER_CONTRACT, "header", -1)).toBe(false);
  });

  it("a config produced by legal moves keeps steps at its contract index and validates", () => {
    let config = traveler();
    config = moveSection(config, TRAVELER_CONTRACT, "header", 1);
    config = moveSection(config, TRAVELER_CONTRACT, "quantities", -1);
    expect(sectionOrder(config).indexOf("steps")).toBe(5);
    expect(() => validateConfig("TRAVELER", config)).not.toThrow();
  });
});

describe("field reorder", () => {
  it("moveField swaps within a section; canMoveField bounds", () => {
    const moved = moveField(traveler(), "lines", "line_qty", 1);
    expect(field(moved, "lines", "line_part")).toBeDefined();
    expect(moved.sections.find((s) => s.key === "lines")!.fields.slice(0, 2).map((f) => f.key))
      .toEqual(["line_part", "line_qty"]);
    expect(canMoveField(traveler(), "lines", "line_qty", -1)).toBe(false); // already first
    expect(canMoveField(traveler(), "lines", "line_qty", 1)).toBe(true);
  });
});

// #408, §5.16: a section's or a field's ↑/↓ says why it is disabled. `moveSection` acts on
// `canMoveSection`; `moveField` makes its own bounds check (`swapAt`) and does not read
// `canMoveField`, which only these tests call. So each gate is compared with the mover itself as
// well as with the predicate, or a button could be enabled over a move that does nothing.
describe("the reason a section's or a field's ↑/↓ is disabled (#408)", () => {
  type Gate = { disabled: boolean; title: string | undefined };
  const open: Gate = { disabled: false, title: undefined };
  const blocked: Gate = { disabled: true, title: "Requires admin.edit" };
  const PINNED = "This section is pinned in place";
  const section = (key: string, dir: -1 | 1, gate = open, pinnedReason = PINNED) =>
    sectionMoveGate(gate, traveler(), TRAVELER_CONTRACT, key, dir, pinnedReason);

  // Traveler order: header(0), lines(1), quantities(2), process(3), inspections(4), steps(5,
  // pinned), footer(6).
  it("a section at an end of the list reads \"Already first\" / \"Already last\"", () => {
    expect(section("header", -1)).toEqual({ disabled: true, title: "Already first" });
    expect(section("footer", 1)).toEqual({ disabled: true, title: "Already last" });
  });

  it("a section beside a pinned one says the neighbour is pinned (owner ruling 2026-10-01)", () => {
    expect(section("inspections", 1)).toEqual({ disabled: true, title: "The next section is pinned in place" });
    expect(section("footer", -1)).toEqual({ disabled: true, title: "The previous section is pinned in place" });
  });

  it("a pinned section keeps its own reason, both ways, with or without the edit gate", () => {
    for (const dir of [-1, 1] as const) {
      expect(section("steps", dir)).toEqual({ disabled: true, title: PINNED });
      expect(section("steps", dir, open, "the lock's reason")).toEqual({ disabled: true, title: "the lock's reason" });
      expect(section("steps", dir, blocked, "the lock's reason")).toEqual({ disabled: true, title: "the lock's reason" });
    }
  });

  it("a section that can move is enabled, with no title", () => {
    for (const [key, dir] of [["header", 1], ["lines", -1], ["lines", 1], ["inspections", -1]] as const) {
      expect(section(key, dir), `${key} ${dir}`).toEqual(open);
    }
  });

  it("the edit gate's reason wins on a reorderable section, the blocked moves included", () => {
    for (const [key, dir] of [["header", -1], ["header", 1], ["inspections", 1], ["footer", -1], ["footer", 1]] as const) {
      expect(section(key, dir, blocked), `${key} ${dir}`).toEqual(blocked);
    }
  });

  it("a field at an end of its section reads \"Already first\" / \"Already last\", and the gate wins", () => {
    const keys = traveler().sections.find((s) => s.key === "lines")!.fields.map((f) => f.key);
    const field = (key: string, dir: -1 | 1, gate = open) => fieldMoveGate(gate, traveler(), "lines", key, dir);
    expect(field(keys[0], -1)).toEqual({ disabled: true, title: "Already first" });
    expect(field(keys[keys.length - 1], 1)).toEqual({ disabled: true, title: "Already last" });
    expect(field(keys[0], 1)).toEqual(open);
    expect(field(keys[1], -1)).toEqual(open);
    expect(field(keys[0], -1, blocked)).toEqual(blocked);
    expect(field(keys[1], -1, blocked)).toEqual(blocked);
  });

  it("a pinned section's own reason outranks an end of the list and a pinned neighbour", () => {
    // No real contract pins a first or last section, or two adjacent ones, so this one is
    // synthetic: the traveler with its first two sections pinned.
    const contract: TemplateContract = {
      ...TRAVELER_CONTRACT,
      sections: TRAVELER_CONTRACT.sections.map((s, i) => (i < 2 ? { ...s, reorderable: false } : s)),
    };
    const config = validateContractConfig(contract, TRAVELER_DEFAULT_CONFIG);
    const first = config.sections[0].key;
    for (const gate of [open, blocked]) for (const dir of [-1, 1] as const) {
      expect(sectionMoveGate(gate, config, contract, first, dir, "the lock's reason"), `${dir}`)
        .toEqual({ disabled: true, title: "the lock's reason" });
    }
  });

  /** Swap two adjacent entries by hand, so a config under test never depends on the mover. */
  const swap = <T,>(xs: readonly T[], i: number): T[] => [...xs.slice(0, i), xs[i + 1], xs[i], ...xs.slice(i + 2)];
  const keys = (c: TemplateConfig) => c.sections.map((s) => s.key);
  const order = (c: TemplateConfig) => JSON.stringify(c.sections.map((s) => [s.key, s.fields.map((f) => f.key)]));

  it("a section's gate follows the config's order once it differs from the contract's", () => {
    const c1 = { ...traveler(), sections: swap(traveler().sections, 0) };
    expect(keys(c1).slice(0, 2)).toEqual(["lines", "header"]);
    expect(sectionMoveGate(open, c1, TRAVELER_CONTRACT, "lines", -1, PINNED)).toEqual({ disabled: true, title: "Already first" });
    expect(sectionMoveGate(open, c1, TRAVELER_CONTRACT, "header", -1, PINNED)).toEqual(open);
    expect(canMoveSection(c1, TRAVELER_CONTRACT, "lines", -1)).toBe(false);
    expect(canMoveSection(c1, TRAVELER_CONTRACT, "header", -1)).toBe(true);
    const c2 = { ...traveler(), sections: swap(traveler().sections, 3) };
    expect(keys(c2).slice(3, 6)).toEqual(["inspections", "process", "steps"]);
    expect(sectionMoveGate(open, c2, TRAVELER_CONTRACT, "process", 1, PINNED)).toEqual({ disabled: true, title: "The next section is pinned in place" });
    expect(sectionMoveGate(open, c2, TRAVELER_CONTRACT, "inspections", 1, PINNED)).toEqual(open);
    expect(canMoveSection(c2, TRAVELER_CONTRACT, "process", 1)).toBe(false);
  });

  it("on every contract's default config and each config one move away, a button is enabled exactly when the mover moves", () => {
    let configs = 0; let sections = 0; let fields = 0;
    for (const docType of TEMPLATE_DOC_TYPES) {
      const contract = contractFor(docType); const base = defaultConfigFor(docType);
      const moved = [
        ...base.sections.flatMap((s) => ([-1, 1] as const).map((d) => moveSection(base, contract, s.key, d))),
        ...base.sections.flatMap((s) => (s.fields.length < 2 ? [] : [moveField(base, s.key, s.fields[0].key, 1)])),
      ].filter((c) => order(c) !== order(base));
      for (const config of [base, ...moved]) {
        configs++;
        for (const s of config.sections) for (const dir of [-1, 1] as const) {
          const at = `${docType} [${keys(config).join(",")}] ${s.key} ${dir}`; sections++;
          const enabled = !sectionMoveGate(open, config, contract, s.key, dir, PINNED).disabled;
          expect(enabled, at).toBe(canMoveSection(config, contract, s.key, dir));
          expect(enabled, at).toBe(order(moveSection(config, contract, s.key, dir)) !== order(config));
          for (const f of s.fields) {
            fields++;
            const fieldEnabled = !fieldMoveGate(open, config, s.key, f.key, dir).disabled;
            expect(fieldEnabled, `${at} ${f.key}`).toBe(canMoveField(config, s.key, f.key, dir));
            expect(fieldEnabled, `${at} ${f.key}`).toBe(order(moveField(config, s.key, f.key, dir)) !== order(config));
          }
        }
      }
    }
    expect(configs).toBeGreaterThan(8); expect(sections).toBeGreaterThan(40); expect(fields).toBeGreaterThan(200);
  });

  it("a key the config does not hold is disabled, with the edit gate's reason when the gate is closed and none otherwise", () => {
    expect(sectionMoveGate(open, traveler(), TRAVELER_CONTRACT, "nope", 1, PINNED)).toEqual({ disabled: true, title: undefined });
    expect(fieldMoveGate(open, traveler(), "lines", "nope", 1)).toEqual({ disabled: true, title: undefined });
    expect(fieldMoveGate(open, traveler(), "nope", "line_qty", 1)).toEqual({ disabled: true, title: undefined });
    expect(sectionMoveGate(blocked, traveler(), TRAVELER_CONTRACT, "nope", 1, PINNED)).toEqual(blocked);
    expect(fieldMoveGate(blocked, traveler(), "lines", "nope", 1)).toEqual(blocked);
    expect(fieldMoveGate(blocked, traveler(), "nope", "line_qty", 1)).toEqual(blocked);
  });
});

describe("format knobs", () => {
  it("setFormat sets a declared knob on the invoice", () => {
    const c = setFormat(invoice(), "negativeStyle", "PARENTHESES");
    expect(c.formats.negativeStyle).toBe("PARENTHESES");
    const d = setFormat(c, "priceDecimals", 3);
    expect(d.formats.priceDecimals).toBe(3);
    const e = setFormat(d, "dateFormat", "YYYY-MM-DD");
    expect(e.formats.dateFormat).toBe("YYYY-MM-DD");
    expect(() => validateConfig("INVOICE", e)).not.toThrow();
  });
});

describe("fonts, text blocks, page footer", () => {
  it("setFonts patches family and sizes", () => {
    const c = setFonts(traveler(), { family: "Liberation Sans", baseSize: 9 });
    expect(c.fonts.family).toBe("Liberation Sans");
    expect(c.fonts.baseSize).toBe(9);
    expect(c.fonts.headingSize).toBe(TRAVELER_DEFAULT_CONFIG.fonts.headingSize); // untouched
  });

  it("setTextBlock sets a block body (cert statement)", () => {
    const c = setTextBlock(clone(CERT_DEFAULT_CONFIG), "cert_statement", "We certify the above.");
    expect(c.textBlocks.cert_statement).toBe("We certify the above.");
    expect(() => validateConfig("CERT", c)).not.toThrow();
    expect(CERT_CONTRACT.textBlocks.some((t) => t.key === "cert_statement")).toBe(true);
  });

  it("setPageFooter toggles the page footer", () => {
    expect(setPageFooter(traveler(), true).pageFooter).toBe(true);
  });
});

describe("logo placement + width", () => {
  it("setLogoPlacement creates the logo block with the default width", () => {
    const c = setLogoPlacement(traveler(), "header-left");
    expect(c.logo).toEqual({ placement: "header-left", width: DEFAULT_LOGO_WIDTH });
  });

  it("setLogoWidth preserves the placement; changing placement preserves the width", () => {
    const placed = setLogoPlacement(traveler(), "header-left");
    const sized = setLogoWidth(placed, 200);
    expect(sized.logo).toEqual({ placement: "header-left", width: 200 });
    const moved = setLogoPlacement(sized, "header-center");
    expect(moved.logo).toEqual({ placement: "header-center", width: 200 });
  });

  it("setLogoWidth is a no-op when no placement is chosen", () => {
    expect(setLogoWidth(traveler(), 200).logo).toBeNull();
  });

  it("clearLogoPlacement removes the logo block", () => {
    expect(clearLogoPlacement(setLogoPlacement(traveler(), "header-left")).logo).toBeNull();
  });
});

describe("lockIndex — the namespaced padlock lookup the panels render from", () => {
  it("keys each locked element by (scope, key) so a section lookup never matches a field lookup", () => {
    const idx = lockIndex(TRAVELER_CONTRACT);
    // The steps section AND its typed-field columns are both locked (spec §5.6) — each reachable
    // under its own scope, both carrying the step-fields reason.
    expect(idx.get("section:steps")).toMatch(/Step-fields ruling/);
    expect(idx.get("field:step_code")).toMatch(/Step-fields ruling/);
    // The header section is locked (it carries the barcode) and so is the barcode field.
    expect(idx.get("section:header")).toBeDefined();
    expect(idx.get("field:barcode")).toBeDefined();
    // A free section/field is absent — the editor renders no padlock for it.
    expect(idx.get("section:lines")).toBeUndefined();
    expect(idx.get("field:line_qty")).toBeUndefined();
  });

  it("resolves a section and a field that SHARE a key independently, by scope", () => {
    // A section key and a field key are each only unique within their own kind, so a contract can
    // legitimately carry both "shared" a locked section and "shared" a free field. Keyed by scope,
    // the two never collide into one ambiguous padlock (the Task 1 review carry's whole point).
    const SECTION_LOCK = "the shared section is pinned";
    const collide: TemplateContract = {
      docType: "TRAVELER", name: "Collide",
      sections: [
        {
          key: "shared", name: "Shared section", hideable: false, reorderable: true,
          lockReason: SECTION_LOCK,
          fields: [{ key: "shared", name: "Shared field", defaultLabel: "", removable: true }],
        },
      ],
      textBlocks: [], formats: {},
      fonts: { family: "Roboto", baseSize: 8, headingSize: 12, smallSize: 6 },
    };
    const idx = lockIndex(collide);
    expect(idx.get("section:shared")).toBe(SECTION_LOCK); // the section is locked
    expect(idx.get("field:shared")).toBeUndefined();      // the same-keyed field is NOT
  });
});

describe("defense in depth — the server refuses a hand-built bad config", () => {
  it("refuses a config that hides a locked section (the traveler steps)", () => {
    // The UI disables the steps hide toggle, so this config is un-producible from the editor —
    // but if one reached the server anyway, validateConfig refuses it (spec §5.6).
    const bad = toggleSectionVisible(traveler(), "steps");
    expect(sectionVisible(bad, "steps")).toBe(false);
    expect(() => validateConfig("TRAVELER", bad)).toThrow(TemplateConfigError);
  });

  it("refuses a config that hides a locked field (the traveler barcode)", () => {
    const bad = toggleFieldVisible(traveler(), "header", "barcode");
    expect(() => validateConfig("TRAVELER", bad)).toThrow(TemplateConfigError);
  });

  it("the invoice contract has no format-knob drift — every default validates round-trip", () => {
    expect(() => validateConfig("INVOICE", invoice())).not.toThrow();
    expect(INVOICE_CONTRACT.formats.negativeStyle).toBeDefined();
  });
});

describe("resolveSaveError — the save-conflict state machine (Task 18)", () => {
  it("a 409 asks the caller to roll back to server truth THEN show the stale-draft banner", () => {
    // The one status that earns the reload-vs-overwrite treatment. The action name encodes the
    // HANDOFF §5.13 ordering: the caller reloads FIRST, then shows `message` (a reload after the
    // banner is set would wipe it). The server's own 409 wording is ignored in favour of one that
    // describes what the editor has already done (auto-reloaded) and offers re-apply.
    const r = resolveSaveError(
      409, "The draft changed since you loaded it — reload the editor and re-apply your changes");
    expect(r.action).toBe("reload-then-conflict");
    expect(r.message).toBe(STALE_DRAFT_MESSAGE);
  });

  it("every non-409 failure surfaces its own message with NO reload path", () => {
    // A 400 from validateConfig, a 403, a 404, a 500, and a network error (null status) all take
    // the plain-error branch — only the stale-precondition 409 reloads (brief §3).
    for (const status of [400, 403, 404, 500, null]) {
      const r = resolveSaveError(status, "the server's own message");
      expect(r.action).toBe("error");
      expect(r.message).toBe("the server's own message");
    }
  });
});

describe("resolveSaveSettle — the edit-epoch gate at a save's two settle points (Group D Task 8)", () => {
  it("save-success with an intervening apply keeps dirty: the outcome is withheld, the precondition still advances", () => {
    // apply() bumped the edit epoch while the PATCH was in flight, so the save's ticket is no
    // longer current: marking the editor clean/Saved would falsely claim the newer edits were
    // written (the user navigates away, work lost). The precondition (updatedAt) DID genuinely
    // advance server-side, so freshening it is always safe — and required for the next save.
    const d = resolveSaveSettle(true);
    expect(d.freshenPrecondition).toBe(true);
    expect(d.applyOutcome).toBe(false); // dirty stays true, Save stays live
  });

  it("409-rollback with an intervening apply skips the config reset and the conflict banner", () => {
    // The same decision at the OTHER settle point: an apply() during the rollback fetch means the
    // user has moved on (the exact semantics apply's conflict-dismissal already claims), so the
    // fetched config must NOT replace what they typed and no banner blames another editor —
    // updatedAt/logo meta are still freshened from the fetch.
    const d = resolveSaveSettle(true);
    expect(d.freshenPrecondition).toBe(true);
    expect(d.applyOutcome).toBe(false); // no setConfig, no setDirty(false), no conflict banner
  });

  it("with no intervening edit, both settle points apply their outcome in full", () => {
    const d = resolveSaveSettle(false);
    expect(d.freshenPrecondition).toBe(true);
    expect(d.applyOutcome).toBe(true); // success marks clean/Saved; the 409 path resets + banners
  });
});

describe("widthBudgetError — early-disable Save on an over-budget config (Task 18 minor)", () => {
  it("returns null for a within-budget working config (Save is not blocked)", () => {
    expect(widthBudgetError(TRAVELER_CONTRACT, traveler())).toBeNull();
  });

  it("names the over-budget table — the SAME config the server's validateConfig refuses", () => {
    // 300 + 78 (line_each_weight) + 300 = 678 > the 564 "lines" budget — every field width stays
    // <=564, so this is the budget rule, not a per-field shape cap (mirrors the tableBudgets test).
    const bad = setFieldWidth(
      setFieldWidth(traveler(), "lines", "line_qty", 300), "lines", "line_weight", 300);
    const reason = widthBudgetError(TRAVELER_CONTRACT, bad);
    expect(reason).not.toBeNull();
    expect(reason).toContain("lines");
    // Client early-disable and server backstop agree on the same config (spec §5.6 defense-in-depth).
    expect(() => validateConfig("TRAVELER", bad)).toThrow(TemplateConfigError);
  });
});

describe("the printed-width budget: the traveler steps table (#450; #991 owner ruling R-B)", () => {
  const instructionAt = (width: number) => setFieldWidth(traveler(), "steps", "step_instruction", width);
  const codeAt = (width: number) => setFieldWidth(traveler(), "steps", "step_code", width);
  const warn = (config: TemplateConfig) => printedWidthWarning(TRAVELER_CONTRACT, config, "steps");
  const refusal = (config: TemplateConfig) => widthBudgetError(TRAVELER_CONTRACT, config);

  it("accepts the default config, a table that fits, and one at exactly the content width", () => {
    for (const config of [traveler(), instructionAt(350), instructionAt(350.4)]) {
      expect(refusal(config)).toBeNull();
      expect(() => validateConfig("TRAVELER", config)).not.toThrow();
      // The steps table never warns: its title spans its instruction column, so no heading word is judged.
      expect(warn(config)).toBeNull();
    }
  });

  it("refuses, with the figures, once a fixed instruction width takes the table past it, where #450 warned", () => {
    const sentence = 'The "steps" table needs 564.6pt on paper (539pt of column widths, 25.6pt of cell padding and rules), ' +
      "more than its 564pt budget: its fixed columns alone would print past the page. Narrow a column, or empty the Step " +
      "instruction box to make it flex.";
    expect(refusal(instructionAt(351))).toBe(sentence);
    expect(() => validateConfig("TRAVELER", instructionAt(351))).toThrow(sentence);
    expect(warn(instructionAt(351))).toBeNull();
  });

  it("counts one grid step for a flexible instruction", () => {
    // 16 + 407.5 + 34 + 30 + 46 = 533.5, 25.6 of padding and rules and 4.5 for the instruction: 563.6.
    expect(refusal(codeAt(407.5))).toBeNull();
    expect(refusal(codeAt(408.5))).toBe(
      'The "steps" table needs 564.6pt on paper (534.5pt of column widths, 25.6pt of cell padding and rules, and 4.5pt ' +
      "for its flexible column), more than its 564pt budget: its fixed columns and their cell padding and rules leave its " +
      "flexible column less than 4.5pt. Narrow a column.");
  });

  it("gives the same figure whatever order the step columns are in", () => {
    const moved = instructionAt(351);
    const section = moved.sections.find((s) => s.key === "steps")!;
    const order = ["steps_title", "step_instruction", "step_values", "step_eq", "step_op", "step_date", "step_position", "step_code"];
    section.fields = order.map((key) => section.fields.find((f) => f.key === key)!);
    expect(refusal(moved)).toMatch(/^The "steps" table needs 564\.6pt on paper/);
  });
});

/** A column edit through the editor's own primitives: a number types a width, null empties the
 *  box, "hidden" unticks the column. */
type ColumnEdit = number | null | "hidden";

/** `docType`'s built-in config with `edits` made to `section`'s columns. */
function edited(docType: TemplateDocTypeString, section: string, edits: Record<string, ColumnEdit>): TemplateConfig {
  let config = defaultConfigFor(docType);
  for (const [key, edit] of Object.entries(edits)) {
    if (!config.sections.find((s) => s.key === section)?.fields.some((f) => f.key === key)) {
      throw new Error(`${docType} ${section} has no field ${key}`);
    }
    config = edit === "hidden" ? toggleFieldVisible(config, section, key) : setFieldWidth(config, section, key, edit);
  }
  return config;
}

const warnOn = (docType: TemplateDocTypeString, config: TemplateConfig, table: string) =>
  printedWidthWarning(contractFor(docType), config, table);

/** Every column table of `docType`'s contract. */
const tablesOf = (docType: TemplateDocTypeString) =>
  [...new Set(contractFor(docType).sections.flatMap((s) => s.fields.flatMap((f) => (f.column ? [f.column.table] : []))))];

const TICKETS = ["SHIPPER", "MOS_SHIPPER"] as const;

describe("the printed-width budget and the heading warning: every other table (#457; #991 owner rulings)", () => {
  it("refuses nothing and warns of nothing for any table of any built-in config", () => {
    let tables = 0;
    for (const docType of TEMPLATE_DOC_TYPES) {
      expect(widthBudgetError(contractFor(docType), defaultConfigFor(docType)), docType).toBeNull();
      for (const table of tablesOf(docType)) {
        expect(warnOn(docType, defaultConfigFor(docType), table), `${docType} ${table}`).toBeNull();
        tables++;
      }
    }
    // Every column table of the eight contracts: none is skipped by an empty loop.
    expect(tables).toBe(15);
  });

  /** One table at its exact fit, which is accepted (no "*" column shown, so no grid step), and one step over it,
   *  which is refused; `warning.printed` is the figure the refusal names. */
  type FitCase = {
    name: string; docType: TemplateDocTypeString; section: string; table: string;
    fit: Record<string, ColumnEdit>; over: Record<string, ColumnEdit>;
    warning: { printed: number; over: number; message: string };
  };
  const FIT_CASES: FitCase[] = [
    {
      name: "the cert's parts, ruled: 70 + 90 + Part identity", docType: "CERT", section: "parts", table: "parts",
      fit: { part_identity: 380 }, over: { part_identity: 381 },
      warning: {
        printed: 565, over: 1,
        message: "On paper the “parts” table is 565pt wide: 541pt of column widths plus 24pt of cell padding. " +
          "That is 1pt wider than the 564pt content width, so the table runs past it toward the right margin. " +
          "You can still save. Narrow a column, or empty the Part identity box to make it flex.",
      },
    },
    ...(["INVOICE", "QUOTE"] as const).map((docType): FitCase => ({
      name: `the ${docType === "INVOICE" ? "invoice's" : "quote's"} columns, boxed: 52 + 66 + 84 + the information column`,
      docType, section: "column_header", table: "columns",
      fit: { col_info: 326 }, over: { col_info: 327 },
      warning: {
        printed: 565, over: 1,
        message: "On paper the “columns” table is 565pt wide: 529pt of column widths plus 36pt of cell padding " +
          "and rules. That is 1pt wider than the 564pt content width, so the table runs past it toward the right " +
          "margin. You can still save. Narrow a column, or empty the Information column box to make it flex.",
      },
    })),
    {
      name: "the statement's aging, boxed: six buckets at 72 and Net", docType: "STATEMENT", section: "aging", table: "aging",
      fit: {
        aging_current: 72, aging_1_30: 72, aging_31_60: 72, aging_61_90: 72, aging_90_plus: 72, aging_unapplied: 72,
        aging_net: 69.6,
      },
      over: {
        aging_current: 72, aging_1_30: 72, aging_31_60: 72, aging_61_90: 72, aging_90_plus: 72, aging_unapplied: 72,
        aging_net: 69.7,
      },
      warning: {
        printed: 564.1, over: 0.1,
        // Seven flex columns typed: more than two to name.
        message: "On paper the “aging” table is 564.1pt wide: 501.7pt of column widths plus 62.4pt of cell padding " +
          "and rules. That is 0.1pt wider than the 564pt content width, so the table runs past it toward the right " +
          "margin. You can still save. Narrow a column, or empty the box of a column that was flex to make it flex.",
      },
    },
    ...TICKETS.flatMap((docType): FitCase[] => [
      {
        name: `the ${docType} field strip, boxed: 110 + 70 + 85 + the two flex columns`, docType,
        section: "field_strip", table: "field_strip",
        fit: { po_number: 127, packing_list_no: 127.2 }, over: { po_number: 127, packing_list_no: 128.2 },
        warning: {
          printed: 565, over: 1,
          message: "On paper the “field_strip” table is 565pt wide: 520.2pt of column widths plus 44.8pt of cell " +
            "padding and rules. That is 1pt wider than the 564pt content width, so the table runs past it toward " +
            "the right margin. You can still save. Narrow a column, or empty the Purchase order or Packing list " +
            "number box to make it flex.",
        },
      },
      {
        name: `the ${docType} lines, ruled: 70 + 90 + Part identity`, docType, section: "lines", table: "lines",
        fit: { line_part: 380 }, over: { line_part: 381 },
        warning: {
          printed: 565, over: 1,
          message: "On paper the “lines” table is 565pt wide: 541pt of column widths plus 24pt of cell padding. " +
            "That is 1pt wider than the 564pt content width, so the table runs past it toward the right margin. " +
            "You can still save. Narrow a column, or empty the Part identity box to make it flex.",
        },
      },
      {
        // S6: the owner's sentence for the table that prints twice.
        name: `the ${docType} container table, ruled and printed twice: 80 + 62 + Containers and Tare typed`, docType,
        section: "containers", table: "containers",
        fit: { container_count: 54, container_tare: 54 }, over: { container_count: 55, container_tare: 55 },
        warning: {
          printed: 284, over: 2,
          message: "On paper each half of the “containers” table is 284pt wide: 252pt of column widths plus 32pt " +
            "of cell padding. That is 2pt wider than the 282pt each half has, so the table runs 4pt past the right " +
            "margin. You can still save. Narrow a column, or empty the Containers or Tare box to make it flex.",
        },
      },
    ]),
    {
      // S5: the freight table has 386pt beside the sidebar, not the 564pt content width.
      name: "the bill of lading's freight table, boxed: 40 + 62 + 44 + 42 + Freight description", docType: "BOL",
      section: "freight", table: "freight",
      fit: { freight_description: 153.2 }, over: { freight_description: 154 },
      warning: {
        printed: 386.8, over: 0.8,
        message: "On paper the “freight” table is 386.8pt wide: 342pt of column widths plus 44.8pt of cell padding " +
          "and rules. That is 0.8pt wider than the 386pt it has beside the sidebar, so the sidebar is pushed 0.8pt " +
          "past the right margin. You can still save. Narrow a column, or empty the Freight description box to " +
          "make it flex.",
      },
    },
    {
      name: "the traveler's inspections, a borderless table in one box: 55 + 48 + 48 + 72 + the two flex columns",
      docType: "TRAVELER", section: "inspections", table: "inspections",
      fit: { inspection_code: 145.7, inspection_location: 145.7 }, over: { inspection_code: 146, inspection_location: 146 },
      warning: {
        printed: 564.6, over: 0.6,
        message: "On paper the “inspections” table is 564.6pt wide: 515pt of column widths plus 49.6pt of cell " +
          "padding and rules. That is 0.6pt wider than the 564pt content width, so the table runs past it toward " +
          "the right margin. You can still save. Narrow a column, or empty the Inspection code or Location box to " +
          "make it flex.",
      },
    },
    {
      name: "the traveler's lines, ruled: 78 + 78 + 88 + Part identity", docType: "TRAVELER", section: "lines", table: "lines",
      fit: { line_part: 288 }, over: { line_part: 289 },
      warning: {
        printed: 565, over: 1,
        message: "On paper the “lines” table is 565pt wide: 533pt of column widths plus 32pt of cell padding. " +
          "That is 1pt wider than the 564pt content width, so the table runs past it toward the right margin. " +
          "You can still save. Narrow a column, or empty the Part identity box to make it flex.",
      },
    },
    {
      name: "the traveler's quantities, ruled: 78 + 78 + 88 + 78 + 88 + Container", docType: "TRAVELER",
      section: "quantities", table: "quantities",
      fit: { container: 106 }, over: { container: 107 },
      warning: {
        printed: 565, over: 1,
        message: "On paper the “quantities” table is 565pt wide: 517pt of column widths plus 48pt of cell padding. " +
          "That is 1pt wider than the 564pt content width, so the table runs past it toward the right margin. " +
          "You can still save. Narrow a column, or empty the Container box to make it flex.",
      },
    },
  ];

  it.each(FIT_CASES)("accepts the exact fit and refuses one step over it, where #457 warned: $name", (c) => {
    const fit = edited(c.docType, c.section, c.fit);
    expect(widthBudgetError(contractFor(c.docType), fit)).toBeNull();
    expect(() => validateConfig(c.docType, fit)).not.toThrow();
    expect(warnOn(c.docType, fit, c.table)).toBeNull();
    const over = edited(c.docType, c.section, c.over);
    const sentence = widthBudgetError(contractFor(c.docType), over);
    expect(sentence).toMatch(new RegExp(`^The "${c.table}" table needs ${c.warning.printed}pt on paper `));
    expect(() => validateConfig(c.docType, over)).toThrow(sentence!);
    // The refusal speaks; the warning does not repeat it.
    expect(warnOn(c.docType, over, c.table)).toBeNull();
  });

  it("states the owner's #457 examples as refusals, word for word", () => {
    expect(widthBudgetError(CERT_CONTRACT, edited("CERT", "parts", { part_identity: 404 }))).toBe(
      'The "parts" table needs 588pt on paper (564pt of column widths, 24pt of cell padding), more than its ' +
      "564pt budget: its fixed columns alone would print past the page. Narrow or hide a column.");
    expect(widthBudgetError(contractFor("BOL"), edited("BOL", "freight", { freight_description: 198 }))).toBe(
      'The "freight" table needs 430.8pt on paper (386pt of column widths, 44.8pt of cell padding and rules), more than ' +
      "the 386pt it has beside the sidebar: its fixed columns alone would print past the page. Narrow or hide a column.");
    for (const docType of TICKETS) {
      expect(widthBudgetError(contractFor(docType), edited(docType, "containers", { container_count: 60, container_tare: 60 })), docType).toBe(
        'The "containers" table needs 294pt on paper (262pt of column widths each half, 32pt of cell padding), ' +
        "more than the 282pt each half has: its fixed columns alone would print past the page. Narrow or hide a column.");
    }
  });

  it("counts one grid step where a flexible column is shown", () => {
    // 265.5 + 70 typed beside the flexible identity... the part quantity and pounds: 535.5, 24 and 4.5: 564.
    expect(widthBudgetError(CERT_CONTRACT, edited("CERT", "parts", { part_qty: 265.5, part_pounds: 270 }))).toBeNull();
    expect(widthBudgetError(CERT_CONTRACT, edited("CERT", "parts", { part_qty: 266, part_pounds: 270 }))).toBe(
      'The "parts" table needs 564.5pt on paper (536pt of column widths, 24pt of cell padding, and 4.5pt for its ' +
      "flexible column), more than its 564pt budget: its fixed columns and their cell padding leave its flexible column " +
      "less than 4.5pt. Narrow or hide a column.");
  });

  it("names the 4.5 pt band's flexible columns in the plural where more than one is shown (#991 review)", () => {
    // The ticket's containers: Container Type 188 + 62 and 32 of padding fill the 282 pt half; Containers and Tare share.
    for (const docType of TICKETS) {
      expect(widthBudgetError(contractFor(docType), edited(docType, "containers", { container_type: 188 })), docType).toBe(
        'The "containers" table needs 286.5pt on paper (250pt of column widths each half, 32pt of cell padding, and 4.5pt ' +
        "for its flexible columns), more than the 282pt each half has: its fixed columns and their cell padding leave its " +
        "flexible columns less than 4.5pt. Narrow or hide a column.");
    }
    // Tare hidden, Containers alone shares (196 + 62 and 24 of padding fill the half): the singular.
    const one = edited("SHIPPER", "containers", { container_tare: "hidden", container_type: 196 });
    expect(widthBudgetError(contractFor("SHIPPER"), one)).toMatch(
      /4\.5pt for its flexible column\), .* leave its flexible column less than 4\.5pt\. Narrow or hide a column\.$/);
  });

  it("refuses the invoice's totals lines once their label, gaps and the Amount column pass the page (#991 review F1)", () => {
    // The totals print a 200 pt label and the Amount column's width beside a "*" spacer, two 6 pt gaps apart: 352 fits.
    const amountAt = (width: number) => edited("INVOICE", "column_header", { col_amount: width });
    expect(widthBudgetError(INVOICE_CONTRACT, amountAt(352))).toBeNull();
    const sentence = "The totals lines need 565pt on paper (the 353pt Amount column beside their 212pt label and gaps), more " +
      "than the 564pt content width: they would print past the page. Narrow the Amount column.";
    expect(widthBudgetError(INVOICE_CONTRACT, amountAt(353))).toBe(sentence);
    expect(() => validateConfig("INVOICE", amountAt(353))).toThrow(sentence);
    // A hidden Amount column prints the totals at the contract's 84, and hidden totals print nothing.
    expect(printedBudgetRefusals(INVOICE_CONTRACT, edited("INVOICE", "column_header", { col_amount: "hidden" }))).toEqual([]);
    expect(printedBudgetRefusals(INVOICE_CONTRACT, toggleSectionVisible(amountAt(353), "totals"))).toEqual([]);
    // The quote prints no such lines.
    expect(printedBudgetRefusals(contractFor("QUOTE"), edited("QUOTE", "column_header", { col_amount: 353 }))).toEqual([]);
  });

  it("judges a hidden section on nothing, and leaves a table over its declared budget to that refusal", () => {
    const hidden = toggleSectionVisible(edited("CERT", "parts", { part_identity: 381 }), "parts");
    expect(widthBudgetError(CERT_CONTRACT, hidden)).toBeNull();
    const over = edited("CERT", "parts", { part_identity: 405 });
    expect(widthBudgetError(CERT_CONTRACT, over)).toMatch(/^Over the column-width budget — parts totals 565pt of 564pt/);
    expect(warnOn("CERT", over, "parts")).toBeNull();
  });

  it("refuses nothing on a canvas config and leaves it to the canvas's warnings", () => {
    const flow = edited("TRAVELER", "quantities", { order_qty: 150 });
    expect(warnOn("TRAVELER", flow, "quantities")).not.toBeNull();
    const canvas = { ...flow, layout: { version: 1 as const, items: [] } };
    expect(warnOn("TRAVELER", canvas, "quantities")).toBeNull();
    const past = edited("CERT", "parts", { part_identity: 404 });
    expect(printedBudgetRefusals(CERT_CONTRACT, { ...past, layout: { version: 1 as const, items: [] } })).toEqual([]);
    expect(printedBudgetRefusals(CERT_CONTRACT, past).map((p) => p.table)).toEqual(["parts"]);
  });

  it("speaks of the content width only for a table whose budget it is", () => {
    // The two tables with a budget of their own have their own sentences: the bill of lading's
    // freight table (beside the sidebar) and the ticket's container table (printed twice).
    const own = new Set(["BOL freight", "SHIPPER containers", "MOS_SHIPPER containers"]);
    for (const docType of TEMPLATE_DOC_TYPES) {
      for (const table of tablesOf(docType)) {
        const budget = contractFor(docType).tableBudgets?.[table];
        expect(budget === undefined, `${docType} ${table}`).toBe(!own.has(`${docType} ${table}`));
        if (own.has(`${docType} ${table}`)) continue;
        expect(COLUMN_TABLE_LAYOUTS[docType][table].copies, `${docType} ${table}`).toBe(1);
      }
    }
    expect(CONTENT_WIDTH).toBe(564);
  });
});

/** Containers and Tare's share (#519): the notice keeps its share line; its 39 pt warning and its "not measured" note
 *  are retired (owner ruling R-A, 2026-11-17, #991). */
describe.each(TICKETS)("sharedWidthNotice: the %s container table's shared width (#519, R-A)", (docType) => {
  const contract = contractFor(docType);
  const notice = (config: TemplateConfig) => sharedWidthNotice(contract, config, "containers");
  const typeAt = (width: number) => edited(docType, "containers", { container_type: width });

  it("states the share alone, at the built-in widths and at any font", () => {
    expect(notice(defaultConfigFor(docType))).toEqual({ share: "Containers and Tare get 54 pt each." });
    expect(notice(setFonts(defaultConfigFor(docType), { baseSize: 12 }))).toEqual({ share: "Containers and Tare get 54 pt each." });
  });

  it("writes a share under 39 pt with two decimals, so it never reads 39, and warns of nothing", () => {
    expect(notice(typeAt(110))).toEqual({ share: "Containers and Tare get 39 pt each." });
    expect(notice(typeAt(111))).toEqual({ share: "Containers and Tare get 38.5 pt each." });
    expect(notice(typeAt(110.1))).toEqual({ share: "Containers and Tare get 38.95 pt each." });
    expect(notice(typeAt(110.05))).toEqual({ share: "Containers and Tare get 38.97 pt each." });
    expect(notice(typeAt(110.004))).toEqual({ share: "Containers and Tare get 38.99 pt each." });
  });

  it("names one shared column in the singular", () => {
    expect(notice(edited(docType, "containers", { container_tare: "hidden" }))).toEqual({ share: "Containers gets 116 pt." });
    expect(notice(edited(docType, "containers", { container_count: "hidden", container_type: 180 }))).toEqual({ share: "Tare gets 16 pt." });
  });

  it("gives no share once one copy's printed width passes its half, where the refusal speaks", () => {
    expect(notice(typeAt(188))).toEqual({ share: "Containers and Tare get 0 pt each." });
    expect(notice(typeAt(189))).toBeNull();
    expect(widthBudgetError(contract, typeAt(189))).toMatch(/^The "containers" table needs /);
  });

  it("is null when no shown column shares, or the section is hidden, or for another table", () => {
    expect(notice(edited(docType, "containers", { container_count: 54, container_tare: 54 }))).toBeNull();
    expect(notice(toggleSectionVisible(defaultConfigFor(docType), "containers"))).toBeNull();
    for (const table of ["field_strip", "lines", "steps"]) {
      expect(sharedWidthNotice(contract, defaultConfigFor(docType), table), table).toBeNull();
    }
  });

  it("leaves the heading warning the one amber line under the container table", () => {
    // 38.5 pt each, under the 38.91 pt "Containers" needs.
    expect(warnOn(docType, typeAt(111), "containers")?.message).toMatch(
      /^On paper each half of the “containers” table shares what its fixed columns leave: Containers and Tare get 38\.5 pt each, under the 38\.91 pt /);
    expect(warnOn(docType, typeAt(110.1), "containers")).toBeNull();
  });
});

describe("sharedWidthNotice: no other document's tables (#519)", () => {
  it("is null for every table of a document that is not a shipping ticket", () => {
    for (const docType of TEMPLATE_DOC_TYPES.filter((d) => d !== "SHIPPER" && d !== "MOS_SHIPPER")) {
      for (const table of [...tablesOf(docType), "containers"]) {
        expect(sharedWidthNotice(contractFor(docType), defaultConfigFor(docType), table), `${docType} ${table}`).toBeNull();
      }
    }
  });
});

describe("previewRecordSpec — the picker's docType → record-type mapping (Task 19)", () => {
  it("covers every docType with a list endpoint and a list permission", () => {
    for (const docType of TEMPLATE_DOC_TYPES) {
      const spec = previewRecordSpec(docType);
      expect(spec.listPath).toMatch(/^\/api\//);
      expect(spec.listPermission).toMatch(/\.view$/);
      expect(spec.noun.length).toBeGreaterThan(0);
    }
  });

  it("maps each type to the right record and list route", () => {
    expect(previewRecordSpec("TRAVELER")).toMatchObject({ kind: "order", listPath: "/api/orders", listPermission: "orders.view" });
    expect(previewRecordSpec("BOL")).toMatchObject({ kind: "shipment", listPath: "/api/shippers", listPermission: "shipping.view" });
    expect(previewRecordSpec("CERT")).toMatchObject({ kind: "cert", listPath: "/api/certs", listPermission: "certs.view" });
    expect(previewRecordSpec("INVOICE")).toMatchObject({ kind: "invoice", listPath: "/api/invoices", listPermission: "invoicing.view" });
    expect(previewRecordSpec("QUOTE")).toMatchObject({ kind: "quote", listPath: "/api/quotes", listPermission: "quotes.view" });
  });

  it("splits shipments by order count — SHIPPER single, MOS_SHIPPER multi — both on /api/shippers", () => {
    const single = previewRecordSpec("SHIPPER");
    const multi = previewRecordSpec("MOS_SHIPPER");
    expect(single).toMatchObject({ kind: "shipment-single", orderCount: "single", listPermission: "shipping.view" });
    expect(multi).toMatchObject({ kind: "shipment-multi", orderCount: "multi", listPermission: "shipping.view" });
  });

  it("statement's record is a CUSTOMER, listed via /api/customers (customers.view) — distinct from the preview's receivables gate", () => {
    expect(previewRecordSpec("STATEMENT")).toMatchObject({
      kind: "customer", listPath: "/api/customers", listPermission: "customers.view",
    });
  });
});

/**
 * #239 P1b — the preview picker composed its copy as `a {noun}`, which reads "a order" on the
 * traveler and "a invoice or credit" on the invoice: two of the eight docTypes, and the two an
 * admin opens first. The article belongs to the phrase, not to the noun, so the nouns above stay
 * exactly as they are and the article is computed beside them.
 */
describe("withArticle — the preview picker's indefinite article (P1b)", () => {
  it("chooses 'an' before a vowel and 'a' otherwise", () => {
    expect(withArticle("order")).toBe("an order");
    expect(withArticle("invoice or credit")).toBe("an invoice or credit");
    expect(withArticle("shipment")).toBe("a shipment");
    expect(withArticle("quote")).toBe("a quote");
  });

  it("reads correctly for every docType the picker offers", () => {
    // The whole set, in docType order — the assertion is the rendered English, so a helper that
    // regressed on ONE noun cannot hide behind the seven it still gets right.
    expect(TEMPLATE_DOC_TYPES.map((t) => withArticle(previewRecordSpec(t).noun))).toEqual([
      "an order",
      "a single-order shipment",
      "a multi-order shipment",
      "a shipment",
      "a certification",
      "an invoice or credit",
      "a customer",
      "a quote",
      "an order",
    ]);
  });
});

describe("the preview pane composes its copy through the helper (source pin, P1b)", () => {
  // The pane is a client component whose picker never renders without a landed fetch, so the
  // rule is pinned where it is written (the rail-fit precedent).
  const src = readFileSync(
    fileURLToPath(new URL("../src/app/admin/templates/[id]/edit/PreviewPane.tsx", import.meta.url)),
    "utf8",
  );

  it("writes no bare article before the noun", () => {
    expect(src).not.toContain("a {spec.noun}");
  });

  it("uses the helper at both sites that take an article — the picker and the permission notice", () => {
    expect(src).toContain('from "@/lib/template-editor"');
    expect(src.split("withArticle(spec.noun)").length - 1).toBe(2);
  });
});

describe("parseMeasure — the live page's measure, read from X-Preview-Measure (PR C of #926, Task 6)", () => {
  const measure: CanvasMeasure = {
    pages: 2,
    tables: [{ key: "steps", page: 1, top: 310.5, height: 420 }],
    regions: [{ after: "steps", page: 2, top: 96, height: 120.25 }],
    items: [{ id: "barcode", page: 1, left: 402, top: 36, height: 44 }],
  };
  it("round-trips the route's own encoding", () => {
    expect(parseMeasure(encodeURIComponent(JSON.stringify(measure)))).toEqual(measure);
  });
  it("answers null for no header, for garbage and for a JSON of the wrong shape", () => {
    expect(parseMeasure(null)).toBeNull();
    expect(parseMeasure("")).toBeNull();
    expect(parseMeasure("%E0%A4%A")).toBeNull();
    expect(parseMeasure("not json")).toBeNull();
    expect(parseMeasure(encodeURIComponent("null"))).toBeNull();
    expect(parseMeasure(encodeURIComponent("[]"))).toBeNull();
    expect(parseMeasure(encodeURIComponent(JSON.stringify({ ...measure, pages: "2" })))).toBeNull();
    for (const key of ["tables", "regions", "items"] as const) {
      expect(parseMeasure(encodeURIComponent(JSON.stringify({ ...measure, [key]: {} })))).toBeNull();
      const { [key]: _dropped, ...rest } = measure;
      void _dropped;
      expect(parseMeasure(encodeURIComponent(JSON.stringify(rest)))).toBeNull();
    }
  });
});

describe("the live page runs itself under autoRun (source pin, PR C of #926, Task 6)", () => {
  // The pane is a client component vitest does not mount, so the run's shape is pinned where it is
  // written: an effect on the config debounced 400 ms, one latest-gate ticket per run, the Generate
  // button only without autoRun, and the measure handed up after an answer and cleared after a failure.
  const src = readFileSync(
    fileURLToPath(new URL("../src/app/admin/templates/[id]/edit/PreviewPane.tsx", import.meta.url)),
    "utf8",
  );
  it("runs from an effect on the debounced config, through a latest gate", () => {
    expect(src).toContain("useDebouncedValue(config, 400)");
    expect(src).toContain("makeLatestGate()");
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(!autoRun\) return;\s*void runPreview\(debouncedConfig\);/);
    expect(src).toContain("[autoRun, debouncedConfig, runPreview]");
  });
  it("gates both landings on the run's own ticket", () => {
    const run = src.slice(src.indexOf("const runPreview"), src.indexOf("}, [", src.indexOf("const runPreview")));
    expect(run).toContain("const ticket = gate.current.next();");
    expect(run.split("gate.current.isCurrent(ticket)").length - 1).toBeGreaterThanOrEqual(3);
    expect(run).toContain('onMeasure?.(parseMeasure(res.headers.get("X-Preview-Measure")))');
    expect(run).toContain("onMeasure?.(null)");
    expect(run).not.toContain("config,");
  });
  it("revokes and clears its page when the record is cleared under autoRun (ruling C19)", () => {
    const clear = src.slice(src.indexOf("if (!autoRun || recordId) return;"));
    expect(clear.length).toBeLessThan(src.length);
    const body = clear.slice(0, clear.indexOf("}, [autoRun, recordId]);"));
    expect(body).toContain("URL.revokeObjectURL(urlRef.current)");
    expect(body).toContain("urlRef.current = null;");
    expect(body).toContain("setPreviewUrl(null);");
    expect(body).toContain("setError(null);");
  });
  it("says Rendering the page… under autoRun while a run is out (the Generate button's word is hidden there)", () => {
    expect(DESIGNER_WORDS.rendering).toBe("Rendering the page…");
    expect(src).toContain('{autoRun && rendering && <p role="status" className="mt-2 text-xs text-ink-500">{DESIGNER_WORDS.rendering}</p>}');
    expect(src.indexOf("{DESIGNER_WORDS.rendering}")).toBeLessThan(src.indexOf("<iframe title="));
  });
  it("gives the picker read a line of its own, which no run writes (P6)", () => {
    const run = src.slice(src.indexOf("const runPreview"), src.indexOf("}, [", src.indexOf("const runPreview")));
    expect(run).toContain("setError(null);");
    expect(run).not.toContain("setListError");
    expect(src).toContain('{listError && <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700" role="alert">{listError}</p>}');
  });
  it("hides Generate preview under autoRun and titles its page Live page", () => {
    expect(src).toContain("{!autoRun && (");
    expect(src).toContain('title={autoRun ? DESIGNER_WORDS.livePage : "Template preview"}');
    expect(DESIGNER_WORDS.livePage).toBe("Live page");
  });
});

describe("the canvas layout (PR C of #926)", () => {
  it("setLayout sets the layout, and null clears it, without mutating the input", () => {
    const before = traveler();
    const pristine = clone(before);
    const layout = standardLayout();
    const set = setLayout(before, layout);
    expect(set.layout).toEqual(layout);
    expect(set.sections).toEqual(before.sections);
    expect(before).toEqual(pristine);
    const cleared = setLayout(set, null);
    expect(cleared.layout).toBeNull();
    expect(set.layout).toEqual(layout);
  });
  it("canvasSaveBlock: null with no layout or an accepted one, the first refusal's sentence otherwise", () => {
    expect(canvasSaveBlock(TRAVELER_CONTRACT, traveler())).toBeNull();
    expect(canvasSaveBlock(TRAVELER_CONTRACT, setLayout(traveler(), standardLayout()))).toBeNull();
    const twoBarcodes = layoutOf([...standardLayout().items, barcode({ id: "barcode-2", box: { x: 402, y: 600, w: 186, h: 44 } })]);
    expect(canvasSaveBlock(TRAVELER_CONTRACT, setLayout(traveler(), twoBarcodes)))
      .toBe("The canvas has more than one barcode; a traveler prints exactly one (spec §8).");
  });
  it("canvasSaveBlock judges the page line's room by the config's own pageFooter", () => {
    const note = layoutOf([...standardLayout().items, {
      id: "note", kind: "text", text: "Signed", box: { x: 24, y: 748, w: 200, h: 12 },
      anchor: { kind: "page-top" }, repeat: false, style: { size: 8, bold: false, align: "left" },
    }]);
    const config = setLayout(traveler(), note);
    expect(canvasSaveBlock(TRAVELER_CONTRACT, setPageFooter(config, false))).toBeNull();
    expect(canvasSaveBlock(TRAVELER_CONTRACT, setPageFooter(config, true)))
      .toBe("The Text (text note) lies outside the page: its bottom edge is at 760 pt, past 748, where the page line's room begins.");
  });
});

describe("the seed request (PR C of #926, Task 5)", () => {
  it("carries the picked order's id and the working config with its layout set aside, the input untouched", () => {
    const working = setLayout(setPageFooter(traveler(), false), standardLayout());
    const pristine = clone(working);
    const body = seedRequest(working, "order-1");
    expect(body.recordId).toBe("order-1");
    expect(body.config.layout).toBeNull();
    expect({ ...body.config, layout: working.layout }).toEqual(working);
    expect(working).toEqual(pristine);
    expect(seedRequest(traveler(), "order-2")).toEqual({ recordId: "order-2", config: traveler() });
  });
  it("names a refusal by the route's own sentence, an unreadable answer and any other failure by the seed's own", () => {
    expect(seedFailureMessage(new ApiError("Order not found", 404))).toBe("Order not found");
    expect(seedFailureMessage(new UnreadableAnswerError(WRITE_ANSWER_UNREADABLE, { cause: new SyntaxError("x") })))
      .toBe(DESIGNER_WORDS.seedUnreadable);
    expect(DESIGNER_WORDS.seedUnreadable)
      .toBe("The canvas could not be read from the answer; nothing was changed. Try Design on a canvas again.");
    expect(seedFailureMessage(new TypeError("Failed to fetch"))).toBe(DESIGNER_WORDS.seedFailed);
    expect(seedFailureMessage("nope")).toBe(DESIGNER_WORDS.seedFailed);
    expect(DESIGNER_WORDS.seedFailed).toContain("nothing was changed");
  });
});

describe("the designer's pick nouns", () => {
  // canvas-designer.ts restates previewRecordSpec's nouns (template-editor.ts imports that leaf, so
  // the other way round would be a cycle); this holds the two from drifting.
  const withArticle = (noun: string) => `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
  it.each(["TRAVELER", "SHIPPER", "MOS_SHIPPER", "BOL", "CERT", "INVOICE", "STATEMENT", "QUOTE"] as const)("%s: the pick sentence names the Preview record's noun", (docType) => {
    expect(CANVAS_RECORD_WORDS[docType].pick).toBe(`Pick ${withArticle(previewRecordSpec(docType).noun)} in Preview first`);
  });
});

describe("editorWithholds and the label size words (container tag PR 1, Task 5)", () => {
  it("is all true for the container tag, and all false for every other contract", () => {
    expect(editorWithholds(CONTAINER_TAG_CONTRACT)).toEqual({ logo: true, pageFooter: true, smallSize: true });
    for (const docType of TEMPLATE_DOC_TYPES) {
      if (docType === "CONTAINER_TAG") continue;
      expect(editorWithholds(contractFor(docType))).toEqual({ logo: false, pageFooter: false, smallSize: false });
    }
  });
  it("names the one label stock", () => {
    expect(LABEL_SIZE_LABELS).toEqual({ "4x3-landscape": "4 in \u00d7 3 in, landscape" });
  });
});

describe("the panels honour the withheld controls (source pin, container tag PR 1, Task 5)", () => {
  const dir = "../src/app/admin/templates/[id]/edit/";
  const read = (f: string) => readFileSync(fileURLToPath(new URL(dir + f, import.meta.url)), "utf8");
  const panels = read("panels.tsx");
  const slice = (from: string, to: string) => panels.slice(panels.indexOf(from), panels.indexOf(to, panels.indexOf(from)));
  it("FontsPanel skips the small-size row when withheld", () => {
    const body = slice("export function FontsPanel", "export function TextBlocksPanel");
    expect(body).toContain("{!withholds.smallSize && sizeRow(\"Small text (pt)\", \"smallSize\")}");
  });
  it("FooterAndLogoPanel skips the page-line row when withheld, and renders nothing when both rows are", () => {
    const body = panels.slice(panels.indexOf("export function FooterAndLogoPanel"));
    expect(body).toContain("{!withholds.pageFooter && (");
    expect(body).toContain("if (withholds.pageFooter && withholds.logo) return null;");
  });
  it("TemplateEditor renders no LogoPanel when withheld", () => {
    const src = read("TemplateEditor.tsx");
    expect(src).toContain("{!withholds.logo && (");
    expect(src.slice(src.indexOf("{!withholds.logo && ("))).toMatch(/^\{!withholds\.logo && \(\s*<LogoPanel/);
  });
  it("FormatsPanel renders a Label size select when labelSize is declared, and its early return counts it", () => {
    const body = slice("export function FormatsPanel", "const sel");
    expect(body).toContain("declares.labelSize === undefined");
    const all = slice("export function FormatsPanel", "// Fonts");
    expect(all).toContain("{declares.labelSize !== undefined && (");
    expect(all).toContain('aria-label="Label size"');
  });
});

describe("Print no label (container tag, owner ruling 2026-11-13)", () => {
  const tagConfig = () => structuredClone(DEFAULT_TAG_CONFIG);
  const labelOf = (c: ReturnType<typeof tagConfig>, key: string) => c.sections[0].fields.find((f) => f.key === key)!.label;
  it("setFieldLabelBlank stores \"\" when checked and null (the default) when unchecked", () => {
    const blank = setFieldLabelBlank(tagConfig(), "tag", "order_number", true);
    expect(labelOf(blank, "order_number")).toBe("");
    const back = setFieldLabelBlank(blank, "tag", "order_number", false);
    expect(labelOf(back, "order_number")).toBeNull();
    expect(labelOf(blank, "po_number")).toBe(labelOf(tagConfig(), "po_number"));
  });
  it("a config carrying \"\" through the leaf prints 1234 for Order #", () => {
    const config = setFieldLabelBlank(tagConfig(), "tag", "order_number", true);
    const def = buildContainerTags([{ orderNumber: "1234", customer: "Acme", poNumber: "P", parts: ["A"], containersTotal: "1", received: "r" }], config);
    const stack = (def.content as unknown as { stack: { text: string }[] }[])[0].stack;
    expect(stack[0].text).toBe("1234");
  });
  it("only the container tag offers it", () => {
    expect(editorOffers(CONTAINER_TAG_CONTRACT)).toEqual({ blankLabels: true });
    for (const docType of TEMPLATE_DOC_TYPES) {
      if (docType === "CONTAINER_TAG") continue;
      expect(editorOffers(contractFor(docType))).toEqual({ blankLabels: false });
    }
  });
  it("panels.tsx renders the checkbox only under the flag, and closes the label box only under it", () => {
    const panels = readFileSync(fileURLToPath(new URL("../src/app/admin/templates/[id]/edit/panels.tsx", import.meta.url)), "utf8");
    const body = panels.slice(panels.indexOf("export function SectionsPanel"), panels.indexOf("export function FormatsPanel"));
    expect(body).toMatch(/\{offers\.blankLabels && \(\s*<label[^>]*>\s*<input type="checkbox" checked=\{f\.label === ""\}/);
    expect(body).toContain("setFieldLabelBlank(c, s.key, f.key, e.target.checked)");
    expect(body).toContain('disabled={disabled || (offers.blankLabels && f.label === "")}');
    expect(body).toContain("Print no label");
  });
});
