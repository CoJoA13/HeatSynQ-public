import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { removePriceQuestion } from "@/lib/part-tabs";
import { priceBasisAsks, priceBasisQuestion } from "@/lib/price-basis-question";
import { jsxTags, jsxTexts, mentions } from "./helpers/jsx-source";
import { callback } from "./helpers/lift-callback";

// How the Parts & processes screens are shaped since PR 9 of the UX redesign (spec §4.3–§4.5; the
// owner's rulings of 2026-11-01 on #824). Read as source: vitest has no DOM, and each page's
// behaviour is its lifted suites' (part-boxes-screens, pricing-section-wiring, process-steps-section,
// enter-non-guard-commits, unreadable-answer, …).

const read = (page: string) => readFileSync(fileURLToPath(new URL(`../${page}`, import.meta.url)), "utf8");
const named = (page: string, name: string) => jsxTags(page).filter((t) => t.name === name);
const squash = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ");

describe("the parts list's shape (PR 9)", () => {
  const PAGE = "src/app/parts/page.tsx";
  const src = read(PAGE);

  it("mounts one PageHeader titled Parts with Add part, Paste from spreadsheet and the menu, the two views over the box", () => {
    const header = named(PAGE, "PageHeader");
    expect(header.length).toBe(1);
    expect(header[0].attr("title")).toBe("Parts");
    expect(header[0].attr("subtitle")).toBe("Memorized jobs, scoped to each customer.");
    expect(named(PAGE, "h1").length).toBe(0);
    const tabs = named(PAGE, "ListTabs");
    expect(tabs.length).toBe(1);
    expect(tabs[0].attr("label")).toBe("PART_VIEWS_LABEL");
    expect(tabs[0].attr("tabs")).toBe("PART_PRESETS");
    expect(squash(tabs[0].attr("active"))).toBe("presetFor({ showInactive })");
    expect(jsxTags(PAGE).some((t) => t.attr("type") === "checkbox")).toBe(false);
    const menu = named(PAGE, "ActionMenu");
    expect(menu.length).toBe(1);
    expect(squash(menu[0].attr("items"))).toContain('label: "Export to Excel", href: exportHref');
    expect(src).toContain("const exportHref = `/api/parts/export${query ? `?${query}` : \"\"}`;");
    const buttons = jsxTexts(PAGE, "button");
    expect(buttons).toContain("Add part");
    expect(buttons).toContain("Add");
  });

  it("takes the cursor to the inline row's first open box, and sends nothing", () => {
    expect(mentions(PAGE, "focusNewPart")).toBe(2); // the function and the header button's onClick
    expect(src).toContain("ref={customerRef}");
    expect(src).toContain("ref={partNumberRef}");
    // The select is closed without customers.view, and a closed box takes no focus.
    expect(squash(src)).toContain("customerRef.current?.disabled ? partNumberRef.current : customerRef.current");
  });

  it("reads Active as Yes or No, in a flush card", () => {
    expect(mentions(PAGE, "yesNo")).toBe(2); // the import and the cell
    expect(src).toContain("yesNo(p.active)");
    expect(src).not.toContain('"yes"');
    expect(src).toContain("CARD_FLUSH");
  });
});

describe("the part page's shape (PR 9)", () => {
  const PAGE = "src/app/parts/[id]/page.tsx";
  const IDENTITY = "src/app/parts/[id]/IdentitySection.tsx";
  const SECTION = "src/app/parts/[id]/ProcessStepsSection.tsx";
  const FIELDS = "src/app/parts/[id]/CustomFieldsSection.tsx";
  const src = read(PAGE);

  it("mounts one PageHeader with the title and subtitle leaves, Delete part in its title row", () => {
    const header = named(PAGE, "PageHeader");
    expect(header.length).toBe(1);
    expect(header[0].attr("title")).toBe("partTitle(part)");
    expect(header[0].attr("subtitle")).toBe("partSubtitle(part.customerName, recipe)");
    expect(named(PAGE, "h1").length).toBe(0);
    const danger = named(PAGE, "DangerButton");
    expect(danger.length).toBe(1);
    expect(danger[0].attr("disabled")).toBe("canDelete.disabled");
    expect(jsxTexts(PAGE, "DangerButton")).toEqual(["Delete part"]);
  });

  it("keeps the six panels mounted under the leaf's tabs, each section at its id", () => {
    const tabs = named(PAGE, "RecordTabs");
    expect(tabs.length).toBe(1);
    expect(tabs[0].attr("label")).toBe("PART_TAB_LABEL");
    expect(tabs[0].attr("tabs")).toBe("partTabs()");
    const panels = squash(tabs[0].attr("panels"));
    for (const key of ["identity:", "process:", "specs:", "pricing:", "files:", "history:"]) expect(panels).toContain(key);
    for (const id of ["process-steps", "specifications", "inspections", "pricing", "active-quotes", "custom-fields", "attachments", "history"]) {
      expect(panels).toContain(`id="${id}"`);
    }
    const identity = read(IDENTITY);
    expect(identity).toContain('id="part-identity"');
    expect(identity).toContain('id="load-defaults"');
  });

  it("states the card's three rows, the third only with processes.view", () => {
    const card = named(PAGE, "AtAGlance");
    expect(card.length).toBe(1);
    const rows = squash(card[0].attr("rows"));
    expect(rows).toContain('label: "Each weight", value: eachWeightText(part.eachWeight)');
    expect(rows).toContain('label: "Load quantity", value: loadQuantityText(part.loadQty)');
    expect(rows).toContain('processViewGate.allowed ? [{ label: "Recipe revision", value: recipeRevisionText(recipe) }]');
    expect(src).toContain('const processViewGate = gate(perms, "processes.view");');
    // A bare setter, stable across renders: the section's effect depends on it.
    expect(named(PAGE, "ProcessStepsSection")[0].attr("onRecipe")).toBe("setRecipe");
  });

  it("asks for the delete's reason through the modal, with the owner's blank sentence", () => {
    expect(mentions(PAGE, "askReason")).toBe(2); // the import and the call
    expect(src).not.toContain("prompt(");
    expect(src).toContain('blankRefusal: "A reason is required to delete a part."');
  });

  it("splits Identity into the two cards, Active with the identity and Serialization with the defaults", () => {
    expect(jsxTexts(IDENTITY, "h2")).toEqual(["Part identity", "Load and order defaults"]);
    const identity = read(IDENTITY);
    const second = identity.indexOf('id="load-defaults"');
    expect(identity.indexOf("          Active\n")).toBeLessThan(second);
    expect(identity.indexOf("Serialization required")).toBeGreaterThan(second);
    expect(identity.indexOf("Load quantity\n")).toBeGreaterThan(second);
    expect(identity.indexOf("Process name\n")).toBeLessThan(second);
    expect(identity).toContain('aria-label="Load quantity"');
    expect(identity).not.toContain("Load qty\n");
  });

  it("hands up the saved number and the current revision, never the revision selected", () => {
    const section = read(SECTION);
    expect(section).toContain("onRecipe?: (recipe: PartRecipe | null) => void");
    expect(squash(section)).toContain("onRecipe?.(hasBaseline ? { recipeNumber: savedNumber, revision: highest } : null)");
    expect(squash(section)).toContain("[onRecipe, hasBaseline, savedNumber, highest]");
  });

  it("sends a retained draft's link to the tab that holds its notice", () => {
    expect(read(SECTION)).toContain('href: partDraftHref(partId, "process")');
    expect(read(FIELDS)).toContain('href: partDraftHref(partId, "files")');
  });
});

describe("the sections' renames and modals (PR 9)", () => {
  const PRICING = "src/app/parts/[id]/PricingSection.tsx";
  const INSPECTIONS = "src/app/parts/[id]/InspectionsSection.tsx";
  const PROCESS = "src/app/parts/[id]/ProcessStepsSection.tsx";
  const ATTACHMENTS = "src/components/AttachmentsSection.tsx";
  const FLAT = read(PROCESS);

  it("reads the owner's words on each section", () => {
    expect(jsxTexts(PRICING, "h2")).toEqual(["Operation prices"]);
    expect(jsxTexts(INSPECTIONS, "h2")).toEqual(["Inspection requirements"]);
    const pricing = jsxTexts(PRICING, "button");
    expect(pricing).toContain("Remove operation price");
    expect(pricing).toContain("Add price break");
    expect(pricing).not.toContain("Add break");
    expect(squash(read(INSPECTIONS))).toContain('{addingState ? "Adding…" : "Add inspection requirement"}');
    const process = jsxTexts(PROCESS, "button");
    for (const word of ["Discard process changes", "Current revision", "Save recipe"]) expect(process).toContain(word);
    for (const word of ["Discard", "Back to the current revision", "Save recipe number"]) expect(process).not.toContain(word);
    expect(FLAT).not.toContain("HEADER_BUTTON");
  });

  it("leaves no native confirm under the part page or on an attachment", () => {
    for (const file of [PRICING, INSPECTIONS, PROCESS, ATTACHMENTS]) expect(read(file)).not.toMatch(/\bconfirm\(/);
  });

  it("asks an attachment's delete through the modal, in its sentence", () => {
    expect(squash(read(ATTACHMENTS))).toContain('askConfirm({ title: `Delete attachment "${att.filename}"?`, body: "", confirm: "Delete", danger: true })');
  });

  function pricingEnv(answer: boolean) {
    const api = vi.fn(async () => ({}));
    const askConfirm = vi.fn(async () => answer);
    return { api, askConfirm, env: {
      api, askConfirm, removePriceQuestion, priceBasisAsks, priceBasisQuestion, partId: "p1", removingRow: false,
      setRemovingRow: vi.fn(), onError: vi.fn(), invalidateHistory: vi.fn(), load: vi.fn(async () => {}), saveRow: vi.fn(),
    } };
  }
  const row = { id: "r1", stepName: "Harden", pricePer: "EACH", breaks: [{ id: "b1" }] };

  it("sends Remove operation price's DELETE only on a yes, naming the operation", async () => {
    for (const answer of [false, true]) {
      const { api, askConfirm, env } = pricingEnv(answer);
      await callback<(r: typeof row) => Promise<void>>(PRICING.slice("src/".length), "PricingSection", "removeRow", env)(row);
      expect(askConfirm).toHaveBeenCalledWith(removePriceQuestion("Harden"));
      expect(api).toHaveBeenCalledTimes(answer ? 1 : 0);
    }
  });

  it("leaves the basis as stored on a no, and saves once on a yes", async () => {
    for (const answer of [false, true]) {
      const { askConfirm, env } = pricingEnv(answer);
      await callback<(r: typeof row, n: string) => Promise<void>>(PRICING.slice("src/".length), "PricingSection", "changePricePer", env)(row, "LB");
      expect(askConfirm).toHaveBeenCalledWith(priceBasisQuestion("EACH", "LB", 1));
      expect(env.saveRow).toHaveBeenCalledTimes(answer ? 1 : 0);
    }
  });

  it("asks nothing where the basis question does not apply", async () => {
    const { askConfirm, env } = pricingEnv(true);
    await callback<(r: typeof row, n: string) => Promise<void>>(PRICING.slice("src/".length), "PricingSection", "changePricePer", env)(row, "LOT");
    expect(askConfirm).not.toHaveBeenCalled();
    expect(env.saveRow).toHaveBeenCalledWith("r1", { pricePer: "LOT" });
  });
});

describe("the Process step codes page's shape (PR 9)", () => {
  const PAGE = "src/app/admin/step-codes/page.tsx";
  const src = read(PAGE);

  it("mounts one PageHeader with the two Add buttons and the Parts menu", () => {
    const header = named(PAGE, "PageHeader");
    expect(header.length).toBe(1);
    expect(header[0].attr("title")).toBe("Process step codes");
    expect(header[0].attr("subtitle")).toBe("The operation vocabulary used by part recipes.");
    expect(named(PAGE, "h1").length).toBe(0);
    expect(squash(named(PAGE, "ActionMenu")[0].attr("items"))).toContain('label: "Parts", href: "/parts"');
    expect(jsxTexts(PAGE, "button")).toContain("Add step code");
    // The header's and the row's, each reading its own gate.
    expect(jsxTexts(PAGE, "button").filter((t) => t === "Add parameter suggestion").length).toBe(2);
    expect(src).toContain("const suggestionGate = addSuggestionGate(canEdit, current !== null);");
    expect(src).toContain("disabled={suggestionGate.disabled} title={suggestionGate.title}");
  });

  it("keeps the three panels mounted under the leaf's tabs, a page's `open` request choosing one", () => {
    const tabs = named(PAGE, "RecordTabs");
    expect(tabs.length).toBe(1);
    expect(tabs[0].attr("tabs")).toBe("stepCodeTabs()");
    expect(tabs[0].attr("open")).toBe("openTab");
    const panels = squash(tabs[0].attr("panels"));
    for (const key of ["codes:", "selected:", "history:"]) expect(panels).toContain(key);
    for (const id of ["step-codes-list", "new-step-code", "selected-code", "add-suggestion", "step-code-history"]) expect(panels).toContain(`id="${id}"`);
  });

  it("draws the Codes table, its one selector stretched over the row", () => {
    expect(jsxTexts(PAGE, "th").slice(0, 4)).toEqual(["Code", "Name", "GL account", "Active"]);
    const selector = jsxTags(PAGE).filter((t) => t.name === "button" && t.attr("aria-current") !== undefined);
    expect(selector.length).toBe(1);
    expect(selector[0].attr("onClick")).toBe("() => openCode(c.id)");
    expect(selector[0].attr("className")).toContain("after:absolute after:inset-0");
    expect(src).toContain('<tr key={c.id} className={`relative border-t ');
    expect(src).toContain("yesNo(c.active)");
    expect(src).toContain("glAccountText(c.glAccountId, gls)");
    expect(src).toContain(">needs GL</span>");
    expect(src).not.toContain(">inactive</span>");
  });

  it("takes a fresh `open` key per request, so the same row opens Selected code a second time", () => {
    expect(src).toContain("openRequests.current += 1;");
    expect(src).toContain("setOpenTab({ id, key: String(openRequests.current) })");
  });

  it("asks a code's delete through the modal, in its sentence", () => {
    expect(jsxTexts(PAGE, "DangerButton")).toEqual(["Delete step code"]);
    expect(src).not.toMatch(/\bconfirm\(/);
    expect(squash(src)).toContain('askConfirm({ title: `Delete step code "${code.code} — ${code.name}"?`, body: "", confirm: "Delete step code", danger: true })');
  });

  it("focuses through the bounded retry, since the box's panel was hidden when the header was clicked", () => {
    expect(src).toContain("focusWhenShown(() => codeRef.current)");
    expect(src).toContain("focusWhenShown(() => suggestionNameRef.current)");
  });
});
