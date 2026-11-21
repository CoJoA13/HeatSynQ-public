// Pure constants — safe to import from client components (no server imports).
import type { DecimalBox } from "./decimal-entry";
import { TARE_EACH } from "./order-boxes";
import { DISCOUNT_PERCENT } from "./rate-boxes";
import { DISCOUNT_DAYS, NET_DAYS } from "./whole-number-boxes";
import type { WholeNumberBox } from "./whole-number-entry";
import { TARE_EACH_LB } from "./weight-terms";

export const REFERENCE_KINDS = [
  "glAccount", "material", "inspectionScale", "inspectionCode", "containerType",
  "carrier", "terms", "paymentType", "commentSnippet", "specification",
  "endingStatement", // Phase 6 ruling 13 — the eleventh kind, the quote footer's statement list
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** The Pick lists screen's order (the file's; owner 2026-11-01 on #826). `REFERENCE_KINDS` stays the
 *  server's list. */
export const PICK_LIST_ORDER: readonly ReferenceKind[] = [
  "containerType", "material", "glAccount", "inspectionScale", "inspectionCode",
  "carrier", "terms", "paymentType", "commentSnippet", "specification", "endingStatement",
];

/** The list a Pick lists link names in its `?kind=` query (#708), or null when it names none the
 *  screen has, which leaves the screen on its default list. */
export function pickListKind(query: string | null): ReferenceKind | null {
  return REFERENCE_KINDS.find((kind) => kind === query) ?? null;
}

export const REFERENCE_LABELS: Record<ReferenceKind, { singular: string; plural: string; nameLabel: string }> = {
  glAccount:       { singular: "GL account",       plural: "GL accounts",       nameLabel: "Account number" },
  material:        { singular: "Material",         plural: "Materials",         nameLabel: "Name" },
  inspectionScale: { singular: "Inspection scale", plural: "Inspection scales", nameLabel: "Name" },
  inspectionCode:  { singular: "Inspection code",  plural: "Inspection codes",  nameLabel: "Code" },
  containerType:   { singular: "Container type",   plural: "Container types",   nameLabel: "Name" },
  carrier:         { singular: "Carrier",          plural: "Carriers",          nameLabel: "Name" },
  terms:           { singular: "Terms",            plural: "Terms",             nameLabel: "Name" },
  paymentType:     { singular: "Payment type",     plural: "Payment types",     nameLabel: "Name" },
  commentSnippet:  { singular: "Comment snippet",  plural: "Comment snippets",  nameLabel: "Name" },
  specification:   { singular: "Specification",    plural: "Specifications",    nameLabel: "Name" },
  endingStatement: { singular: "Ending statement", plural: "Ending statements", nameLabel: "Name" },
};

/** Kinds readable by any signed-in user. A distinct set from ReferenceKind, and NOT a subset:
 *  it drops glAccount (the one kind no data-entry screen reads — keeping chart-of-accounts
 *  numbers off a route everyone can reach) and adds processStepCode, which is not a reference
 *  kind at all but which the Phase 2C-3 Process Steps designer must read. */
export const PICKLIST_KINDS = [
  ...REFERENCE_KINDS.filter((k) => k !== "glAccount"),
  "processStepCode",
] as const;
export type PickListKind = (typeof PICKLIST_KINDS)[number];

/** Extra columns beyond name/active, for the generic list UI and Excel export.
 *  `kind: "number"` is Task 4's addition, for Terms' netDays/discountDays — the ReferenceTable
 *  Add row and the paste importer both only ever handle raw strings otherwise, and the server's
 *  netDays/discountDays columns are plain `z.number().int()` (not string-accepting like
 *  `decimalField`), so those two entry points coerce a "number" field to an actual JS number
 *  before the value ever reaches the API.
 *  `kind: "decimal"` (Task 4 fix round 1) is a SEPARATE kind from plain `"text"`, even though a
 *  `decimalField`-bound value is a string on the wire same as text: `"text"` covers genuine free
 *  text (glAccount.description, commentSnippet/specification.text) where an explicit `""` is a
 *  legitimate value to store, but a `decimalField` column rejects `""` outright (it isn't
 *  `.nullable()`-shaped for an empty string, only for an absent key) — so ReferenceTable.tsx's Add
 *  row needs to know, per field, whether a cleared input means "store empty text" or "no value, drop
 *  the key" (Terms.discountPercent). Conflating the two by leaving discountPercent `"text"` was
 *  exactly the bug this kind exists to prevent.
 *  `kind: "boolean"` (Phase 6, for endingStatement.isDefault — the first boolean extra column;
 *  the nearest in-grid precedent is the Active column itself, so it follows that shape at every
 *  surface): the grid renders it as a checkbox — interactive on existing rows like the Active
 *  toggle (a PUT of `{ [key]: !current }`, gated admin.edit), a plain checkbox on the Add row —
 *  the export writes the raw boolean (a TRUE/FALSE cell, exactly how Active already exports),
 *  and the paste importer coerces a case-insensitive "true"/"false" cell to a real boolean
 *  before the server's `z.boolean()` sees it (anything else stays a string so zod's own
 *  "expected boolean" names the bad cell, the numberColumns philosophy). A blank cell is
 *  dropped like every other optional field, so the column default applies.
 *  `hint` is optional, generic UI-note text shown under an Add-row input — used here for the
 *  early-pay discount's all-or-nothing pairing.
 *  `editable` (the weights design §9.4, widened by owner ruling R18, #680) marks a column whose value
 *  can be changed on an EXISTING row. Name is editable on every kind, in the grid itself. Every text,
 *  number and decimal column carries the flag; a `ref` column does not, and is set only when the row
 *  is added or pasted (R18). A `boolean` column has its own checkbox and needs none.
 *  `tests/reference-table-inline-edit.test.tsx` holds that census.
 *  `multiline` (#680) marks a text column drawn as a textarea on an existing row: an input would
 *  drop a stored line break, and leaving the box would then save the text without it.
 *  `paired` (owner ruling 2026-11-02, #680) marks Terms' Discount % and Discount days, which the
 *  server takes both or neither (`assertDiscountPairAfterUpdate`), so they save together:
 *  `src/lib/terms-discount-pair.ts`. */
export const REFERENCE_EXTRA_FIELDS: Record<
  ReferenceKind,
  { key: string; label: string; kind: "text" | "ref" | "number" | "decimal" | "boolean"; hint?: string; editable?: true; multiline?: true; paired?: true; box?: DecimalBox; whole?: WholeNumberBox }[]
> = {
  glAccount:       [{ key: "description",    label: "Description",   kind: "text", editable: true }],
  inspectionCode:  [{ key: "defaultScaleId", label: "Default scale", kind: "ref" }],
  paymentType:     [{ key: "glAccountId",    label: "GL account",    kind: "ref" }],
  commentSnippet:  [{ key: "text",           label: "Text",          kind: "text", editable: true, multiline: true }],
  specification:   [{ key: "text",           label: "Text",          kind: "text", editable: true, multiline: true }],
  material: [], inspectionScale: [], carrier: [],
  // Weights design §9.4: a container type's default tare each, the weight of one empty container in
  // pounds. "decimal", as Terms' Discount % is: a cleared Add-row box drops the key, so the type is
  // saved with no figure. The label is the design's §9.5, row D1.
  containerType: [{ key: "tareEach", label: TARE_EACH_LB, kind: "decimal", editable: true, box: TARE_EACH.box }],
  terms: [
    // `whole` (ruling 19, G5-4): the Add row and paste read a "number" column through the
    // whole-number rule with this box, and refuse by its sentence.
    { key: "netDays", label: "Net days", kind: "number", editable: true, whole: NET_DAYS },
    { key: "discountPercent", label: "Discount %", kind: "decimal", editable: true, paired: true, box: DISCOUNT_PERCENT.box, hint: "needs Discount days too" },
    { key: "discountDays", label: "Discount days", kind: "number", editable: true, paired: true, hint: "needs Discount % too", whole: DISCOUNT_DAYS },
  ],
  endingStatement: [
    { key: "text",      label: "Text",    kind: "text", editable: true, multiline: true },
    { key: "isDefault", label: "Default", kind: "boolean", hint: "setting it clears the current default" },
  ],
};
