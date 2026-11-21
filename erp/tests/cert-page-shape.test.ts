import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { certTabs } from "@/lib/cert-tabs";
import { jsxTags, jsxTexts, mentions } from "./helpers/jsx-source";

// How the certification page is shaped since PR 5 of the UX redesign (spec §4.4; the owner's
// rulings of 2026-10-31 on #820): a PageHeader titled "Certification #N" (the customer, scope and
// printed state in its subtitle), its actions Print certificate and the title-row Void (ruling 8);
// three RecordTabs over the mounted sections from `src/lib/cert-tabs.ts`; the At a glance card from
// the loaded record, holding the print sentence and message; Void asking through the modal;
// Documents headed Scope / Created with an "Open PDF" link; the block's frozen range as one
// "Required …" line, its Value heading by the scale, "Add another reading"; the notes labelled
// "Certification text" and "Internal notes (never print)". Read as source: vitest has no DOM, and
// the page's behaviour is its lifted suites' (unreadable-answer, archival-gate-sweep, …).

const PAGE = "src/app/certs/[id]/CertDetail.tsx";
const BLOCK = "src/app/certs/[id]/RequirementBlock.tsx";
const src = readFileSync(fileURLToPath(new URL(`../${PAGE}`, import.meta.url)), "utf8");
const block = readFileSync(fileURLToPath(new URL(`../${BLOCK}`, import.meta.url)), "utf8");
const tags = jsxTags(PAGE);
const named = (name: string) => tags.filter((t) => t.name === name);
const squash = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ");

describe("the certification page's shape (PR 5)", () => {
  it("mounts one PageHeader titled Certification #N, Print certificate and the title-row Void", () => {
    expect(named("PageHeader").length).toBe(1);
    expect(squash(named("PageHeader")[0].attr("title"))).toBe("`Certification ${certLabel(cert)}`");
    expect(named("h1").length).toBe(0);
    const subtitle = squash(named("PageHeader")[0].attr("subtitle"));
    expect(subtitle).toContain("cert.customerName");
    expect(subtitle).toContain("CERT_SCOPE_LABELS[cert.scope]");
    expect(subtitle).toContain("Not printed");
    const actions = squash(named("PageHeader")[0].attr("actions"));
    expect(actions).toContain("Print certificate");
    expect(actions).toContain("<DangerButton");
    expect(src).not.toContain('"Print certification"');
    // The print's three refusals stay on the one button (the archival gate is proved per control).
    const print = named("button").find((t) => (t.attr("onClick") ?? "").includes("printCertAction"));
    expect(print?.attr("disabled")).toBe("printGate.disabled || printing || unsavedReadings");
    expect(print?.attr("className")).toBe("BUTTON_PRIMARY");
    const danger = named("DangerButton");
    expect(danger.length).toBe(1);
    expect(danger[0].attr("disabled")).toBe("voidGate.disabled");
    expect(jsxTexts(PAGE, "DangerButton")).toEqual(["Void certification"]);
  });

  it("mounts the three tabs over every section, once each, with the card beside them", () => {
    const tabs = named("RecordTabs");
    expect(tabs.length).toBe(1);
    expect(tabs[0].attr("label")).toBe("CERT_TAB_LABEL");
    expect(tabs[0].attr("tabs")).toBe("certTabs()");
    const panels = tabs[0].attr("panels") ?? "";
    for (const key of certTabs().map((t) => t.key)) expect(panels).toMatch(new RegExp(`(^|[{,\\s])${key}:`));
    for (const component of ["HistoryPanel", "CertDocumentsList", "AtAGlance", "RequirementBlock"]) {
      expect(`${component}: ${named(component).length}`).toBe(`${component}: 1`);
    }
    for (const id of ["results", "notes", "documents", "history"]) {
      expect(tags.some((t) => t.attr("id") === id), id).toBe(true);
    }
    const card = squash(named("AtAGlance")[0].attr("rows"));
    for (const label of ['"Order"', '"Scope"', '"Results"', '"Printed"', '"PO"', '"Material"', '"Received"']) expect(card).toContain(label);
    // The §3.21 explanation stays, on Inspection results.
    expect(src).toContain("never appears on the printed certification");
  });

  it("asks Void through the modal", () => {
    expect(src).not.toMatch(/\bprompt\(/);
    expect(mentions(PAGE, "askReason")).toBe(2); // the import and Void
    expect(mentions(PAGE, "reasonPromptText")).toBe(0);
    expect(src).toContain("A reason is required to void a certification.");
  });

  it("carries the renames and the Documents columns", () => {
    // Each label's text sits in a span before its textarea.
    const spans = jsxTexts(PAGE, "span");
    expect(spans.some((t) => t.startsWith("Certification text"))).toBe(true);
    expect(spans.some((t) => t.startsWith("Internal notes"))).toBe(true);
    expect(src).not.toContain("Freeform");
    expect(src).not.toContain("never printed");
    expect(src).toContain("(never print)");
    const heads = jsxTexts(PAGE, "th");
    expect(heads).toEqual(expect.arrayContaining(["Scope", "Created"]));
    expect(heads).not.toContain("Document");
    expect(heads).not.toContain("Printed");
    expect(jsxTexts(PAGE, "a")).toContain("Open PDF");
    // The link column is named for a screen reader (the PR 4 shape).
    expect(src).toMatch(/<th className="font-medium"><span className="sr-only">Open<\/span><\/th>/);
  });

  it("names the right places and shows no copy the owner did not rule (the review's items 2, 4 and 6)", () => {
    // The blocked-popup sentence points at the tab the list is on, not "below".
    expect(src).toContain("is in Documents & history.");
    expect(src).not.toContain("is in Documents below");
    // No on-screen sentence about the signer: the owner ruled the labels, nothing more.
    expect(src).not.toMatch(/no signer/i);
    // A civil date takes formatDate (CLAUDE.md, format.ts).
    expect(src).toContain("formatDate(cert.receivedDate)");
  });

  it("folds the block's frozen range into one line, names Value by the scale and says Add another reading", () => {
    expect(block).toContain("requiredText(");
    expect(block).toContain("valueHeading(");
    expect(block).not.toContain('label="Scale"');
    expect(block).not.toContain('label="Min"');
    expect(block).not.toContain('label="Max"');
    expect(block).toContain('label="Sample qty"');
    expect(block).toContain('label="Location"');
    expect(jsxTexts(BLOCK, "button")).toContain("Add another reading");
    expect(block).not.toMatch(/>\s*Add reading\s*</);
    // The flows' block locator and the registry label stay.
    expect(block).toContain("border-line p-3");
    expect(block).toContain('"Cert results"');
  });
});
