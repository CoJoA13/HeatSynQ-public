import { createReference, assertKind, resolveLinkNamesForBatch } from "./reference";
import { readableMessage } from "./error-message";
import { REFERENCE_EXTRA_FIELDS } from "../lib/reference-constants";
import { nameKey } from "../lib/reference-links";
import { readWholeNumber, wholeNumberRefusal } from "../lib/whole-number-entry";
import { parseRecords, isBlankRecord, overflowError } from "./tsv";

export type PasteResult = { created: number; errors: { row: number; message: string }[] };

/**
 * Creates every valid row and collects failures per row rather than aborting the batch —
 * a single typo in row 40 must not discard the 39 rows above it.
 *
 * Uses `parseRecords` directly (rather than `parseTsv`, which drops blank lines before row
 * numbers are assigned) so a reported row number is always the 1-based line the pasted text
 * actually occupies — including blank lines, which the user's spreadsheet still counts even
 * though they create nothing here, and including quoted cells that span several physical lines,
 * where the record is reported at the line it *starts* on.
 */
export async function pasteReference(kind: string, text: string): Promise<PasteResult> {
  assertKind(kind);
  const extraFields = REFERENCE_EXTRA_FIELDS[kind];
  const columns = ["name", ...extraFields.map((f) => (f.kind === "ref" ? nameKey(f.key) : f.key))];
  // "number"-kind columns (Terms' netDays/discountDays, Task 4) are real `z.number().int()`
  // fields server-side, not string-accepting like `decimalField` — every cell off the sheet is a
  // string, so these need converting before createReference ever sees them, the same reason
  // ReferenceTable.tsx's Add row converts them.
  // Each "number" column's whole-number box (ruling 19, G5-4): a cell is read by the rule and a
  // refusal is the row's error in the box's own sentence, before anything is sent.
  const numberBoxes = new Map(extraFields.filter((f) => f.kind === "number").map((f) => [f.key, f.whole]));
  // "boolean"-kind columns (endingStatement.isDefault, Phase 6) are `z.boolean()` server-side and
  // export as real boolean cells, which Excel renders — and a copy-paste therefore delivers — as
  // TRUE/FALSE text. Coerced case-insensitively; anything else stays the original string so zod's
  // own "expected boolean" names the bad cell per-row, the numberColumns philosophy.
  const booleanColumns = new Set(extraFields.filter((f) => f.kind === "boolean").map((f) => f.key));
  const { records, error } = parseRecords(text);

  const errors: PasteResult["errors"] = [];
  let created = 0;
  // Each row's input is built first, so the link names of the whole paste (`defaultScaleName`,
  // `glAccountName`) are resolved in one read per column before the loop (G5-7) instead of one per
  // row; an overflowing row keeps its place in the errors. The per-row create and its partial
  // success are as they were.
  const prepared: { rowNumber: number; input: Record<string, unknown> | null; overflow: string | null }[] = [];
  for (const record of records) {
    if (isBlankRecord(record.fields)) continue;
    const rowNumber = record.startLine;
    const overflow = overflowError(record.fields, columns);
    if (overflow) { prepared.push({ rowNumber, input: null, overflow }); continue; }
    const row = Object.fromEntries(columns.map((c, idx) => [c, record.fields[idx] ?? ""]));
    // A "number" cell that is not a whole number within its box is this row's error, in the
    // box's sentence (ruling 19, G5-4: it used to reach zod as a string, or as 100 for "1e2").
    const wholeRefusal = [...numberBoxes].map(([key, box]) => (box ? wholeNumberRefusal(row[key] ?? "", box) : null))
      .find((r): r is string => r !== null);
    if (wholeRefusal !== undefined) { prepared.push({ rowNumber, input: null, overflow: wholeRefusal }); continue; }
    // Drop empty optional cells so zod's .optional() applies instead of receiving "".
    const input = Object.fromEntries(
      Object.entries(row)
        .filter(([k, v]) => k === "name" || v !== "")
        // A "number" cell is sent as the whole number it spells (read by the rule above); a
        // column with no box is left as the original string rather than becoming NaN, so the
        // server's "Expected number, received string" explains it, as ReferenceTable.tsx's
        // buildPayload() does.
        .map(([k, v]): [string, unknown] => {
          if (numberBoxes.has(k)) {
            const box = numberBoxes.get(k);
            const reading = box ? readWholeNumber(v, box) : { ok: false as const };
            return [k, reading.ok ? reading.value : v];
          }
          if (booleanColumns.has(k)) {
            const s = v.trim().toLowerCase();
            return s === "true" ? [k, true] : s === "false" ? [k, false] : [k, v];
          }
          return [k, v];
        }),
    );
    prepared.push({ rowNumber, input, overflow: null });
  }
  const resolvedLinks = await resolveLinkNamesForBatch(kind, prepared.flatMap((p) => (p.input === null ? [] : [p.input])));
  for (const { rowNumber, input, overflow } of prepared) {
    if (input === null) { errors.push({ row: rowNumber, message: overflow ?? "" }); continue; }
    try {
      await createReference(kind, input, resolvedLinks);
      created++;
    } catch (err) {
      errors.push({ row: rowNumber, message: readableMessage(err) });
    }
  }
  // A structural parse failure (unterminated/malformed quoted cell) can only ever be the last
  // thing found — everything after it was consumed while scanning for the missing close quote —
  // so it's reported once, after every record parsed ahead of it has already been tried.
  if (error) errors.push({ row: error.line, message: error.message });
  return { created, errors };
}
