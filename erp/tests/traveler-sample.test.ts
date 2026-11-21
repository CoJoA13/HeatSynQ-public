import { beforeEach, describe, expect, it } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { drawnPages, paintedImageCounts, textRunsWithY } from "./helpers/pdf";
import { buildTravelerDefinitions, travelerSettings, type TravelerSettings } from "@/server/traveler";
import { renderSheetGroups } from "@/server/pdf/render";
import { readSampleTravelerData } from "@/server/traveler-sample";
import { RULE, leftColumn } from "./helpers/traveler-header";

/**
 * Task 5 — the SAMPLE preview's data builder (design spec 2026-09-26 §5). `readSampleTravelerData`
 * has no order to read from; it reads the part's own real details instead, and the traveler
 * builders (`buildTravelerDefinition`/`buildTravelerDefinitions`, traveler.ts) swap the order
 * number, load and barcode slot for the literal "SAMPLE" whenever `TravelerData.sample` is true.
 */

async function fixture() {
  const material = await prisma.material.create({ data: { name: "Sample Material" } });
  const customer = await prisma.customer.create({
    data: { code: "SAMP", name: "Sample Customer", phone: "555-0123" },
  });
  await prisma.customerAddress.create({
    data: {
      customerId: customer.id, kind: "RECEIVED_FROM", street: "100 Sample Street",
      city: "Sampleton", state: "AL", zip: "35000", isDefault: true,
    },
  });
  const part = await prisma.part.create({
    data: {
      customerId: customer.id, partNumber: "SAMPLE-PART-1", name: "Sample Test Part",
      description: "Fixture description text", eachWeight: "12.5000",
      processName: "Sample Process", materialId: material.id,
    },
  });
  const code = await prisma.inspectionCode.create({ data: { name: "HRC" } });
  await prisma.partInspection.create({
    data: {
      partId: part.id, inspectionCodeId: code.id, min: 55, max: 60,
      sampleQty: "100%", location: "Flange OD", sort: 1,
    },
  });
  const settings: TravelerSettings = await travelerSettings(prisma);
  return { customer, part, settings };
}

/** Depth-first search for the pdfmake table whose header row (`body[0]`) carries a cell with this
 *  exact label — the quantities table's own field labels are unique among every table the
 *  traveler builds, unlike its column WIDTHS (the lines table happens to share every individual
 *  width value the quantities table uses, just not all six together). */
function findTableByHeaderLabel(node: unknown, headerText: string): { body: unknown[][] } {
  if (node && typeof node === "object") {
    const table = (node as { table?: { body?: unknown[][] } }).table;
    if (table?.body?.[0]?.some((c) => (c as { text?: unknown } | undefined)?.text === headerText)) {
      return table as { body: unknown[][] };
    }
    for (const value of Object.values(node)) {
      try { return findTableByHeaderLabel(value, headerText); } catch { /* continue */ }
    }
  }
  throw new Error(`No table with a header cell "${headerText}"`);
}

function textValues(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const value of node) textValues(value, out);
  } else if (node && typeof node === "object") {
    if ("text" in node && typeof (node as { text?: unknown }).text === "string") {
      out.push((node as { text: string }).text);
    }
    for (const value of Object.values(node)) textValues(value, out);
  }
  return out;
}

beforeEach(async () => { await truncateAll(); });

describe("readSampleTravelerData (design spec 2026-09-26 §5)", () => {
  it("prints SAMPLE for the order number, the load and the barcode slot, painting no image", async () => {
    const f = await fixture();
    const sample = await readSampleTravelerData(prisma, f.part.id, f.settings, { includeCustomerContact: false });
    const pdf = await renderSheetGroups(buildTravelerDefinitions(sample));
    const runs = textRunsWithY(pdf)[0];
    // Three exact "SAMPLE" runs: the order-number value, the load value, and the barcode
    // placeholder's own text — never the real barcode image (the only images on this page would
    // be a template logo, and the default template carries none).
    expect(runs.filter((r) => r.text === "SAMPLE")).toHaveLength(3);
    expect(paintedImageCounts(pdf)).toEqual([0]);
  });

  it("prints the part's real identity, material, process and inspections", async () => {
    const f = await fixture();
    const sample = await readSampleTravelerData(prisma, f.part.id, f.settings, { includeCustomerContact: false });
    const pdf = await renderSheetGroups(buildTravelerDefinitions(sample));
    const text = drawnPages(pdf)[0];
    for (const expected of [
      "SAMPLE-PART-1", "Sample Test Part", "Fixture description text", "12.5 lb",
      "Sample Material", "Sample Process", "HRC", "100%", "Flange OD",
    ]) {
      expect(text, expected).toContain(expected);
    }
  });

  it("prints the part number in the Process ID slot itself, not only in the lines table", async () => {
    const f = await fixture();
    const sample = await readSampleTravelerData(prisma, f.part.id, f.settings, { includeCustomerContact: false });
    const row = findTableByHeaderLabel(buildTravelerDefinitions(sample)[0].content, "Process ID:").body[0];
    // The part number also prints in the lines table, so only the slot's own cell proves it here.
    expect(row.map((c) => (c as { text?: unknown }).text)).toEqual(
      ["Process:", "Sample Process", "Material:", "Sample Material", "Process ID:", "SAMPLE-PART-1"]);
  });

  it("prints no figure and no lb in the quantities row, and the three bare labels under Order totals", async () => {
    const f = await fixture();
    const sample = await readSampleTravelerData(prisma, f.part.id, f.settings, { includeCustomerContact: false });
    const quantities = findTableByHeaderLabel(buildTravelerDefinitions(sample)[0].content, "Order Quantity");
    // Exactly one data row (no containers). Five blank cells, then the three words with nothing
    // after them: never a "0" from the totals' arithmetic, a figure, or a load weight's "lb".
    expect(quantities.body).toHaveLength(2);
    expect(quantities.body.map((row) => row.map((cell) => textValues(cell)))).toEqual([
      [["Order Quantity"], ["Load Quantity"], ["Container"], ["Containers"], ["Tare"], ["Order totals"]],
      [[""], [""], [""], [""], [""], ["Net", "Tare", "Gross"]],
    ]);
  });

  it("prints the part's each weight with its unit, and a blank net weight with none", async () => {
    const f = await fixture();
    const sample = await readSampleTravelerData(prisma, f.part.id, f.settings, { includeCustomerContact: false });
    const lines = findTableByHeaderLabel(buildTravelerDefinitions(sample)[0].content, "Part Quantity");
    expect(lines.body[1].map((cell) => textValues(cell))).toEqual(
      [[""], ["SAMPLE-PART-1 / Sample Test Part / Fixture description text"], ["12.5 lb"], [""]]);
  });

  it("prints the customer name always, and the received-from address and phone only when included", async () => {
    const f = await fixture();
    const without = await readSampleTravelerData(prisma, f.part.id, f.settings, { includeCustomerContact: false });
    const withContact = await readSampleTravelerData(prisma, f.part.id, f.settings, { includeCustomerContact: true });
    const textWithout = drawnPages(await renderSheetGroups(buildTravelerDefinitions(without)))[0];
    const textWith = drawnPages(await renderSheetGroups(buildTravelerDefinitions(withContact)))[0];

    expect(textWithout).toContain("Sample Customer");
    expect(textWithout).not.toContain("100 Sample Street");
    expect(textWithout).not.toContain("555-0123");

    expect(textWith).toContain("Sample Customer");
    expect(textWith).toContain("100 Sample Street");
    expect(textWith).toContain("555-0123");
  });

  it("carries a blank PO whether or not the customer contact is included: a SAMPLE has no order (#518)", async () => {
    const f = await fixture();
    for (const includeCustomerContact of [false, true]) {
      const sample = await readSampleTravelerData(prisma, f.part.id, f.settings, { includeCustomerContact });
      expect(sample.poNumber, `includeCustomerContact: ${includeCustomerContact}`).toBe("");
    }
  });

  it("prints the PO label and its write-in rule as the left column's last line, with or without the customer contact (#518)", async () => {
    const f = await fixture();
    for (const includeCustomerContact of [false, true]) {
      const sample = await readSampleTravelerData(prisma, f.part.id, f.settings, { includeCustomerContact });
      const pdf = await renderSheetGroups(buildTravelerDefinitions(sample));
      expect(leftColumn(pdf).at(-1), `includeCustomerContact: ${includeCustomerContact}`).toBe(`PO: ${RULE}`);
    }
  });

  it("writes nothing to the database and invents no order number", async () => {
    const f = await fixture();
    // The counter holds a value of its own, so allocating an order number would change it.
    await prisma.setting.create({ data: { key: "order_number_next", value: 5000 } });
    const counts = () => Promise.all([
      prisma.order.count(), prisma.load.count(), prisma.storedDocument.count(), prisma.auditLog.count(),
      prisma.setting.findUniqueOrThrow({ where: { key: "order_number_next" } }).then((s) => s.value),
    ]);
    const before = await counts();
    await readSampleTravelerData(prisma, f.part.id, f.settings, { includeCustomerContact: true });
    expect(await counts()).toEqual(before);
    expect(before[4]).toBe(5000);
  });

  it("404s a part that does not exist or has been deleted", async () => {
    const f = await fixture();
    await expect(readSampleTravelerData(prisma, "missing-part-id", f.settings, { includeCustomerContact: false }))
      .rejects.toMatchObject({ status: 404 });
    await prisma.part.update({ where: { id: f.part.id }, data: { deletedAt: new Date() } });
    await expect(readSampleTravelerData(prisma, f.part.id, f.settings, { includeCustomerContact: false }))
      .rejects.toMatchObject({ status: 404, message: "Part not found" });
  });
});
