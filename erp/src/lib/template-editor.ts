/**
 * The template editor's PURE config-editing logic (Phase 7 Task 17) — every mutation the panels
 * make to a draft's `TemplateConfig`, plus the live width-budget check the editor surfaces before
 * the server's own `validateConfig` backstop refuses an over-budget config.
 *
 * CLIENT-SAFE BY CONTRACT: this file imports only from `./template-contracts/types`,
 * `./template-contracts/traveler`, `./template-contracts/canvas`, `./template-canvas`,
 * `./canvas-designer`, `./fetcher`, `./template-printed-width` and `./reorder`, never from
 * `src/server/**` — the editor is a client component and a server import
 * would drag Prisma / `node:async_hooks` into the browser bundle (the `permission-ui.ts`
 * precedent). It is also the node-testable half of the editor: the vitest harness has no DOM, so
 * the config mutations live HERE as pure functions unit-tested directly, and the panels are thin
 * wrappers proven in E2E.
 *
 * Every function returns a NEW `TemplateConfig` and never mutates its input (React state
 * discipline). The lock/budget RULES are enforced authoritatively by the contract machinery's
 * `validateContractConfig` (spec §5.6 — "the editor alone is not the enforcement"); the helpers
 * here keep the editor from PRODUCING a refused config (disabled controls) and show the width
 * error EARLY, but a config built by hand and sent to the server is still refused there.
 */
import {
  CONTENT_WIDTH,
  lockedElements,
  type ContractField,
  type ContractSection,
  type FieldConfig,
  type FontsConfig,
  type FormatsConfig,
  type LabelSize,
  type LockScope,
  type LogoPlacement,
  type SectionConfig,
  type TemplateConfig,
  type TemplateContract,
  type TemplateDocTypeString,
} from "./template-contracts/types";
import { printedBudgetProblems, type PrintedBudgetProblem } from "./template-contracts/printed-budget";
import { canvasPageFor, type CanvasLayout } from "./template-contracts/canvas";
import { canvasRefusal, type CanvasMeasure } from "./template-canvas";
import { DESIGNER_WORDS } from "./canvas-designer";
import { ApiError, UnreadableAnswerError } from "./fetcher";
import {
  sharedContainerWidth, sharedWidthWords,
  tableHeadingWidth,
  tablePrintedWidth,
} from "./template-printed-width";
import { moveGate, swapAt } from "./reorder";

/** A logo default width in points — a header mark, well within the content width. Used when the
 *  user first picks a placement (bytes are uploaded separately, via the logo route). */
export const DEFAULT_LOGO_WIDTH = 120;

// ---------------------------------------------------------------------------------------------
// Locked-element lookup — what the panels render padlocks from
// ---------------------------------------------------------------------------------------------

/** The namespaced key a `lockIndex` entry lives under — a section and a field can share a key
 *  (each is only unique within its own kind), so the map is keyed by scope, never key alone. */
export function lockKey(scope: LockScope, key: string): string {
  return `${scope}:${key}`;
}

/**
 * The `(scope, key) -> lock reason` map the editor keys its padlocks off of, built from the
 * contract's own `lockedElements` (spec §5.6) — so the reason the padlock shows and the reason the
 * server quotes when it refuses a hiding/reorder are the SAME string, one source. Keyed by scope
 * (`lockKey`) because a locked section and a free field may share a key: a bare-key map would
 * render one an ambiguous padlock (the Task 1 review carry the namespace tightening closed). A
 * missing entry means "not locked" — the control is free (subject only to the edit permission).
 */
export function lockIndex(contract: TemplateContract): Map<string, string> {
  const index = new Map<string, string>();
  for (const el of lockedElements(contract)) index.set(lockKey(el.scope, el.key), el.reason);
  return index;
}

// ---------------------------------------------------------------------------------------------
// Immutable update primitives
// ---------------------------------------------------------------------------------------------

function updateSection(
  config: TemplateConfig, sectionKey: string, fn: (s: SectionConfig) => SectionConfig,
): TemplateConfig {
  return { ...config, sections: config.sections.map((s) => (s.key === sectionKey ? fn(s) : s)) };
}

function updateField(
  config: TemplateConfig, sectionKey: string, fieldKey: string, fn: (f: FieldConfig) => FieldConfig,
): TemplateConfig {
  return updateSection(config, sectionKey, (s) => ({
    ...s, fields: s.fields.map((f) => (f.key === fieldKey ? fn(f) : f)),
  }));
}

// ---------------------------------------------------------------------------------------------
// Sections and fields — show/hide, reorder, relabel, widths
// ---------------------------------------------------------------------------------------------

/** Flip a section's visibility. (The UI disables this control for a non-hideable section — the
 *  lock's authority is `assertLocksHonored`; this primitive just flips the bit.) */
export function toggleSectionVisible(config: TemplateConfig, sectionKey: string): TemplateConfig {
  return updateSection(config, sectionKey, (s) => ({ ...s, visible: !s.visible }));
}

/** Flip a field's visibility within its section. (Disabled in the UI for a non-removable field.) */
export function toggleFieldVisible(
  config: TemplateConfig, sectionKey: string, fieldKey: string,
): TemplateConfig {
  return updateField(config, sectionKey, fieldKey, (f) => ({ ...f, visible: !f.visible }));
}

/** Set a field's label override. An empty string clears it back to the contract's `defaultLabel`
 *  (stored as null — the config's "use the default" sentinel). */
export function setFieldLabel(
  config: TemplateConfig, sectionKey: string, fieldKey: string, raw: string,
): TemplateConfig {
  const label = raw === "" ? null : raw;
  return updateField(config, sectionKey, fieldKey, (f) => ({ ...f, label }));
}

/** Set a field's label to print nothing (`""`, the value alone) or back to the default (null). Only
 *  a contract with `blankLabels` offers it (the container tag's "Print no label" checkbox). */
export function setFieldLabelBlank(
  config: TemplateConfig, sectionKey: string, fieldKey: string, blank: boolean,
): TemplateConfig {
  return updateField(config, sectionKey, fieldKey, (f) => ({ ...f, label: blank ? "" : null }));
}

/** Set a field's column-width override; null clears it back to the contract's `defaultWidth`.
 *  Only column fields carry a width (the contract schema refuses one elsewhere). */
export function setFieldWidth(
  config: TemplateConfig, sectionKey: string, fieldKey: string, width: number | null,
): TemplateConfig {
  return updateField(config, sectionKey, fieldKey, (f) => ({ ...f, width }));
}

function contractSection(contract: TemplateContract, key: string): ContractSection | undefined {
  return contract.sections.find((cs) => cs.key === key);
}

/**
 * Whether `moveSection` would do anything. No control calls this: the ↑/↓ buttons take their
 * `disabled` from `sectionMoveGate`, which reads the same `sectionMoveBlock` and also disables
 * them under the edit gate, so with that gate open a button is disabled exactly when this is false.
 * A section moves only among REORDERABLE positions: a non-reorderable (pinned) section never
 * moves, and a move never displaces a pinned neighbour. Together these keep every pinned section
 * at its contract index (the invariant `assertLocksHonored` enforces): single-step swaps between
 * reorderable neighbours can never carry a section across a pinned anchor, because the pinned
 * anchor would be the neighbour and blocks the swap.
 */
export function canMoveSection(
  config: TemplateConfig, contract: TemplateContract, sectionKey: string, dir: -1 | 1,
): boolean {
  return sectionMoveBlock(config, contract, sectionKey, dir) === null;
}

/** What stops `moveSection`, or `null` when it would move: the one answer `canMoveSection` and the
 *  ↑/↓ button's reason (`sectionMoveGate`) both read, so they cannot disagree. */
function sectionMoveBlock(
  config: TemplateConfig, contract: TemplateContract, sectionKey: string, dir: -1 | 1,
): "unknown" | "pinned" | "end" | "pinned-neighbour" | null {
  const index = config.sections.findIndex((s) => s.key === sectionKey);
  if (index < 0) return "unknown";
  const cs = contractSection(contract, sectionKey);
  if (cs === undefined) return "unknown";
  if (!cs.reorderable) return "pinned"; // a pinned section cannot move
  const target = index + dir;
  if (target < 0 || target >= config.sections.length) return "end";
  const neighbour = contractSection(contract, config.sections[target].key);
  if (neighbour !== undefined && !neighbour.reorderable) return "pinned-neighbour"; // cannot displace a pin
  return null;
}

/** A control's gate as its button reads it: disabled, with the reason as the title. */
type MoveState = { disabled: boolean; title: string | undefined };

/**
 * The `disabled` and `title` of a section's ↑ or ↓ button (§5.16; #408). A pinned section shows
 * `pinnedReason`, its lock's own words, whatever the edit gate says, as it always has. Otherwise
 * the edit gate's reason comes first; then an end of the list ("Already first" / "Already last",
 * `moveGate`'s words); then a pinned neighbour, which the section may not displace (owner ruling
 * 2026-10-01). A section that can move has no title.
 */
export function sectionMoveGate(
  gate: MoveState, config: TemplateConfig, contract: TemplateContract, sectionKey: string, dir: -1 | 1,
  pinnedReason: string,
): MoveState {
  const block = sectionMoveBlock(config, contract, sectionKey, dir);
  if (block === "pinned") return { disabled: true, title: pinnedReason };
  if (gate.disabled) return { disabled: true, title: gate.title };
  if (block === "end") {
    return moveGate(null, config.sections.findIndex((s) => s.key === sectionKey), config.sections.length, dir);
  }
  if (block === "pinned-neighbour") {
    return { disabled: true, title: dir === -1 ? "The previous section is pinned in place" : "The next section is pinned in place" };
  }
  return { disabled: block !== null, title: undefined };
}

/** Move a section up (-1) or down (+1), or return the config unchanged when the move is blocked
 *  (a boundary, a pinned section, or a pinned neighbour — see `canMoveSection`). */
export function moveSection(
  config: TemplateConfig, contract: TemplateContract, sectionKey: string, dir: -1 | 1,
): TemplateConfig {
  if (!canMoveSection(config, contract, sectionKey, dir)) return config;
  const index = config.sections.findIndex((s) => s.key === sectionKey);
  const swapped = swapAt(config.sections, index, dir);
  return swapped === null ? config : { ...config, sections: swapped };
}

/** Whether `moveField` would do anything (a within-section bounds check). Fields carry no reorder
 *  lock — the validator does not constrain field order — so only the list bounds matter. */
export function canMoveField(
  config: TemplateConfig, sectionKey: string, fieldKey: string, dir: -1 | 1,
): boolean {
  const section = config.sections.find((s) => s.key === sectionKey);
  if (section === undefined) return false;
  const index = section.fields.findIndex((f) => f.key === fieldKey);
  if (index < 0) return false;
  const target = index + dir;
  return target >= 0 && target < section.fields.length;
}

/**
 * The `disabled` and `title` of a field's ↑ or ↓ button (§5.16; #408): the edit gate's reason
 * first, then the end of its section's list. Only the bounds stop a field (`canMoveField`).
 */
export function fieldMoveGate(
  gate: MoveState, config: TemplateConfig, sectionKey: string, fieldKey: string, dir: -1 | 1,
): MoveState {
  const fields = config.sections.find((s) => s.key === sectionKey)?.fields;
  const index = fields?.findIndex((f) => f.key === fieldKey) ?? -1;
  if (fields === undefined || index < 0) return { disabled: true, title: gate.disabled ? gate.title : undefined };
  return moveGate(gate, index, fields.length, dir);
}

/** Move a field up (-1) or down (+1) within its section, or return the config unchanged at a
 *  boundary. */
export function moveField(
  config: TemplateConfig, sectionKey: string, fieldKey: string, dir: -1 | 1,
): TemplateConfig {
  return updateSection(config, sectionKey, (s) => {
    const index = s.fields.findIndex((f) => f.key === fieldKey);
    const swapped = index < 0 ? null : swapAt(s.fields, index, dir);
    return swapped === null ? s : { ...s, fields: swapped };
  });
}

// ---------------------------------------------------------------------------------------------
// Format knobs, fonts, text blocks, page footer
// ---------------------------------------------------------------------------------------------

/** Which editor controls a contract withholds (true = withheld): the header logo, the page line and
 *  the small-text size (`TemplateContract.withholds`). Every other contract withholds none. */
export function editorWithholds(contract: TemplateContract): { logo: boolean; pageFooter: boolean; smallSize: boolean } {
  const w = contract.withholds ?? [];
  return { logo: w.includes("logo"), pageFooter: w.includes("pageFooter"), smallSize: w.includes("smallSize") };
}

/** Whether the Logo panel's UPLOAD is offered (container tag PR 3, owner call C1 "Allow, upload only"):
 *  a contract that withholds the header logo still offers the image upload while its config holds a
 *  canvas layout, since a canvas Logo item prints those bytes. The placement and width stay withheld
 *  (`editorWithholds(contract).logo`), and the server's `assertWithheld` still refuses a header
 *  placement. A contract that withholds nothing always offers it. */
export function logoUploadOffered(contract: TemplateContract, config: TemplateConfig): boolean {
  return !editorWithholds(contract).logo || config.layout !== null;
}

/** Which extra editor controls a contract offers (`blankLabels`: the "Print no label" checkbox). */
export function editorOffers(contract: TemplateContract): { blankLabels: boolean } {
  return { blankLabels: contract.blankLabels === true };
}

/** The Label size select's option words (one stock today; owner ruling R3). */
export const LABEL_SIZE_LABELS: Record<LabelSize, string> = { "4x3-landscape": "4 in \u00d7 3 in, landscape" };

/** Set one format knob (the picker only offers knobs the contract declares). */
export function setFormat<K extends keyof FormatsConfig>(
  config: TemplateConfig, key: K, value: FormatsConfig[K],
): TemplateConfig {
  return { ...config, formats: { ...config.formats, [key]: value } };
}

/** Patch the font config (family and/or the three sizes). */
export function setFonts(config: TemplateConfig, patch: Partial<FontsConfig>): TemplateConfig {
  return { ...config, fonts: { ...config.fonts, ...patch } };
}

/** Set a text block's body (the textarea's content). */
export function setTextBlock(config: TemplateConfig, key: string, value: string): TemplateConfig {
  return { ...config, textBlocks: { ...config.textBlocks, [key]: value } };
}

/** Toggle the "Page N of M" footer. */
export function setPageFooter(config: TemplateConfig, value: boolean): TemplateConfig {
  return { ...config, pageFooter: value };
}

/** Set the canvas layout (the Design tab's every edit, and the seed), or clear it: null is the
 *  sections layout, which prints again ("Back to sections"). The sections config is never touched. */
export function setLayout(config: TemplateConfig, layout: CanvasLayout | null): TemplateConfig {
  return { ...config, layout };
}

/** The seed route's body (`POST /api/templates/[id]/draft/canvas`): the picked order and the
 *  working config with its layout set aside, since the canvas starts from the sections' paper. */
export function seedRequest(config: TemplateConfig, recordId: string): { recordId: string; config: TemplateConfig } {
  return { recordId, config: setLayout(config, null) };
}

/** What the Sections panel says when the seed fails. The seed writes nothing, so an answer that
 *  cannot be read is not `WRITE_ANSWER_UNREADABLE`'s committed write: no layout reached the draft.
 *  A refusal (an `ApiError`) is the route's own sentence; anything else is the seed's. */
export function seedFailureMessage(error: unknown): string {
  if (error instanceof UnreadableAnswerError) return DESIGNER_WORDS.seedUnreadable;
  if (error instanceof ApiError) return error.message;
  return DESIGNER_WORDS.seedFailed;
}

/** The live page's measure (PR C of #926, Task 6), read from the preview route's
 *  `X-Preview-Measure` header, which it writes as `encodeURIComponent(JSON.stringify(measure))` for a
 *  canvas traveler alone. Null for no header, one that does not decode or parse, and a value without
 *  the measure's shape (`pages` a number; `tables`, `regions` and `items` arrays): the header is read,
 *  never trusted, and a null measure draws the stage's boxes as placed. */
export function parseMeasure(header: string | null): CanvasMeasure | null {
  if (header === null || header === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(decodeURIComponent(header));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  if (typeof m.pages !== "number" || !Array.isArray(m.tables) || !Array.isArray(m.regions) || !Array.isArray(m.items)) return null;
  return value as CanvasMeasure;
}

// ---------------------------------------------------------------------------------------------
// Logo placement + width (the BYTES are uploaded separately, via the logo route)
// ---------------------------------------------------------------------------------------------

/** Choose (or change) the header slot the logo prints in. Picking a placement creates the logo
 *  block if there wasn't one, preserving any width already set; DEFAULT_LOGO_WIDTH otherwise. */
export function setLogoPlacement(config: TemplateConfig, placement: LogoPlacement): TemplateConfig {
  return { ...config, logo: { placement, width: config.logo?.width ?? DEFAULT_LOGO_WIDTH } };
}

/** Set the logo's printed width (points). A no-op when no placement is chosen (nothing to size). */
export function setLogoWidth(config: TemplateConfig, width: number): TemplateConfig {
  if (config.logo === null) return config;
  return { ...config, logo: { ...config.logo, width } };
}

/** Remove the logo block — the logo stops printing even if bytes remain on the version (both a
 *  placement AND bytes are required to render, so clearing either is enough). */
export function clearLogoPlacement(config: TemplateConfig): TemplateConfig {
  return { ...config, logo: null };
}

// ---------------------------------------------------------------------------------------------
// Live width-budget check — the client's early surface of the server's own guardrail
// ---------------------------------------------------------------------------------------------

export type TableBudget = { table: string; total: number; budget: number; over: boolean };

/**
 * Per-table visible-column-width totals against each table's budget — a data-returning mirror of
 * the contract machinery's `assertWidthBudgets` (which throws). The editor renders the over-budget
 * tables inline so a template author sees the 564pt guardrail (ruling 3) as they drag, BEFORE the
 * `PATCH` reaches `validateConfig` and is refused. Only VISIBLE columns of VISIBLE sections count
 * — hiding a column is exactly how a template frees budget to widen another, so the two must agree.
 */
export function tableBudgets(contract: TemplateContract, config: TemplateConfig): TableBudget[] {
  const sectionByKey = new Map(contract.sections.map((cs) => [cs.key, cs]));
  const totals = new Map<string, number>();
  for (const s of config.sections) {
    if (!s.visible) continue;
    const cs = sectionByKey.get(s.key);
    if (cs === undefined) continue;
    const fieldByKey = new Map<string, ContractField>(cs.fields.map((cf) => [cf.key, cf]));
    for (const f of s.fields) {
      const cf = fieldByKey.get(f.key);
      if (cf?.column === undefined || !f.visible) continue;
      const width = f.width ?? cf.column.defaultWidth;
      if (width === "*") continue;
      totals.set(cf.column.table, (totals.get(cf.column.table) ?? 0) + width);
    }
  }
  return [...totals.entries()].map(([table, total]) => {
    const budget = contract.tableBudgets?.[table] ?? CONTENT_WIDTH;
    return { table, total, budget, over: total > budget };
  });
}

/**
 * The client-side reason the editor should disable Save BEFORE the round-trip, or null when the
 * working config is savable (Task 18 minor). It mirrors the `validateConfig` failures the panels can
 * produce: an over-budget table's declared widths (`tableBudgets`), and, on a flow config, a table
 * whose fixed columns, cell padding and rules, and one grid step where a "*" column is shown, pass its
 * budget (`printedBudgetProblems`, #991 owner ruling R-B, the server's own rule). A locked element can't
 * be hidden or reordered (those controls are disabled) and duplicate keys are structurally
 * impossible, so neither ever reaches here. The server's `validateConfig` stays the authoritative
 * backstop (spec §5.6 — the editor alone is not the enforcement); this just spares a round-trip
 * that would only come back a 400 and names the table to fix in a Save-button tooltip.
 */
export function widthBudgetError(contract: TemplateContract, config: TemplateConfig): string | null {
  const over = tableBudgets(contract, config).filter((b) => b.over);
  if (over.length > 0) {
    return "Over the column-width budget — " +
      over.map((b) => `${b.table} totals ${b.total}pt of ${b.budget}pt`).join("; ") +
      ". Narrow or hide a column before saving.";
  }
  const printed = printedBudgetRefusals(contract, config);
  return printed.length === 0 ? null : printed.map((p) => p.sentence).join(" ");
}

/** The flow's printed-width refusals (#991, owner ruling R-B): every column table whose fixed columns,
 *  padding and rules, and one grid step where a "*" column is shown, pass its budget, in the server's
 *  own sentences (`printedBudgetProblems`). [] for a canvas config, whose tables rule 9 judges. */
export function printedBudgetRefusals(contract: TemplateContract, config: TemplateConfig): PrintedBudgetProblem[] {
  if (config.layout !== null) return [];
  return printedBudgetProblems(contract, config.sections, config.fonts.baseSize);
}

/**
 * The canvas's reason the editor closes Save, or null: the sentence of the first rule the server's
 * `validateCanvasLayout` would refuse the layout on (`canvasRefusal`), judged with the config's own
 * page line as `validateConfig` judges it. Null for a sections template (no layout). The Design tab
 * shows the same refusal with its items outlined; the server's check stays the enforcement.
 */
export function canvasSaveBlock(contract: TemplateContract, config: TemplateConfig): string | null {
  if (config.layout === null) return null;
  const page = canvasPageFor(contract.docType, config.formats.labelSize);
  return canvasRefusal(config.layout, contract, { pageFooter: config.pageFooter, page, fonts: config.fonts })?.sentence ?? null;
}

export type PrintedWidthWarning = {
  table: string;
  /** The table's width on paper, in points: one copy's, for the ticket's container table, which
   *  prints its columns twice side by side. A minimum when `atLeast`. */
  printed: number;
  /** How far `printed` passes the table's budget: the content width, or the width the contract
   *  gives that table (`tableBudgets`). */
  over: number;
  /** A column is flexible, so the table is at least this wide. */
  atLeast: boolean;
  message: string;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The Column widths panel's printed-width warning (#450, #457, #991): a flow column table whose fixed
 * columns, padding and rules fit its budget, but whose headings do not, each shown "*" column counted
 * at its widest heading word (`headingWarning`, owner ruling 2026-11-15). render.ts' column clamp keeps
 * such a table inside the page and its heading words break inside their cells. It never blocks the
 * save. Null for a canvas config (warning (d) is the designer's voice there), for a table over its
 * declared budget or its printed one (the refusals report those, `widthBudgetError`; owner ruling R-B
 * of 2026-11-17 made the printed one a refusal, retiring the warn-only "runs past the right margin"
 * sentences of #450 and #457), and for a table that prints no columns. A word of the record's own is
 * not counted: no template figure bounds it, and the clamp breaks it inside its cell. Only column
 * tables are warned of. The invoice's totals lines, aligned under its amount column, are no warning's
 * either: owner answer (11) of 2026-10-16 had left them a measured residual, and the owner's ruling of
 * 2026-11-17 (#991 review F1) amends it, so an Amount column that would push them past the page is
 * refused with the printed-width budget instead (`printedBudgetProblems`). The traveler's steps table
 * never speaks: its title spans its instruction column.
 */
export function printedWidthWarning(
  contract: TemplateContract, config: TemplateConfig, table: string,
): PrintedWidthWarning | null {
  if (config.layout !== null) return null;
  if (tableBudgets(contract, config).some((b) => b.table === table && b.over)) return null;
  if (printedBudgetRefusals(contract, config).some((p) => p.table === table)) return null;
  const width = tablePrintedWidth(contract, config, table);
  return width === null ? null : headingWarning(table, contract, config, width);
}

/**
 * The honest half of the printed-width warning (#991, owner ruling 2026-11-15; design
 * docs/superpowers/specs/2026-11-17-991-flow-tables-in-box-design.md §5.1): a table whose fixed columns,
 * padding and rules fit its budget, but whose headings, each shown "*" column counted at its widest
 * heading word (`tablePrintedWidth`'s `head`), do not. render.ts' column clamp keeps such a table inside
 * its width, so its "*" columns share what the fixed ones leave and their heading words break inside
 * their cells. Judged as the canvas's warning (d) judges it, `headingWhole` × copies against the budget
 * × copies at two decimals. Null with no "*" column shown or no heading word over one. It never blocks
 * the save. The share is named as the canvas names it (`sharedWidthWords`).
 */
function headingWarning(
  table: string, contract: TemplateContract, config: TemplateConfig,
  printed: NonNullable<ReturnType<typeof tablePrintedWidth>>,
): PrintedWidthWarning | null {
  const heading = tableHeadingWidth(contract, config, table);
  if (heading === null || heading.shared.length === 0 || !(heading.head > 0)) return null;
  const width = { ...printed, ...heading };
  if (!(round2(width.headingWhole * width.copies) > round2(width.budget * width.copies))) return null;
  const share = Math.max(0, (width.budget - width.printed) / width.shared.length);
  const gets = sharedWidthWords(width.shared, share);
  const under = `under the ${width.head} pt its widest heading word needs, so its heading words break inside their cells.`;
  const over = round2(width.headingWhole - width.budget);
  let message: string;
  if (contract.docType === "BOL" && table === "freight") {
    const what = width.shared.length === 1 ? "flexible column has" : "flexible columns share";
    message = `On paper the “${table}” table's ${what} what its fixed columns leave beside the sidebar: ` +
      `${gets}, ${under} Its headings print whole from ${width.headingWhole} pt beside the sidebar, past the ` +
      `${width.budget} pt it has there.`;
  } else if (width.copies === 2) {
    message = `On paper each half of the “${table}” table shares what its fixed columns leave: ${gets}, ${under} ` +
      `Its headings print whole from ${width.headingWhole} pt each half, ${round2(width.headingWhole * 2)} pt in all, ` +
      `past the ${width.budget} pt each half has.`;
  } else {
    const what = width.shared.length === 1 ? "flexible column has" : "flexible columns share";
    message = `On paper the “${table}” table's ${what} what its fixed columns leave: ${gets}, ${under} ` +
      `Its headings print whole from ${width.headingWhole} pt wide, past the ${width.budget} pt content width.`;
  }
  return {
    table, printed: width.headingWhole, over, atLeast: false,
    message: `${message} You can still save. Narrow a column to fit.`,
  };
}

/** What the Column widths panel says under a shipping ticket's container table about the columns
 *  that share its spare width (#519; the owner's S1 of 2026-10-16). */
export type SharedWidthNotice = {
  /** What each shown column that shares gets, as the listing says it, with a period:
   *  "Containers and Tare get 54 pt each." A share under 39 pt has two decimals and never reads 39
   *  (`sharedWidthWords`): "Containers and Tare get 38.95 pt each." */
  share: string;
};

/**
 * The notice under a shipping ticket's container table while a shown column shares its spare
 * width (#519; owner ruling 2026-10-15, "Warn and show the share"): the share, in grey. Null for any
 * other document or table, for a hidden section, when no shown column shares, and once one copy's
 * printed width, as `tablePrintedWidth` rounds it, passes the 282pt each copy has, where the share is
 * under 0pt (the printed-width refusal speaks there, owner ruling R-B). Its 39 pt warning ("Under 39 pt
 * each, … have no room: the container table prints past the right margin") and its "not measured"
 * note are retired (owner ruling R-A, 2026-11-17, #991): under the column clamp a tight container
 * table breaks its words inside its cells, and the heading warning (`printedWidthWarning`) says when.
 * It never blocks the save.
 */
export function sharedWidthNotice(
  contract: TemplateContract, config: TemplateConfig, table: string,
): SharedWidthNotice | null {
  const docType = contract.docType;
  if ((docType !== "SHIPPER" && docType !== "MOS_SHIPPER") || table !== "containers") return null;
  const answer = sharedContainerWidth(docType, config);
  if (answer === null || answer.each === null) return null;
  const width = tablePrintedWidth(contract, config, table);
  if (width === null || width.printed > width.budget) return null;
  return { share: `${sharedWidthWords(answer.shared, answer.each)}.` };
}

// ---------------------------------------------------------------------------------------------
// Save-conflict resolution — the pure decision behind the editor's updatedAt-409 UX (Task 18)
// ---------------------------------------------------------------------------------------------

/**
 * The banner shown after a stale-`updatedAt` 409 conflict. By the time this shows, the editor has
 * ALREADY rolled the working state back to server truth (HANDOFF §5.13 — roll back FIRST, then
 * report why, so the reload can never wipe the message it is reporting). So it describes what
 * happened and names the two ways forward: keep the reloaded draft, or re-apply the set-aside edits
 * to save over the new version (the deliberate overwrite).
 */
export const STALE_DRAFT_MESSAGE =
  "The draft changed since you loaded it (someone else saved, or the logo changed). The editor has " +
  "reloaded the current draft and set your unsaved edits aside — re-apply them to save over the new " +
  "version, or keep the reloaded draft.";

export type SaveErrorResolution =
  | { action: "reload-then-conflict"; message: string }
  | { action: "error"; message: string };

/**
 * The editor's save-error state machine (Task 18), pure so the node-only harness can decide it
 * without a DOM. A stale-precondition 409 (spec §5.1 / `editDraft`) is the ONLY status that earns
 * the reload-vs-overwrite treatment: the caller must roll the editor back to server truth FIRST and
 * only THEN show `message` — the `reload-then-conflict` action name is that ordering (HANDOFF §5.13:
 * a reload that runs after the banner is set wipes it). Every other failure — a 400 from
 * `validateConfig`, a 403, a 404, a 500, a network error (null status) — surfaces its own server
 * message with no reload path.
 */
export function resolveSaveError(status: number | null, serverMessage: string): SaveErrorResolution {
  if (status === 409) return { action: "reload-then-conflict", message: STALE_DRAFT_MESSAGE };
  return { action: "error", message: serverMessage };
}

// ---------------------------------------------------------------------------------------------
// Edit-epoch settle decision — what a settling save may still touch (Group D Task 8)
// ---------------------------------------------------------------------------------------------

export type SaveSettleDecision = {
  /** Always true: the precondition (`updatedAt`, logo meta) genuinely advanced server-side, so
   *  freshening it is safe — and required for the NEXT save to match — even when the user edited
   *  on during the round trip. */
  freshenPrecondition: true;
  /** True only when no edit intervened between the save's dispatch and its settle. When false:
   *  a SUCCESS must not mark the editor clean/Saved (the newer edits were never written — a
   *  false "Saved" loses them the moment the user navigates away), and a 409 ROLLBACK must not
   *  replace the config with the fetched one nor raise the conflict banner (the user has moved
   *  on — the same semantics `apply`'s conflict-dismissal already claims). */
  applyOutcome: boolean;
};

/**
 * The edit-epoch gate's decision at a save's two settle points (`useLatest` semantics: `apply()`
 * bumps the epoch, `save()` takes a ticket at dispatch, and `editIntervened` is that ticket no
 * longer being current). Pure so the node-only harness pins it — the `resolveSaveError` precedent.
 */
export function resolveSaveSettle(editIntervened: boolean): SaveSettleDecision {
  return { freshenPrecondition: true, applyOutcome: !editIntervened };
}

// ---------------------------------------------------------------------------------------------
// Preview record picker (Task 19, spec §5.5) — docType → which real record the live preview
// renders against, and how the pane fetches the choices. Pure and client-safe so the picker's
// mapping is unit-tested here and the pane stays a thin wrapper.
// ---------------------------------------------------------------------------------------------

export type PreviewRecordKind =
  | "order" | "shipment-single" | "shipment-multi" | "shipment" | "cert" | "invoice" | "customer" | "quote"
  // The container tag's order: the order kind's list and options, without its All loads box.
  | "tagOrder";

export type PreviewRecordSpec = {
  kind: PreviewRecordKind;
  /** GET endpoint returning the array of pickable records. */
  listPath: string;
  /** The permission the picker's LIST fetch needs — the record's own list-route gate, so the
   *  picker only offers records the user can view (§5.16, no silent-empty dropdown). For STATEMENT
   *  this is `customers.view` (the record IS a customer, listed via `/api/customers` — the
   *  Statements screen precedent), which is DISTINCT from the preview POST's own `receivables.view`
   *  gate: a user can list customers yet still be refused the statement preview, surfaced in the pane. */
  listPermission: string;
  /** Shipment kinds only: which shipments to offer (SHIPPER = single-order, MOS_SHIPPER = multi;
   *  BOL = any). Absent for non-shipment kinds. */
  orderCount?: "single" | "multi";
  /** A short human noun for the picker's empty/placeholder copy. */
  noun: string;
};

/**
 * A noun with its indefinite article (#239 P1b). The picker's copy was composed as `a {noun}`,
 * which reads "a order" and "a invoice or credit" — two of the eight docTypes. The article
 * belongs to the PHRASE, so it is computed here rather than folded into the nouns above, which
 * also appear un-articled ("against a real {noun}").
 *
 * A leading-VOWEL rule, deliberately, not a pronunciation one: every noun `previewRecordSpec`
 * declares is a plain English word whose article follows its first letter, and the full set is
 * pinned in `tests/template-editor.test.ts`. A new docType whose noun breaks that (a "unit", a
 * "one-off") gets its article decided there, not by a longer regex here.
 */
export function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

/**
 * Whether the preview pane may offer its record picker (#678), from the editor's own permission read
 * (`perms`, undefined until it has answered) and the record list's permission. Pending is never read
 * as no grants: the pane shows the shared "Loading…" line until the read answers, and only an answer
 * without the permission is denied. A failed read stays pending here; the editor's recovery notice
 * names it and offers its own retry, so the pane adds no second error line. The preview route's own
 * record-area gate stays the enforcement.
 */
export function previewListAccess(
  perms: readonly string[] | undefined, listPermission: string,
): "pending" | "denied" | "allowed" {
  if (perms === undefined) return "pending";
  return perms.includes(listPermission) ? "allowed" : "denied";
}

export function previewRecordSpec(docType: TemplateDocTypeString): PreviewRecordSpec {
  switch (docType) {
    case "TRAVELER":
      return { kind: "order", listPath: "/api/orders", listPermission: "orders.view", noun: "order" };
    case "SHIPPER":
      return { kind: "shipment-single", listPath: "/api/shippers", listPermission: "shipping.view", orderCount: "single", noun: "single-order shipment" };
    case "MOS_SHIPPER":
      return { kind: "shipment-multi", listPath: "/api/shippers", listPermission: "shipping.view", orderCount: "multi", noun: "multi-order shipment" };
    case "BOL":
      return { kind: "shipment", listPath: "/api/shippers", listPermission: "shipping.view", noun: "shipment" };
    case "CERT":
      return { kind: "cert", listPath: "/api/certs", listPermission: "certs.view", noun: "certification" };
    case "INVOICE":
      return { kind: "invoice", listPath: "/api/invoices", listPermission: "invoicing.view", noun: "invoice or credit" };
    case "STATEMENT":
      return { kind: "customer", listPath: "/api/customers", listPermission: "customers.view", noun: "customer" };
    case "QUOTE":
      return { kind: "quote", listPath: "/api/quotes", listPermission: "quotes.view", noun: "quote" };
    case "CONTAINER_TAG":
      return { kind: "tagOrder", listPath: "/api/orders", listPermission: "orders.view", noun: "order" };
  }
}
