"use client";
// The contract-driven editing panels (Phase 7 Task 17, spec §5.5) — thin, presentational wrappers
// over the pure config-editing logic in `@/lib/template-editor`. ONE component tree serves all
// every docType: every panel renders from the contract handed to it (`contractFor(docType)`), with
// NO per-type branch anywhere — a knob shows because the contract declares it, a section is locked
// because the contract locks it. Client-safe: the contract registry and the editor logic are pure
// declarations with no `src/server/**` import (the `permission-ui.ts` precedent, CLAUDE.md).
//
// The panels hold NO state of their own. Each mutation is `apply(fn)` where `fn` is one of the
// tested pure functions — `apply` is the orchestrator's `setConfig(fn(config))`, so the panels are
// the "thin wrappers proven in E2E" the brief calls for, and every rule they enforce (a locked
// element cannot be hidden, a reorder cannot cross a pin) is the pure layer's, unit-tested directly.
// The one exception is view state, never config: which clause Wording's list shows (PR 13).
import { useState, type ReactNode } from "react";
import {
  CONTENT_WIDTH,
  DATE_FORMATS,
  FONT_FAMILIES,
  LABEL_SIZES,
  NEGATIVE_STYLES,
  PRICE_DECIMALS,
  canvasPrints,
  type ContractField,
  type DateFormat,
  type FontFamily,
  type LabelSize,
  type NegativeStyle,
  type PriceDecimals,
  type TemplateConfig,
  type TemplateContract,
} from "@/lib/template-contracts";
import {
  editorOffers,
  editorWithholds,
  fieldMoveGate,
  LABEL_SIZE_LABELS,
  lockKey,
  moveField,
  moveSection,
  printedBudgetRefusals,
  printedWidthWarning,
  sectionMoveGate,
  setFieldLabel,
  setFieldLabelBlank,
  setFieldWidth,
  setFonts,
  setFormat,
  setPageFooter,
  setTextBlock,
  sharedWidthNotice,
  tableBudgets,
  toggleFieldVisible,
  toggleSectionVisible,
} from "@/lib/template-editor";
import { ActionMenu } from "@/components/ActionMenu";
import { PanelMessage } from "@/components/PanelMessage";
import { DESIGNER_WORDS } from "@/lib/canvas-designer";
import { BUTTON_NEUTRAL_COMPACT, CHIP, CARD, INPUT_COMPACT, LINK } from "@/lib/ui-classes";

/** Every panel takes the contract + the working config + one `apply` that swaps the config for the
 *  result of a pure function, plus the shared edit gate (`disabled`/`editTitle`, §5.16) and the
 *  namespaced padlock lookup (`locks`). */
export type PanelProps = {
  contract: TemplateContract;
  config: TemplateConfig;
  apply: (fn: (c: TemplateConfig) => TemplateConfig) => void;
  disabled: boolean;
  editTitle: string | undefined;
  locks: Map<string, string>;
};

// A card wrapper so every panel reads the same on the page.
function Panel({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {hint && <p className="mt-0.5 mb-2 text-xs text-ink-500">{hint}</p>}
      <div className={hint ? "" : "mt-2"}>{children}</div>
    </section>
  );
}

/** A padlock + reason, shown beside a locked section/field. The reason IS the string the server
 *  quotes when it refuses hiding/reordering it (spec §5.6) — one source, via `lockIndex`. */
function Lock({ reason }: { reason: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-accent-600" title={reason} aria-label={`locked: ${reason}`}>
      <span aria-hidden>🔒</span>
      <span className="italic">locked</span>
    </span>
  );
}

/** A row's ↑/↓. `up` and `down` are each button's `disabled` and `title` (§5.16; #408), from
 *  `sectionMoveGate` or `fieldMoveGate`: a button that cannot move its row says why. */
function Reorder({ onUp, onDown, up, down }: {
  onUp: () => void; onDown: () => void;
  up: { disabled: boolean; title: string | undefined }; down: { disabled: boolean; title: string | undefined };
}) {
  const cls = "rounded border px-1.5 text-xs leading-5";
  return (
    <span className="flex gap-1">
      <button type="button" onClick={onUp} {...up} aria-label="Move up" className={cls}>↑</button>
      <button type="button" onClick={onDown} {...down} aria-label="Move down" className={cls}>↓</button>
    </span>
  );
}

// ------------------------------------------------------------------------------------------------
// Sections and fields — show/hide, reorder, label override. Locked entries render locked + disabled.
// ------------------------------------------------------------------------------------------------

/** `onEditWidths` opens Fields & widths; a document with no such tab passes none, and its menus
 *  offer no Edit fields and widths. `onDesign` is Design on a canvas, offered on a type whose canvas prints (`canvasPrints`; PR C of #926):
 *  the editor asks, seeds and opens the Design tab; `design` is its gate (`designOnCanvasGate`) and
 *  the seed's refusal, shown in this panel's own message. A type whose canvas does not print (no
 *  profile, or a profile whose paper has not landed) offers none. */
export function SectionsPanel({ contract, config, apply, disabled, editTitle, locks, onEditWidths, onDesign, design }: PanelProps & {
  onEditWidths?: () => void;
  onDesign?: () => void;
  design?: { disabled: boolean; title: string | undefined; message: string | null };
}) {
  const editGate = { disabled, title: editTitle };
  const byKey = new Map(contract.sections.map((cs) => [cs.key, cs]));
  const offers = editorOffers(contract);
  // `onDesign` is read at its click alone, where tests/pending-action-sweep.test.ts judges it (ASKED).
  const canvas = canvasPrints(contract.docType) && design !== undefined;
  return (
    <Panel title="Sections and fields"
           hint="Show or hide, reorder, and relabel. Locked elements print in a fixed place and cannot be hidden or moved.">
      {canvas && (
        <div className="mb-3">
          <button type="button" onClick={onDesign} disabled={design.disabled} title={design.title} className={BUTTON_NEUTRAL_COMPACT}>
            {DESIGNER_WORDS.designOnCanvas}
          </button>
          <PanelMessage message={design.message} />
        </div>
      )}
      <div className="space-y-3">
        {config.sections.map((s) => {
          const cs = byKey.get(s.key);
          if (cs === undefined) return null; // unknown key — the validator's refusal, not the UI's
          const sectionLock = locks.get(lockKey("section", s.key));
          const hideTitle = sectionLock ?? (cs.hideable ? editTitle : "This section prints in a fixed place");
          const fieldByKey = new Map(cs.fields.map((cf) => [cf.key, cf]));
          return (
            <div key={s.key} role="group" aria-label={cs.name} className="rounded border border-line">
              <div className="flex flex-wrap items-center gap-3 bg-surface-50 px-3 py-2">
                <span className="text-sm font-medium">{cs.name}</span>
                {!s.visible && <span className={CHIP}>Hidden</span>}
                {sectionLock && <Lock reason={sectionLock} />}
                <div className="ml-auto">
                  <ActionMenu label="Section actions" items={[
                    { label: "Move up", ...sectionMoveGate(editGate, config, contract, s.key, -1, sectionLock ?? "This section is pinned in place"),
                      onSelect: () => apply((c) => moveSection(c, contract, s.key, -1)) },
                    { label: "Move down", ...sectionMoveGate(editGate, config, contract, s.key, 1, sectionLock ?? "This section is pinned in place"),
                      onSelect: () => apply((c) => moveSection(c, contract, s.key, 1)) },
                    { label: s.visible ? "Hide section" : "Show section", disabled: disabled || !cs.hideable,
                      title: hideTitle, onSelect: () => apply((c) => toggleSectionVisible(c, s.key)) },
                    ...(onEditWidths ? [{ label: "Edit fields and widths", onSelect: onEditWidths }] : []),
                  ]} />
                </div>
              </div>
              <ul className="divide-y">
                {s.fields.map((f) => {
                  const cf = fieldByKey.get(f.key);
                  if (cf === undefined) return null;
                  const fieldLock = locks.get(lockKey("field", f.key));
                  return (
                    <li key={f.key} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm">
                      <label className="flex items-center gap-1.5" title={fieldLock ?? (cf.removable ? editTitle : "This field cannot be hidden")}>
                        <input type="checkbox" checked={f.visible}
                               disabled={disabled || !cf.removable}
                               onChange={() => apply((c) => toggleFieldVisible(c, s.key, f.key))}
                               aria-label={`Show field ${cf.name}`} />
                        <span className="w-40 truncate text-ink-800">{cf.name}</span>
                      </label>
                      <input type="text" value={f.label ?? ""}
                             disabled={disabled || (offers.blankLabels && f.label === "")}
                             placeholder={cf.defaultLabel === "" ? "(no printed label)" : cf.defaultLabel}
                             title={editTitle}
                             onChange={(e) => apply((c) => setFieldLabel(c, s.key, f.key, e.target.value))}
                             aria-label={`Label for ${cf.name}`}
                             className="w-56 rounded border px-2 py-0.5 text-xs disabled:bg-surface-50" />
                      {offers.blankLabels && (
                        <label className="flex items-center gap-1 text-xs text-ink-800" title={editTitle}>
                          <input type="checkbox" checked={f.label === ""} disabled={disabled}
                                 onChange={(e) => apply((c) => setFieldLabelBlank(c, s.key, f.key, e.target.checked))}
                                 aria-label={`Print no label for ${cf.name}`} />
                          Print no label
                        </label>
                      )}
                      {fieldLock && <Lock reason={fieldLock} />}
                      <div className="ml-auto">
                        <Reorder up={fieldMoveGate(editGate, config, s.key, f.key, -1)}
                                 down={fieldMoveGate(editGate, config, s.key, f.key, 1)}
                                 onUp={() => apply((c) => moveField(c, s.key, f.key, -1))}
                                 onDown={() => apply((c) => moveField(c, s.key, f.key, 1))} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------
// Column widths — numeric inputs per declared column, LIVE budget check against 564pt (ruling 3).
// ------------------------------------------------------------------------------------------------

type WidthColumn = { sectionKey: string; field: ContractField; visible: boolean; width: number | null };

/** Group the contract's column fields by table, carrying each column's current visibility + width
 *  override — the widths panel's presentation grouping (the authoritative totals come from the
 *  pure `tableBudgets`). Local to this panel: pure display shaping, no config mutation. */
function widthTables(contract: TemplateContract, config: TemplateConfig): { table: string; columns: WidthColumn[] }[] {
  const cfgSection = new Map(config.sections.map((s) => [s.key, s]));
  const order: string[] = [];
  const cols = new Map<string, WidthColumn[]>();
  for (const cs of contract.sections) {
    const sc = cfgSection.get(cs.key);
    for (const cf of cs.fields) {
      if (cf.column === undefined) continue;
      const fc = sc?.fields.find((f) => f.key === cf.key);
      const table = cf.column.table;
      if (!cols.has(table)) { cols.set(table, []); order.push(table); }
      cols.get(table)!.push({
        sectionKey: cs.key, field: cf,
        visible: (sc?.visible ?? true) && (fc?.visible ?? true),
        width: fc?.width ?? null,
      });
    }
  }
  return order.map((table) => ({ table, columns: cols.get(table)! }));
}

export function WidthsPanel({ contract, config, apply, disabled, editTitle }: PanelProps) {
  const tables = widthTables(contract, config);
  if (tables.length === 0) return null; // a document with no column tables (rare) shows no panel
  const budgets = new Map(tableBudgets(contract, config).map((b) => [b.table, b]));
  const printedRefusals = printedBudgetRefusals(contract, config);
  return (
    <Panel title="Column widths"
           hint={`Widths are in points. Each table's visible columns must total no more than its budget (the ${CONTENT_WIDTH}pt letter content width, or less where a table shares the page), and, with their cell padding and rules and 4.5pt for a flexible column, print within it.`}>
      <div className="space-y-4">
        {tables.map(({ table, columns }) => {
          const b = budgets.get(table);
          const budget = b?.budget ?? CONTENT_WIDTH;
          const total = b?.total ?? 0;
          const over = b?.over ?? false;
          const printedWarning = printedWidthWarning(contract, config, table);
          // The flow's printed-width refusal (#991, owner ruling R-B): fixed columns, padding and rules
          // past the budget, which `widthBudgetError` closes Save on.
          // The invoice's totals lines read the Amount column's width, so their refusal shows under these columns.
          const printedRefusal = over ? [] : printedRefusals.filter((p) => p.table === table || (table === "columns" && p.table === "totals"));
          // A shipping ticket's container table only (#519): its share, in grey. Its 39 pt warning and
          // its "not measured" note are retired (owner ruling R-A, 2026-11-17).
          const notice = sharedWidthNotice(contract, config, table);
          const amber = printedWarning?.message ?? null;
          return (
            <div key={table}>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">{table}</span>
                <span className={`text-xs ${over ? "font-semibold text-red-700" : "text-ink-500"}`}
                      aria-label={`${table} width total`}>
                  {total} / {budget}pt{over ? " — over budget" : ""}
                </span>
              </div>
              {over && (
                <p className="mb-1 rounded bg-red-50 px-2 py-1 text-xs text-red-700" role="alert">
                  The visible columns of “{table}” total {total}pt, past the {budget}pt budget. Narrow a
                  column or hide one to fit.
                </p>
              )}
              {printedRefusal.map((p) => (
                <p key={p.table} className="mb-1 rounded bg-red-50 px-2 py-1 text-xs text-red-700" role="alert">
                  {p.sentence}
                </p>
              ))}
              {/* What each shown column that shares the spare width gets: grey, with no role. */}
              {notice && <p className="mb-1 text-xs text-ink-500">{notice.share}</p>}
              {/* Amber and a status, not the alert above: the warning never blocks the save (#991). */}
              {amber && (
                <p className="mb-1 rounded bg-accent-50 px-2 py-1 text-xs text-accent-600" role="status">
                  {amber}
                </p>
              )}
              <ul className="space-y-1">
                {columns.map(({ sectionKey, field, visible, width }) => {
                  const flexible = field.column!.defaultWidth === "*";
                  // #239 C6: an unset width and a stored one that happens to equal the contract
                  // default printed the SAME number in the same box — one as a placeholder, one
                  // as a value — so the panel could not answer the only question it is asked
                  // ("has anyone changed this?"). Two cues, both keyed off the same `unset`: the
                  // box renders italic while it holds a placeholder rather than text, and the
                  // trailing unit says so in words, because italic alone is a distinction nobody
                  // reads at 12px.
                  const unset = width === null;
                  // A column that is flex by default is flex only while its box is empty: a typed
                  // width prints at that width, so the words beside it say how to make it flex
                  // again (the owner's S8, 2026-10-16, on every document).
                  const flexNow = flexible && unset;
                  return (
                    <li key={field.key} className={`flex items-center gap-2 text-sm ${visible ? "" : "text-ink-500"}`}>
                      <span className="w-52 truncate">{field.name}{visible ? "" : " (hidden)"}</span>
                      <input type="number" min={1} max={CONTENT_WIDTH}
                             value={width ?? ""}
                             disabled={disabled}
                             placeholder={flexible ? "Flexible" : String(field.column!.defaultWidth)}
                             title={editTitle}
                             onChange={(e) => {
                               const raw = e.target.value.trim();
                               const next = raw === "" ? null : Number(raw);
                               apply((c) => setFieldWidth(c, sectionKey, field.key,
                                 next === null || Number.isNaN(next) ? null : next));
                             }}
                             aria-label={`Width for ${field.name}`}
                             className={`w-24 rounded border px-2 py-0.5 text-xs disabled:bg-surface-50${unset ? " italic" : ""}`} />
                      <span className="text-xs text-ink-500">
                        {flexNow ? "flex column (fills remaining width)"
                          : unset ? "pt (default)"
                          : flexible ? "pt (empty the box to make it flex)" : "pt"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------
// Format pickers — only the knobs the contract DECLARES (a traveler has no price/date knobs).
// ------------------------------------------------------------------------------------------------

const NEGATIVE_STYLE_LABELS: Record<NegativeStyle, string> = {
  SIGN_AFTER_SYMBOL: "$-1,234.56  (sign after the symbol)",
  LEADING_MINUS: "-$1,234.56  (leading minus)",
  PARENTHESES: "($1,234.56)  (parentheses)",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-ink-500">{label}</span>
      {children}
    </label>
  );
}

export function FormatsPanel({ contract, config, apply, disabled, editTitle }: PanelProps) {
  const f = config.formats;
  const declares = contract.formats;
  // No declared knobs (a document that prints no numbers or dates) → no panel.
  if (declares.negativeStyle === undefined && declares.priceDecimals === undefined
      && declares.thousandsSeparator === undefined && declares.dateFormat === undefined
      && declares.labelSize === undefined) {
    return null;
  }
  const sel = "rounded border px-2 py-1 text-sm disabled:bg-surface-50";
  return (
    <Panel title="Formats" hint="How money, quantities and dates print on this document.">
      <div className="divide-y">
        {declares.negativeStyle !== undefined && (
          <Row label="Negative amounts">
            <select value={f.negativeStyle} disabled={disabled} title={editTitle} className={sel}
                    aria-label="Negative amount style"
                    onChange={(e) => apply((c) => setFormat(c, "negativeStyle", e.target.value as NegativeStyle))}>
              {NEGATIVE_STYLES.map((v) => <option key={v} value={v}>{NEGATIVE_STYLE_LABELS[v]}</option>)}
            </select>
          </Row>
        )}
        {declares.priceDecimals !== undefined && (
          <Row label="Price decimal places">
            <select value={f.priceDecimals} disabled={disabled} title={editTitle} className={sel}
                    aria-label="Price decimal places"
                    onChange={(e) => apply((c) => setFormat(c, "priceDecimals", Number(e.target.value) as PriceDecimals))}>
              {PRICE_DECIMALS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Row>
        )}
        {declares.thousandsSeparator !== undefined && (
          <Row label="Group thousands (1,234)">
            <input type="checkbox" checked={f.thousandsSeparator ?? false} disabled={disabled} title={editTitle}
                   aria-label="Group thousands"
                   onChange={(e) => apply((c) => setFormat(c, "thousandsSeparator", e.target.checked))} />
          </Row>
        )}
        {declares.dateFormat !== undefined && (
          <Row label="Date format">
            <select value={f.dateFormat} disabled={disabled} title={editTitle} className={sel}
                    aria-label="Date format"
                    onChange={(e) => apply((c) => setFormat(c, "dateFormat", e.target.value as DateFormat))}>
              {DATE_FORMATS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Row>
        )}
        {declares.labelSize !== undefined && (
          <Row label="Label size">
            <select value={f.labelSize ?? declares.labelSize} disabled={disabled} title={editTitle} className={sel}
                    aria-label="Label size"
                    onChange={(e) => apply((c) => setFormat(c, "labelSize", e.target.value as LabelSize))}>
              {LABEL_SIZES.map((v) => <option key={v} value={v}>{LABEL_SIZE_LABELS[v]}</option>)}
            </select>
          </Row>
        )}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------
// Fonts — the curated 4-family list + the three role sizes.
// ------------------------------------------------------------------------------------------------

export function FontsPanel({ contract, config, apply, disabled, editTitle }: PanelProps) {
  const fonts = config.fonts;
  const withholds = editorWithholds(contract);
  const num = "w-20 rounded border px-2 py-1 text-sm disabled:bg-surface-50";
  const sizeRow = (label: string, key: "baseSize" | "headingSize" | "smallSize") => (
    <Row label={label}>
      <input type="number" min={4} max={72} step={0.5} value={fonts[key]} disabled={disabled} title={editTitle}
             aria-label={label} className={num}
             onChange={(e) => {
               const n = Number(e.target.value);
               if (!Number.isNaN(n)) apply((c) => setFonts(c, { [key]: n }));
             }} />
    </Row>
  );
  return (
    <Panel title="Typography" hint="One family for the whole document, from the bundled set.">
      <div className="divide-y">
        <Row label="Font family">
          <select value={fonts.family} disabled={disabled} title={editTitle} aria-label="Font family"
                  className={`${INPUT_COMPACT} disabled:bg-surface-50`}
                  onChange={(e) => apply((c) => setFonts(c, { family: e.target.value as FontFamily }))}>
            {FONT_FAMILIES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </Row>
        {sizeRow("Body (pt)", "baseSize")}
        {sizeRow("Heading (pt)", "headingSize")}
        {!withholds.smallSize && sizeRow("Small text (pt)", "smallSize")}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------
// Text blocks — the standing paragraphs (cert statement, BOL legal, quote intro/liability, …).
// ------------------------------------------------------------------------------------------------

/** More blocks than this take the Standing clauses list (owner 2026-11-02 on #828): a count, so no
 *  panel branches on a document type. */
const PLAIN_TEXT_BLOCKS = 2;

export function TextBlocksPanel({ contract, config, apply, disabled, editTitle }: PanelProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const blocks = contract.textBlocks;
  if (blocks.length === 0) return null; // a document with no standing text (traveler)
  const box = (t: (typeof blocks)[number], rows: number) => (
    <label key={t.key} className="block text-sm">
      <span className="mb-1 block font-medium text-ink-800">{t.name}</span>
      <textarea value={config.textBlocks[t.key] ?? ""} disabled={disabled} title={editTitle}
                rows={rows} placeholder={t.defaultText}
                aria-label={t.name}
                onChange={(e) => apply((c) => setTextBlock(c, t.key, e.target.value))}
                className="w-full rounded border px-2 py-1 text-xs disabled:bg-surface-50" />
    </label>
  );
  const hint = "Paragraphs printed verbatim on every document of this type.";
  if (blocks.length <= PLAIN_TEXT_BLOCKS) {
    return <Panel title="Wording" hint={hint}><div className="space-y-3">{blocks.map((t) => box(t, 3))}</div></Panel>;
  }
  const current = blocks.find((t) => t.key === (picked ?? contract.openTextBlock)) ?? blocks[0];
  return (
    <Panel title="Wording" hint={hint}>
      <div className="flex gap-4">
        <div className="w-56 shrink-0">
          <h3 className="mb-1 text-xs font-semibold text-ink-500">Standing clauses</h3>
          <ul className="text-sm">
            {blocks.map((t) => (
              <li key={t.key}>
                <button type="button" onClick={() => setPicked(t.key)}
                        aria-current={t.key === current.key ? "true" : undefined}
                        className={`${LINK} w-full cursor-pointer rounded px-2 py-1 text-left ${t.key === current.key ? "bg-link-50" : "hover:bg-surface-50"}`}>{t.name}</button>
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0 flex-1">{box(current, 12)}</div>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------
// Footer and logo — the "Page N of M" toggle (on by default only for the quote; the editor reflects
// it), and the logo controls the page hands in as children (they have their own upload state).
// ------------------------------------------------------------------------------------------------

export function FooterAndLogoPanel({ contract, config, apply, disabled, editTitle, children }: PanelProps & { children: ReactNode }) {
  const withholds = editorWithholds(contract);
  if (withholds.pageFooter && withholds.logo) return null; // both rows withheld: nothing to show
  return (
    <Panel title="Footer and logo">
      {!withholds.pageFooter && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={config.pageFooter} disabled={disabled} title={editTitle}
                 aria-label="Print a page footer"
                 onChange={(e) => apply((c) => setPageFooter(c, e.target.checked))} />
          Print “Page N of M” at the foot of every page
        </label>
      )}
      {children}
    </Panel>
  );
}

/** The logo upload alone, for a contract that withholds the header logo while its canvas may carry a
 *  Logo item (container tag PR 3, owner call C1): no page line and no placement. */
export function LogoUploadPanel({ children }: { children: ReactNode }) {
  return <Panel title="Logo image">{children}</Panel>;
}
