/**
 * The listing of an install's stored templates (weights design §13.2, "The listing"): each stored
 * version judged by the contracts as they stand, through `normalizeStoredConfig`, the function a
 * print and the template editor's read call. Its words are §13.3's, L1 to L7, with the forms
 * ruled for §13.7's points 14 and 37 in docs/execution/2026-10-11-weights-paper/progress.md. The
 * ticket Widths cell's 39 pt forms ("no room … prints past the page", `NOT_MEASURED`, and the
 * STOPS THE MERGE they carried) were retired by owner ruling R-A of 2026-11-17 (#991): a row stops the
 * merge only where an in-use version is REFUSED. The share's words and the `pt` figure are
 * src/lib/template-printed-width.ts's, imported here, so the rule is stated once (#519).
 * Pure: no database and no file read. `scripts/stored-templates.sql` answers what it judges, and
 * `scripts/check-stored-templates.ts` is its command. The running app imports none of the three.
 */
import { ZodError } from "zod";
import {
  TEMPLATE_DOC_TYPES, TemplateConfigError, contractFor, normalizeStoredConfig,
  type TemplateConfig, type TemplateDocTypeString,
} from "../../src/lib/template-contracts/index";
import { pt, sharedContainerWidth, sharedWidthWords, type TicketDocType } from "../../src/lib/template-printed-width";

/** One row of `scripts/stored-templates.sql`'s answer. */
export type ExportedVersion = {
  docType: string; templateId: string; templateName: string; isDefault: boolean; templateDeleted: boolean;
  versionId: string; versionNumber: number; status: string;
  /** The template's pointer names this version. */
  published: boolean;
  /** Live assignments to the template, by code. */
  customers: { code: string; name: string }[];
  config: unknown;
};

export type ListingRow = {
  document: string; template: string; version: string; status: string; customers: string; verdict: string;
  typedLabels: string; hidden: string; moved: string; widths: string; whatToDo: string;
};

/** L1, in order. */
export const LISTING_HEADINGS: readonly string[] = [
  "Document", "Template", "Version", "Status", "Customers", "Verdict",
  "Typed labels", "Hidden", "Moved", "Widths", "What to do",
];

const TICKET_OLD_LABELS = {
  line_pounds: "Pounds", container_count: "# Of Containers",
  total_weight: "Pounds Shipped:", tear_total_weight: "Pounds Shipped:",
};
/** The built-in wording each renamed label had before this pull request, by document type and
 *  field key. `tests/stored-template-check.test.ts` holds it to the labels frozen before any changed. */
export const OLD_BUILT_IN_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  TRAVELER: {
    line_each_weight: "Part Weight", line_weight: "Line Weight", container_qty: "Container Quantity",
    tare_weight: "Tare Weight", gross_weight: "Gross Weight",
  },
  SHIPPER: TICKET_OLD_LABELS,
  MOS_SHIPPER: TICKET_OLD_LABELS,
  CERT: { part_pounds: "Pounds" },
  INVOICE: { col_amount: "Total Wt / Price" },
  QUOTE: { col_amount: "Total Lbs / Price" },
};

/** The ticket fields a config stored before the Tare column and the Tare and Gross weight rows
 *  does not hold. A stored order is judged without them (L5b). */
const ADDED_TICKET_FIELDS: ReadonlySet<string> = new Set(["container_tare", "total_tare", "total_gross"]);

const NONE = "none";
const several = (found: string[]): string => (found.length === 0 ? NONE : found.join("; "));
const isTicket = (docType: TemplateDocTypeString): docType is TicketDocType =>
  docType === "SHIPPER" || docType === "MOS_SHIPPER";

function sectionOf(config: TemplateConfig, key: string) {
  const section = config.sections.find((s) => s.key === key);
  if (section === undefined) throw new Error(`A complete config has no "${key}" section`);
  return section;
}

/** The Widths cell of a ticket config: what each shared column gets, in the share's words (#519).
 *  Its "no room for …: prints past the page" and "not measured" forms, and the STOPS THE MERGE they
 *  carried, are retired (owner ruling R-A, 2026-11-17, #991): under the column clamp a tight container
 *  table breaks its words inside its cells, and a config whose fixed columns and padding pass the
 *  282 pt each half has is refused by the contracts (R-B), so it reads REFUSED here. */
function ticketWidths(docType: TicketDocType, config: TemplateConfig): string {
  const table = sharedContainerWidth(docType, config);
  if (table === null) return "section hidden";
  if (table.each === null) return NONE;
  // `sharedWidthWords` reads one shared column in the singular (point 14, part b).
  return sharedWidthWords(table.shared, table.each);
}

function typedLabels(docType: TemplateDocTypeString, config: TemplateConfig): string {
  const old = OLD_BUILT_IN_LABELS[docType] ?? {};
  const found: string[] = [];
  for (const section of config.sections) {
    for (const field of section.fields) {
      const was = old[field.key];
      if (was === undefined || field.label === null) continue;
      const typed = `${was} typed as "${field.label}"`;
      if (docType === "TRAVELER" && field.key === "gross_weight") {
        found.push(`${typed} (it stays, over the order's three figures)`);
      } else {
        found.push(field.label === was ? `${typed} (the old built-in wording)` : typed);
      }
    }
  }
  return several(found);
}

function hidden(docType: TemplateDocTypeString, config: TemplateConfig): string {
  const found: string[] = [];
  const sectionName = (key: string) => contractFor(docType).sections.find((s) => s.key === key)!.name;
  const fieldHidden = (section: string, key: string) =>
    sectionOf(config, section).fields.some((f) => f.key === key && !f.visible);
  if (isTicket(docType)) {
    if (!sectionOf(config, "totals").visible) found.push(sectionName("totals"));
    if (fieldHidden("totals", "total_weight")) found.push("Net weight row");
  }
  if (docType === "TRAVELER") {
    if (fieldHidden("quantities", "gross_weight")) found.push("Gross Weight column");
    if (!sectionOf(config, "quantities").visible) found.push(sectionName("quantities"));
  }
  return several(found);
}

function moved(docType: TemplateDocTypeString, config: TemplateConfig): string {
  if (!isTicket(docType)) return NONE;
  const builtIn = (key: string) => contractFor(docType).sections.find((s) => s.key === key)!.fields.map((f) => f.key);
  const before = (keys: string[]) => keys.filter((k) => !ADDED_TICKET_FIELDS.has(k)).join(",");
  const isMoved = (key: string) => before(sectionOf(config, key).fields.map((f) => f.key)) !== before(builtIn(key));
  const found: string[] = [];
  if (isMoved("containers")) found.push("container columns moved");
  if (isMoved("totals")) found.push("totals rows moved");
  return several(found);
}

function travelerWidths(config: TemplateConfig): string {
  const typed = sectionOf(config, "quantities").fields.find((f) => f.key === "gross_weight")?.width ?? null;
  if (typed === null) return NONE;
  const builtIn = contractFor("TRAVELER").sections.find((s) => s.key === "quantities")!.fields
    .find((f) => f.key === "gross_weight")!.column!.defaultWidth;
  return `Gross Weight column typed at ${pt(typed)} pt (built-in ${builtIn} pt)`;
}

/** A shape refusal in words: each issue's path, a colon and its message, the issues joined by
 *  "; ". An issue with no path is its message alone. As `readableMessage` of
 *  `src/server/error-message.ts` words one, and never the error's own block of JSON. The listing's
 *  verdict and the command's line for a file it cannot judge both read it. */
export function issueWording(error: ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`))
    .join("; ");
}

/** The thrown sentence: a shape refusal in `issueWording`'s words, or a contract rule's own. */
function refusal(error: unknown): string {
  if (error instanceof ZodError) return issueWording(error);
  if (error instanceof TemplateConfigError) return error.message;
  throw error;
}

/** L2's word for a version. Its status is looked at first, so a version the template's pointer
 *  names is refused too when its status is one this checker does not know. */
function statusOf(version: ExportedVersion): string {
  let notPointedAt: string;
  switch (version.status) {
    case "PUBLISHED": notPointedAt = "earlier"; break;
    case "DRAFT": notPointedAt = "draft"; break;
    case "DISCARDED": notPointedAt = "discarded"; break;
    default: throw new Error(`Version ${version.versionId} has a status this checker does not know: ${version.status}`);
  }
  return version.published ? "in use" : notPointedAt;
}

/** One stored version judged by the contracts as they stand. Throws for a status or a document
 *  type it does not know. */
export function checkStoredVersion(version: ExportedVersion): ListingRow {
  const docType = version.docType as TemplateDocTypeString;
  if (!(TEMPLATE_DOC_TYPES as readonly string[]).includes(docType)) {
    throw new Error(`Version ${version.versionId} has a document type this checker does not know: ${version.docType}`);
  }
  const head = {
    document: contractFor(docType).name,
    template: `${version.templateName}${version.isDefault ? " (default)" : ""}${version.templateDeleted ? " (deleted)" : ""}`,
    version: String(version.versionNumber),
    status: statusOf(version),
    customers: version.customers.length === 0 ? NONE : version.customers.map((c) => c.code).join(", "),
  };
  const inUse = version.published && !version.templateDeleted;
  let config: TemplateConfig;
  try {
    config = normalizeStoredConfig(docType, version.config);
  } catch (error) {
    // A refused version is judged no further: its other cells stay empty.
    return {
      ...head, verdict: `REFUSED: ${refusal(error)}`, typedLabels: "", hidden: "", moved: "", widths: "",
      whatToDo: inUse ? "STOPS THE MERGE" : "listed only",
    };
  }
  const widths = isTicket(docType) ? ticketWidths(docType, config) : null;
  return {
    ...head,
    verdict: "stays valid",
    typedLabels: typedLabels(docType, config),
    hidden: hidden(docType, config),
    moved: moved(docType, config),
    widths: widths !== null ? widths : docType === "TRAVELER" ? travelerWidths(config) : NONE,
    whatToDo: "listed only",
  };
}

/** A cell of the Markdown table: a bar inside it is escaped, and a line break becomes a space. */
const cell = (text: string): string => text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

/** The listing of one database's export, as text. */
export function listing(database: string, versions: readonly ExportedVersion[]): string {
  const line = (cells: readonly string[]) => `| ${cells.map(cell).join(" | ")} |`;
  const rows = versions.map(checkStoredVersion).map((r) => line([
    r.document, r.template, r.version, r.status, r.customers, r.verdict,
    r.typedLabels, r.hidden, r.moved, r.widths, r.whatToDo,
  ]));
  return [`## ${database}`, "", line(LISTING_HEADINGS), `|${LISTING_HEADINGS.map(() => "---").join("|")}|`, ...rows].join("\n");
}

/** True when any row reads STOPS THE MERGE. */
export function stopsTheMerge(versions: readonly ExportedVersion[]): boolean {
  return versions.some((v) => checkStoredVersion(v).whatToDo === "STOPS THE MERGE");
}
