// The six guard pages' header-box sites and the customer page's keyed list cells (#574): the two
// lists tests/header-setters.test.ts lifts each `onChange` from and tests/functional-setter-sweep.test.ts
// checks its derived census against.
//
// It is a helper module rather than an export of the per-site test because a vitest test file that
// imports another test file registers the imported file's suites a second time, under the importer:
// the ts-parse.ts precedent, "type-checked and linted but never executed as a suite".
//
// Both lists are hand-written: 31 header rows, 8 keyed-cell rows. What keeps them from rotting is
// the sweep's two agreement checks: every `onChange` in a guard-calling file that calls the bare
// `patchDraft` is derived from the parsed source, and the set of (file, property) pairs must equal
// the header list's; every `onChange` in such a file that calls a guard-fed setter itself is derived
// too, and the set of (file, setter, property) triples must equal the keyed-cell list's. A row added
// to either without a site, or a site added without a row, reds its check.

export type HeaderSetterPage = {
  /** The page's file, under `erp/`. */
  file: string;
  /** The state binding the boxes read at render (`order`, `shipper`, …) and the setter beside it. */
  state: string;
  setter: string;
  /** How a box registers its key with the guard: the `onFocus` expression for key `k`. */
  focus: (k: string) => string;
  /** The keys of the page's header boxes, in source order. A key read from a render-time
   *  variable (the customer's standing notes, `[key]`) is `{ key, computed: true }`. */
  keys: (string | { key: string; computed: true })[];
};

/**
 * The identifier a computed site reads its key from: the customer page's standing notes map three
 * keys through one `textarea`, whose `onFocus` and `onChange` both spell `[key]`. The per-site test
 * builds the `onFocus` it looks for from it, and the sweep spells the derived property `[key]`.
 */
export const COMPUTED_KEY_IDENTIFIER = "key";

export const HEADER_SETTER_PAGES: HeaderSetterPage[] = [
  {
    file: "src/app/orders/[id]/page.tsx", state: "order", setter: "setOrder",
    focus: (k) => `noteFocus("${k}")`,
    keys: ["poNumber", "vsOrderNumber", "customerJobNo", "notes"],
  },
  {
    file: "src/app/shipping/[id]/ShipmentDetail.tsx", state: "shipper", setter: "setShipper",
    focus: (k) => `editGuard.onFocusField("${k}")`,
    keys: ["route", "comments", "freightAmount", "freightClass", "freightDescription", "packageCount", "proNumber", "scacCode"],
  },
  {
    file: "src/app/invoicing/[id]/InvoiceDetail.tsx", state: "invoice", setter: "setInvoice",
    focus: (k) => `editGuard.onFocusField("${k}")`,
    keys: ["poNumber", "termsName", "billTo", "shipTo"],
  },
  {
    file: "src/app/certs/[id]/CertDetail.tsx", state: "cert", setter: "setCert",
    focus: (k) => `editGuard.onFocusField("${k}")`,
    keys: ["freeform", "internalNotes"],
  },
  {
    file: "src/app/customers/[id]/page.tsx", state: "c", setter: "setC",
    focus: (k) => `noteFocusC("${k}")`,
    keys: ["code", "name", "phone", "defaultPo", "creditLimit", "financeChargeRate", "salesTaxRate", "requestDaysOverride",
      "invoiceFolder", { key: "orderNotes", computed: true }],
  },
  {
    file: "src/app/admin/billing/page.tsx", state: "cfg", setter: "setCfg",
    focus: (k) => `editGuard.onFocusField("${k}")`,
    keys: ["salesTaxRate", "certChargeDefault", "financeChargeRate"],
  },
];

/**
 * Each page's sites as `file|property`, the spelling the sweep derives from the parsed source: a
 * plain key as written, a computed one as `[key]` (one row per `onChange`, so the customer's three
 * standing notes are one site). Sorted, duplicates kept, so two sites on one key would show.
 */
export function headerSetterSiteKeys(): string[] {
  return HEADER_SETTER_PAGES.flatMap((page) => page.keys.map((entry) =>
    `${page.file}|${typeof entry === "string" ? entry : `[${COMPUTED_KEY_IDENTIFIER}]`}`)).sort();
}

export type KeyedCellPage = {
  /** The page's file, under `erp/`. */
  file: string;
  /** The collection the cells register with the guard (`noteFocusCell`'s first argument) and the
   *  rows' setter, fed through `applyRows`. The rows' render copy is deliberately not named here:
   *  the per-site test runs each handler without it, so an updater that read it would throw. */
  collection: "addresses" | "contacts";
  setter: string;
  /** The identifier the row is bound to in the list's `map` callback, whose `.id` the handler's
   *  updater and the box's `onFocus` both read. */
  row: string;
  /** The row fields the cells set, in source order. */
  fields: string[];
};

/**
 * The customer page's keyed list cells: each `onChange` reads the typed text in the handler and
 * hands its `applyRows`-fed setter an updater over the rows alone, setting one field of the row
 * whose id it closed over. The `onFocus` each cell is found by is `noteFocusCell("<collection>",
 * <row>.id,"<field>")`, spelled as the page spells it, the missing space after its second comma
 * included (the per-site test compares the attribute's source exactly).
 */
export const KEYED_CELL_PAGES: KeyedCellPage[] = [
  {
    file: "src/app/customers/[id]/page.tsx", collection: "addresses", setter: "setAddresses",
    row: "a", fields: ["name", "street", "city", "state", "zip"],
  },
  {
    file: "src/app/customers/[id]/page.tsx", collection: "contacts", setter: "setContacts",
    row: "ct", fields: ["name", "email", "phone"],
  },
];

/** The `onFocus` expression of the cell of `page` on `field`, as the page spells it. */
export const keyedCellFocus = (page: KeyedCellPage, field: string): string =>
  `noteFocusCell("${page.collection}", ${page.row}.id,"${field}")`;

/**
 * Each keyed cell as `file|setter|property`, the spelling the sweep derives from the parsed source.
 * Sorted, duplicates kept, so two cells on one field would show.
 */
export function keyedCellSiteKeys(): string[] {
  return KEYED_CELL_PAGES.flatMap((page) => page.fields.map((field) => `${page.file}|${page.setter}|${field}`)).sort();
}
