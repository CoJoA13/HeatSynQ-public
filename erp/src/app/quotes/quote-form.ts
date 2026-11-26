// Pure client-safe module shared by the /quotes list page and the /quotes/[id] detail page:
// local mirrors of src/server/quotes.ts's read models (NOT imported from src/server/** —
// CLAUDE.md "Constraints that will bite you": a client component pulling from there drags
// node:async_hooks and Prisma into the browser bundle), the detail page's form state, and the
// ONE place the PATCH payload is built.
//
// THE ROUND-TRIP CONTRACT (task-08-brief.md item 4). `updateQuote` (Task 4) is a diff-and-write:
// a kept row whose payload values equal the stored ones gets NO write, so a save payload built
// correctly from an unchanged load is a server-side no-op. Two rules make that true, both
// encoded in `lineFormsFrom`/`linesPayload` below and nowhere else:
//
//  - `eachWeight` RIDES ALONG on free-text lines. The tests' `linesPayloadFrom` (Task 4's
//    documented round-trip shape) OMITS it — its known Minor 2 — and a client copying it as-is
//    sends `eachWeight: undefined` → stored as null, silently blanking a free-text line's weight
//    on every save. This module carries the loaded value back.
//  - A part-linked line's free-text columns (and eachWeight) are sent BLANK, exactly as
//    `linesPayloadFrom` does. The detail read resolves those fields FROM THE PART for a linked
//    line, so echoing them back would write the part's live identity into the line's dormant
//    text columns; blank-as-sent is Task 4 deviation 5's documented round-trip shape (for a line
//    that was never free-text, the stored columns are already ""/null, so blank IS the no-op).
//
// The header is diffed CLIENT-side (`headerPatch`): `updateQuote` patches every header key the
// payload carries even when the value is unchanged (only the line tree is diff-and-write), so an
// unchanged field is simply not sent, and a fully unchanged form sends no request at all (the
// PATCH route 400s an empty body by design). `customerId` is never sent — immutable (spec §4.1),
// and echoing it back only mints a no-op audit entry (Task 4 review, Minor 3).
import type { PricePerValue } from "@/lib/part-constants";
import type { QuoteStatusValue } from "@/lib/quote-constants";
import { decimalRefusal } from "@/lib/decimal-entry";
import {
  BREAK_PRICE, BREAK_THRESHOLD, MINIMUM_CHARGE, QUOTE_EACH_WEIGHT, SETUP_CHARGE, UNIT_PRICE,
  type PriceBox,
} from "@/lib/price-boxes";
import { inMenuOrder } from "@/lib/menu-order";

// ---------------------------------------------------------------------------------------------
// Read-model mirrors (src/server/quotes.ts: QuoteBreakRow/QuotePriceRow/QuoteLineDetail/
// QuoteDetail/QuoteRow/QuoteWorklist/QuoteCloseResult/LinkedOpenOrder).
// ---------------------------------------------------------------------------------------------

export type LinkedOrderRef = { id: string; orderNumber: number };

export type QuoteBreakData = { id: string; threshold: number; price: number };
export type QuotePriceData = {
  id: string; processStepCodeId: string; stepCode: string; stepName: string; position: number;
  setupCharge: number | null; unitPrice: number | null; minimumCharge: number | null;
  pricePer: PricePerValue; notes: string; breaks: QuoteBreakData[];
};
export type QuoteLineData = {
  id: string; position: number; partId: string | null;
  /** Resolved live-or-text (quotes.ts): a linked line reads these FROM THE PART; a free-text
   *  line reads its own columns. One field set either way. */
  partNumber: string; partName: string; partDescription: string; material: string;
  /** The line's OWN material columns (#541), raw: a pick from the Materials list, or the text
   *  typed before the list existed. `material` above is the resolved string the paper prints. */
  materialId: string | null; materialText: string;
  /** The linked part's own material id (null on a free-text line), for Switch to free text. */
  partMaterialId: string | null;
  eachWeight: number | null;
  quotedQty: number | null; quotedUnlimited: boolean;
  linkedOrderCount: number; linkedOrders: LinkedOrderRef[];
  prices: QuotePriceData[];
};
export type QuoteDetailData = {
  id: string; quoteNumber: number; status: QuoteStatusValue; expired: boolean;
  customerId: string; customerCode: string; customerName: string;
  contactId: string | null; contactName: string;
  quoteDate: string; effectiveDate: string; expiryDate: string; followUpDate: string | null;
  rfqNumber: string; quotedById: string; quotedByName: string;
  endingStatementId: string | null; endingStatementName: string; endingStatementText: string;
  closeReason: string; closedAt: string | null; closedByName: string;
  notes: string; internalNotes: string; deletedAt: string | null;
  lines: QuoteLineData[];
};
export type QuoteCloseResultData = { quote: QuoteDetailData; linkedOpenOrders: LinkedOrderRef[] };
/** Mutation responses (POST /api/quotes, PATCH /api/quotes/[id], attach-part): the detail plus
 *  ruling 7's overlap-save warnings — advisory, never blocking (mirrors QuoteMutationResult). */
export type QuoteMutationData = QuoteDetailData & { warnings: string[] };

export type QuoteRowData = {
  id: string; quoteNumber: number;
  customerId: string; customerCode: string; customerName: string;
  status: QuoteStatusValue; expired: boolean;
  quoteDate: string; effectiveDate: string; expiryDate: string; followUpDate: string | null;
  rfqNumber: string; quotedByName: string; lineCount: number;
};
export type QuoteWorklistData = {
  followUpDue: { count: number; rows: QuoteRowData[] };
  expired: { count: number; rows: QuoteRowData[] };
};

// ---------------------------------------------------------------------------------------------
// Form state. Every numeric field is held as the STRING the bound input shows (the parts/[id]
// PricingSection precedent — the server's decimalField schemas accept a decimal string as-is);
// `key` is the React list key (the row's own id for loaded rows, a minted client key for added
// ones) and never crosses the wire.
// ---------------------------------------------------------------------------------------------

export type BreakForm = { id?: string; key: string; threshold: string; price: string };
export type PriceForm = {
  id?: string; key: string;
  processStepCodeId: string;
  /** Display fallback for the step select when the pick-list is unavailable (the R3
   *  synthesized-option rule) — loaded rows carry their live code/name from the detail. */
  stepCode: string; stepName: string;
  setupCharge: string; unitPrice: string; minimumCharge: string;
  pricePer: PricePerValue; notes: string;
  breaks: BreakForm[];
};
export type LineForm = {
  id?: string; key: string;
  partId: string | null;
  partNumberText: string; partNameText: string; partDescriptionText: string;
  /** A free-text line's Material (#541): a pick from the Materials list, or (null) none. Typed
   *  `materialText` is only ever the text a line held before the list; picking clears it. */
  materialId: string | null; materialText: string;
  eachWeight: string;
  quotedQty: string; quotedUnlimited: boolean;
  prices: PriceForm[];
  /** Display-only (the §5.14 linked-line indicator + proactive disable) — never sent. */
  linkedOrders: LinkedOrderRef[];
};
export type HeaderForm = {
  contactId: string; // "" = none
  quoteDate: string; effectiveDate: string; expiryDate: string;
  followUpDate: string; // "" = none
  rfqNumber: string;
  quotedById: string;
  endingStatementId: string; // "" = none
  notes: string; internalNotes: string;
};

const numStr = (n: number | null): string => (n === null ? "" : String(n));

export function headerFormFrom(d: QuoteDetailData): HeaderForm {
  return {
    contactId: d.contactId ?? "",
    quoteDate: d.quoteDate, effectiveDate: d.effectiveDate, expiryDate: d.expiryDate,
    followUpDate: d.followUpDate ?? "",
    rfqNumber: d.rfqNumber,
    quotedById: d.quotedById,
    endingStatementId: d.endingStatementId ?? "",
    notes: d.notes, internalNotes: d.internalNotes,
  };
}

export function lineFormsFrom(d: QuoteDetailData): LineForm[] {
  return d.lines.map((l) => ({
    id: l.id, key: l.id,
    partId: l.partId,
    // The blank-when-linked rule — see the module comment. A free-text line's fields are its own
    // stored columns (the detail read guarantees it), so they round-trip verbatim.
    partNumberText: l.partId !== null ? "" : l.partNumber,
    partNameText: l.partId !== null ? "" : l.partName,
    partDescriptionText: l.partId !== null ? "" : l.partDescription,
    // The RAW columns (#541), never the resolved `material`: on a picked line that is the
    // material's name, and sending it back as text beside the id would change the stored text.
    materialId: l.partId !== null ? null : l.materialId,
    materialText: l.partId !== null ? "" : l.materialText,
    eachWeight: l.partId !== null ? "" : numStr(l.eachWeight),
    quotedQty: numStr(l.quotedQty),
    quotedUnlimited: l.quotedUnlimited,
    prices: l.prices.map((p) => ({
      id: p.id, key: p.id,
      processStepCodeId: p.processStepCodeId, stepCode: p.stepCode, stepName: p.stepName,
      setupCharge: numStr(p.setupCharge), unitPrice: numStr(p.unitPrice),
      minimumCharge: numStr(p.minimumCharge),
      pricePer: p.pricePer, notes: p.notes,
      breaks: p.breaks.map((b) => ({
        id: b.id, key: b.id, threshold: String(b.threshold), price: String(b.price),
      })),
    })),
    linkedOrders: l.linkedOrders,
  }));
}

/** Only the header keys whose form value differs from the loaded baseline — see the module
 *  comment on why the header is client-diffed. ""-vs-null translation happens here, once. */
export function headerPatch(cur: HeaderForm, base: HeaderForm): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (cur.contactId !== base.contactId) patch.contactId = cur.contactId || null;
  if (cur.quoteDate !== base.quoteDate) patch.quoteDate = cur.quoteDate;
  if (cur.effectiveDate !== base.effectiveDate) patch.effectiveDate = cur.effectiveDate;
  if (cur.expiryDate !== base.expiryDate) patch.expiryDate = cur.expiryDate;
  if (cur.followUpDate !== base.followUpDate) patch.followUpDate = cur.followUpDate || null;
  if (cur.rfqNumber !== base.rfqNumber) patch.rfqNumber = cur.rfqNumber;
  if (cur.quotedById !== base.quotedById) patch.quotedById = cur.quotedById;
  if (cur.endingStatementId !== base.endingStatementId) {
    patch.endingStatementId = cur.endingStatementId || null;
  }
  if (cur.notes !== base.notes) patch.notes = cur.notes;
  if (cur.internalNotes !== base.internalNotes) patch.internalNotes = cur.internalNotes;
  return patch;
}

/** One line's wire shape, shared verbatim by the payload builder and the changed-lines compare
 *  (`quotedQty` stays the raw string here — the compare must never throw on mid-edit text; the
 *  payload builder converts and validates it on top). */
function lineShape(l: LineForm) {
  const linked = l.partId !== null;
  // `?? null`: defence only. Drafts live in memory and the schema is quote-v2, so no draft without the
  // key reaches here today; quote-recovery.ts still reads the key as optional.
  const materialId = linked ? null : (l.materialId ?? null);
  return {
    ...(l.id !== undefined ? { id: l.id } : {}),
    partId: l.partId,
    partNumberText: linked ? "" : l.partNumberText,
    partNameText: linked ? "" : l.partNameText,
    partDescriptionText: linked ? "" : l.partDescriptionText,
    materialId,
    // A pick replaces typed text (the server stores a picked line's text blank, ruling 3).
    materialText: linked || materialId !== null ? "" : l.materialText,
    // The eachWeight carry — the whole point of this module (Task 4 review, Minor 2).
    eachWeight: linked || l.eachWeight.trim() === "" ? null : l.eachWeight,
    quotedQty: l.quotedQty,
    quotedUnlimited: l.quotedUnlimited,
    prices: l.prices.map((p) => ({
      ...(p.id !== undefined ? { id: p.id } : {}),
      processStepCodeId: p.processStepCodeId,
      setupCharge: p.setupCharge.trim() === "" ? null : p.setupCharge,
      unitPrice: p.unitPrice.trim() === "" ? null : p.unitPrice,
      minimumCharge: p.minimumCharge.trim() === "" ? null : p.minimumCharge,
      pricePer: p.pricePer,
      notes: p.notes,
      breaks: p.breaks.map((b) => ({
        ...(b.id !== undefined ? { id: b.id } : {}),
        threshold: b.threshold, price: b.price,
      })),
    })),
  };
}

/** "Did the user change the line tree at all?" — compared over the exact wire shape, so an edit
 *  the payload would not send (typing into a free-text column of a line that then got a part
 *  picked) never counts as a change, and add/remove/reorder always does. */
export function linesComparable(lines: LineForm[]): string {
  return JSON.stringify(lines.map(lineShape));
}

export type LinesPayload =
  | { ok: true; lines: Record<string, unknown>[] }
  | { ok: false; errors: string[] };

/** The `lines` array for PATCH /api/quotes/[id] — Task 4's array-replace: rows with an id are
 *  updated in place, rows without are created, live rows missing are soft-deleted. Client-side
 *  checks cover what would otherwise produce an unhelpful zod message (the InvoiceLinesGrid qty
 *  precedent): the three line refusals, and every decimal box through the one rule
 *  (`decimalRefusal`, with each box's label and limits from `price-boxes.ts`), each named by its
 *  place (`Line N, operation M, break K, <label>`). Every refusal is listed, in screen order, never
 *  only the first. A linked line's Each weight is never checked: the box is not shown and its text
 *  is never sent. Business rules stay server-side and surface verbatim (§5.13). The text is sent
 *  as typed (the server's rule trims): `lineShape` is also the changed-lines comparison. */
export function linesPayload(lines: LineForm[]): LinesPayload {
  const out: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const check = (name: string, text: string, box: PriceBox) => {
    const refusal = decimalRefusal(`${name}, ${box.label}`, text, box.box);
    if (refusal !== null) errors.push(refusal);
  };
  for (const [i, l] of lines.entries()) {
    const label = `Line ${i + 1}`;
    if (l.partId === null && l.partNumberText.trim() === "") {
      errors.push(`${label}: pick a part or enter a free-text part number.`);
    }
    let quotedQty: number | null = null;
    if (l.quotedQty.trim() !== "") {
      const qty = Number(l.quotedQty);
      if (!Number.isInteger(qty) || qty < 1) {
        errors.push(`${label}: quoted quantity must be a whole number of at least 1.`);
      } else {
        quotedQty = qty;
      }
    }
    if (l.partId === null) check(label, l.eachWeight, QUOTE_EACH_WEIGHT);
    let blankBreak = false;
    for (const [j, p] of l.prices.entries()) {
      const op = `${label}, operation ${j + 1}`;
      check(op, p.setupCharge, SETUP_CHARGE);
      check(op, p.unitPrice, UNIT_PRICE);
      check(op, p.minimumCharge, MINIMUM_CHARGE);
      for (const [k, b] of p.breaks.entries()) {
        if (b.threshold.trim() === "" || b.price.trim() === "") blankBreak = true;
        const brk = `${op}, break ${k + 1}`;
        check(brk, b.threshold, BREAK_THRESHOLD);
        check(brk, b.price, BREAK_PRICE);
      }
    }
    if (blankBreak) {
      errors.push(`${label}: a price break needs both a threshold and a price — delete the break instead of blanking it.`);
    }
    out.push({ ...lineShape(l), quotedQty });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, lines: out };
}

// ---------------------------------------------------------------------------------------------
// The free-text line's Material drop-down (#541; owner rulings 2026-10-15). Decided here, never
// inline, so the options and what a pick writes can be tested without a renderer.
// ---------------------------------------------------------------------------------------------

type MaterialPickOption = { id: string; name: string; active: boolean };
export type MaterialChoice = { value: string; label: string };

/** The value of the option standing for a line's typed text. Never a material id (ids are cuids)
 *  and never "" (that is `— none —`). */
export const TYPED_MATERIAL = "typed:";
export const UNAVAILABLE_MATERIAL = "Unavailable selection";

/** The select's value and options for one free-text line.
 *  - A line holding only typed text (ruling 3) shows it first, as `<text> (typed)`, selected
 *    until the operator picks; it keeps printing until then.
 *  - `— none —`, then every active material (list only, ruling 2).
 *  - The line's current material even when inactive (`(inactive)`), or `Unavailable selection`
 *    when the list does not hold it.
 *  `materials` is null when the list failed to load: the select is greyed by the page, and the
 *  current pick is named by `loadedName` (the detail's resolved name) when there is one. */
export function materialOptions(
  materials: readonly MaterialPickOption[] | null,
  line: { materialId: string | null; materialText: string },
  loadedName?: string,
): { value: string; options: MaterialChoice[] } {
  const materialId = line.materialId ?? null;
  const typed = materialId === null && line.materialText.trim() !== "";
  const options: MaterialChoice[] = [];
  if (typed) options.push({ value: TYPED_MATERIAL, label: `${line.materialText} (typed)` });
  options.push({ value: "", label: "— none —" });
  // The materials by name, each digit run by value (#1056 ruling 6).
  for (const m of inMenuOrder(materials ?? [], (x) => x.name)) {
    if (m.active || m.id === materialId) {
      options.push({ value: m.id, label: m.active ? m.name : `${m.name} (inactive)` });
    }
  }
  if (materialId !== null && !(materials ?? []).some((m) => m.id === materialId)) {
    options.push({
      value: materialId,
      label: materials === null && loadedName ? loadedName : UNAVAILABLE_MATERIAL,
    });
  }
  return { value: materialId ?? (typed ? TYPED_MATERIAL : ""), options };
}

/** What choosing an option writes onto the line: a material sets the id and clears the typed
 *  text; `— none —` clears both; the typed option (already the current value) writes nothing. */
export function pickMaterial(value: string): { materialId: string | null; materialText: string } | null {
  if (value === TYPED_MATERIAL) return null;
  return { materialId: value === "" ? null : value, materialText: "" };
}

export type PartDisplay = {
  partNumber: string; name: string; materialId: string | null; material: string; eachWeight: string;
};
export const BLANK_PART_DISPLAY: PartDisplay = { partNumber: "", name: "", materialId: null, material: "", eachWeight: "" };

/** A part-linked line's part identity: the parts catalog's row first (covers re-picks), else the
 *  loaded detail line's own resolved identity when it is the same part (covers a missing
 *  parts.view or a catalog fetch failure), else blank. The loaded line supplies the part's
 *  material id (`partMaterialId`) so Switch to free text works without the catalog. */
export function partDisplayFor(
  partId: string | null,
  fromCatalog: { partNumber: string; name: string; materialId?: string | null; materialName?: string | null; eachWeight: number } | undefined,
  loaded: QuoteLineData | undefined,
): PartDisplay {
  if (fromCatalog) {
    return {
      partNumber: fromCatalog.partNumber, name: fromCatalog.name, materialId: fromCatalog.materialId ?? null,
      material: fromCatalog.materialName ?? "", eachWeight: String(fromCatalog.eachWeight),
    };
  }
  if (loaded && loaded.partId === partId) {
    return {
      partNumber: loaded.partNumber, name: loaded.partName, materialId: loaded.partMaterialId, material: loaded.material,
      eachWeight: loaded.eachWeight === null ? "" : String(loaded.eachWeight),
    };
  }
  return BLANK_PART_DISPLAY;
}

/** "Switch to free text" on a part-linked line: the paper's current identity becomes the line's
 *  own, and the part's material is carried into the drop-down by id (ruling 5). The material's
 *  NAME is never turned into typed text (ruling 2, list only): with no id known the Material
 *  starts blank (`— none —`). */
export function freeTextFromPart(part: {
  partNumber: string; name: string; materialId: string | null; eachWeight: string;
}): Pick<LineForm, "partId" | "partNumberText" | "partNameText" | "materialId" | "materialText" | "eachWeight"> {
  return {
    partId: null,
    partNumberText: part.partNumber,
    partNameText: part.name,
    materialId: part.materialId,
    materialText: "",
    eachWeight: part.eachWeight,
  };
}
