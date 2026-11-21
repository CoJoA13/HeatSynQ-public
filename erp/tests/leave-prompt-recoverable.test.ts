// The leave prompt's two groups (owner ruling R24, 2026-10-22; #704): which sections it says stay
// under Drafts in this tab, and which it says are discarded. `confirmMessage`'s sentences are
// unsaved-guard.test.ts's. This file proves two things that test cannot see: that `confirmDiscard`
// reads the draft store's labels for the page as recoverable, and that every registration of unsaved
// work in `src/` is classed as the owner's ruling needs, one entry per editor, so a section whose
// work a draft keeps is never promised a discard and a plain one is never promised it stays.
//
// vitest runs under node, so `window` is a plain object set and removed here, and the browser draft
// session is a real draft store handed through `peekBrowserDraftSession`, the only seam mocked.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftStore, type DraftStore } from "../src/lib/draft-store";
import { clearUnsaved, confirmMessage, markUnsaved } from "../src/lib/unsaved-guard";
import { shipmentBulkOptions } from "../src/lib/shipment-bulk-recovery";
import { invoiceBulkOptions } from "../src/lib/invoice-bulk-recovery";
import { paymentBulkOptions } from "../src/lib/payment-bulk-recovery";
import { all } from "./helpers/source-lift";
import { scalarAdapter } from "./helpers/draft-store";

const session = vi.hoisted(() => ({ store: null as DraftStore | null }));
vi.mock("../src/lib/draft-session", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/draft-session")>(),
  peekBrowserDraftSession: () => session.store ? { store: session.store } : null,
}));
const { confirmDiscard } = await import("../src/lib/use-unsaved-section");

/** A dirty draft of a section named `label` on `href`, left behind by a departure: its view detached. */
function retain(store: DraftStore, label: string, href: string) {
  const owner = store.getSnapshot().owner!;
  const binding = store.bind({ owner, record: { kind: "order", id: "order-1" }, editor: scalarAdapter.kind, childId: label },
    { label, href }, scalarAdapter);
  const detach = binding.attach("leaving-view");
  binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline: { value: "1905" }, editable: true }, { value: "1905" });
  binding.change(() => ({ value: "1888" }));
  detach();
}

describe("confirmDiscard reads the draft store's labels for the page as recoverable (R24, #704)", () => {
  let asked: string[] = [];
  beforeEach(() => {
    asked = [];
    const store = createDraftStore();
    store.acceptIdentity(store.beginIdentityCheck(), "clerk");
    retain(store, "Charges", "/orders/order-1");
    session.store = store;
    (globalThis as { window?: unknown }).window = {
      location: { pathname: "/orders/order-1" },
      confirm: (message: string) => { asked.push(message); return true; },
    };
  });
  afterEach(() => {
    clearUnsaved("hub-lines");
    session.store = null;
    delete (globalThis as { window?: unknown }).window;
  });

  it("a retained draft alone: the owner's sentence", () => {
    confirmDiscard();
    expect(asked).toEqual(["Charges has unsaved changes. Leave the page? They stay under Drafts in this tab until you save or discard them."]);
  });

  it("beside a plain-registry section: one clause for each", () => {
    markUnsaved("hub-lines", "Lines");
    confirmDiscard();
    expect(asked).toEqual([confirmMessage(["Lines", "Charges"], false, undefined, ["Charges"])]);
    expect(asked[0]).toMatch(/^Lines has unsaved changes, and leaving discards them\. Charges has unsaved changes\. They stay/);
  });

  it("at sign-out, which resets the draft store, every section is discarded as before", () => {
    confirmDiscard({ allDrafts: true });
    expect(asked).toEqual(["Charges and Drafts in this tab have unsaved changes. Leave the page and discard them?"]);
  });
});

// ---- the census ----

const ROOT = join(process.cwd(), "src");
type Site = { file: string; label: string; flagged: boolean };
/** How a registration's work is classed, and why. `store`: the file binds a draft under the same
 *  label, so the store lists it and the prompt reads it from there. `flag`: its work is kept by a
 *  draft bound under another label, so the registration says `recoverable`. `plain`: no draft keeps
 *  it, and leaving discards it. */
type Class = "store" | "flag" | "plain";
const CLASSES: Record<string, Class> = {
  // The nine bulk grids, through SaveButton or (payment application) their own registration.
  'app/orders/[id]/ChargesSection.tsx :: "Charges"': "store",
  'app/orders/[id]/LoadsSection.tsx :: "Loads"': "store",
  'app/orders/[id]/ContainersSection.tsx :: "Containers"': "store",
  'app/orders/[id]/SerialsSection.tsx :: "Serials"': "store",
  'app/invoicing/[id]/InvoiceDetail.tsx :: "Invoice lines"': "store",
  'app/shipping/[id]/ShipmentOrderPanel.tsx :: "Lines"': "store",
  'app/shipping/[id]/ShipmentOrderPanel.tsx :: "Containers"': "store",
  'app/shipping/[id]/ShipmentOrderPanel.tsx :: "Serials"': "store",
  'app/receivables/batches/[id]/BatchDetail.tsx :: "Payment application"': "store",
  // The other recoverable editors.
  'app/admin/templates/[id]/edit/TemplateEditor.tsx :: "Template"': "store",
  'app/parts/[id]/CustomFieldsSection.tsx :: "Custom fields"': "store",
  'app/parts/[id]/ProcessStepsSection.tsx :: "Process steps"': "store",
  'app/certs/[id]/RequirementBlock.tsx :: "Cert results"': "store",
  // The quote's two halves are kept in its one Quote draft (owner's answer 2026-11-03).
  "app/quotes/[id]/QuoteDetail.tsx :: QUOTE_DETAILS_SECTION": "flag",
  "app/quotes/[id]/QuoteDetail.tsx :: QUOTE_LINES_SECTION": "flag",
  // No draft keeps these: the hub's blur-saved Lines, New order (its draft is the server's
  // autosave, not the draft store), a New order line's typed serial range, and a pick list's
  // waiting Terms discount pair.
  'app/orders/[id]/LinesSection.tsx :: "Lines"': "plain",
  'app/orders/new/page.tsx :: "New order"': "plain",
  "app/orders/new/OrderLineCard.tsx :: `Line ${index + 1} serial range`": "plain",
  "components/ReferenceTable.tsx :: labels.plural": "plain",
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name))
    : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []);
}
const relative = (path: string) => path.slice(ROOT.length + 1);
function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Every registration of unsaved work: each `useUnsavedSection` call, and each `<SaveButton>`'s
 *  `section`, which SaveButton registers. SaveButton's own call, of its prop, is the second form. */
function sites(): Site[] {
  return walk(ROOT).flatMap(path => {
    const file = relative(path);
    if (file === "lib/use-unsaved-section.ts" || file === "components/SaveButton.tsx") return [];
    const source = parse(path);
    const calls = all(source, ts.isCallExpression).filter(call => call.expression.getText(source) === "useUnsavedSection")
      .map(call => ({ file, label: call.arguments[1].getText(source), flagged: call.arguments[3]?.getText(source) === "{ recoverable: true }",
        extra: call.arguments.length > 3 && call.arguments[3]?.getText(source) !== "{ recoverable: true }" }));
    for (const call of calls) expect(call.extra, `${file} passes a fourth argument other than the flag`).toBe(false);
    const buttons = [...all(source, ts.isJsxSelfClosingElement), ...all(source, ts.isJsxOpeningElement)]
      .filter(tag => tag.tagName.getText(source) === "SaveButton")
      .map(tag => {
        const attr = tag.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(source) === "section");
        return { file, label: attr?.initializer?.getText(source) ?? "", flagged: false };
      });
    return [...calls.map(({ file: f, label, flagged }) => ({ file: f, label, flagged })), ...buttons];
  });
}

/** The labels a file binds drafts under, read from its own calls: a store `bind`'s `label`, the
 *  order grids' label argument, and the label each shared builder gives its kind, asked of the
 *  builder itself. */
function boundLabels(file: string): Set<string> {
  const source = parse(join(ROOT, file));
  const labels = new Set<string>();
  const stub = { read: vi.fn(), register: vi.fn(), begin: vi.fn() } as never;
  for (const call of all(source, ts.isCallExpression)) {
    const callee = call.expression.getText(source);
    const literal = (node: ts.Node | undefined) => node && ts.isStringLiteral(node) ? node.text : undefined;
    if (callee.endsWith(".bind") && call.arguments[1] && ts.isObjectLiteralExpression(call.arguments[1])) {
      for (const p of call.arguments[1].properties) if (ts.isPropertyAssignment(p) && p.name.getText(source) === "label") labels.add(literal(p.initializer) ?? "");
    }
    if (callee === "orderBulkOptions") labels.add(literal(call.arguments[3]) ?? "");
    if (callee === "shipmentBulkOptions") {
      const kind = literal(call.arguments[3]);
      if (kind) labels.add(shipmentBulkOptions(stub, "ship-1", "so-1", kind as "lines").label);
    }
    if (callee === "invoiceBulkOptions") labels.add(invoiceBulkOptions(stub, "inv-1").label);
    if (callee === "paymentBulkOptions") labels.add(paymentBulkOptions(stub, "batch-1", "pay-1").label);
  }
  return labels;
}

describe("every registration of unsaved work is classed for the leave prompt (R24, #704)", () => {
  const found = sites();
  const key = (site: Site) => `${site.file} :: ${site.label}`;

  it("the census is complete: a new registration is a decision, not a default", () => {
    expect([...new Set(found.map(key))].sort()).toEqual(Object.keys(CLASSES).sort());
  });

  it.each(Object.entries(CLASSES))("%s is %s", (entry, cls) => {
    const matching = found.filter(site => key(site) === entry);
    expect(matching.length).toBeGreaterThan(0);
    for (const site of matching) {
      expect(site.flagged, "only a `flag` registration says recoverable").toBe(cls === "flag");
      const bound = boundLabels(site.file);
      const label = /^["'`](.*)["'`]$/.exec(site.label)?.[1];
      if (cls === "store") expect([...bound], "the file binds a draft under this label").toContain(label);
      if (cls === "plain" && label !== undefined) expect([...bound]).not.toContain(label);
      if (cls === "flag") expect(bound.size, "a flagged registration's work is kept by a draft its file binds").toBeGreaterThan(0);
    }
  });
});
