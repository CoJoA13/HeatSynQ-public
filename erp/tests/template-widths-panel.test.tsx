import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SectionsPanel, WidthsPanel } from "@/app/admin/templates/[id]/edit/panels";
import {
  CERT_CONTRACT, CERT_DEFAULT_CONFIG, INVOICE_CONTRACT, INVOICE_DEFAULT_CONFIG, MOS_SHIPPER_CONTRACT,
  MOS_SHIPPER_DEFAULT_CONFIG, SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG, TEMPLATE_DOC_TYPES, TRAVELER_CONTRACT,
  TRAVELER_DEFAULT_CONFIG, contractFor, defaultConfigFor,
  type TemplateConfig, type TemplateContract,
} from "@/lib/template-contracts";
import { COLUMN_TABLE_LAYOUTS } from "@/lib/printed-width-core";
import {
  lockIndex, printedWidthWarning, setFieldWidth, setFonts, sharedWidthNotice, toggleFieldVisible,
  toggleSectionVisible,
} from "@/lib/template-editor";

/**
 * The Column widths panel's words under each table. The conditions and the text are unit-tested
 * (`tests/template-editor.test.ts`); here the PANEL is rendered, so what is proven is that each
 * reaches the screen under its own table. A table whose columns, padding and rules pass its budget is
 * refused in red as an alert (owner ruling R-B, #991), and one whose headings do not fit is warned in
 * amber as a status (#991), never with an alert (`template-reorder-panel`'s precedent). The share
 * under a ticket's container table is grey text with no role, above the table's list of columns;
 * its 39 pt warning and its "not measured" note are retired (owner ruling R-A, 2026-11-17).
 */
function tables(contract: TemplateContract, config: TemplateConfig) {
  const html = renderToStaticMarkup(
    <WidthsPanel contract={contract} config={config} apply={() => {}} disabled={false}
                 editTitle={undefined} locks={lockIndex(contract)} />,
  );
  // One block per table, opened by its heading.
  const blocks = html.split('<span class="text-xs font-semibold uppercase tracking-wide text-ink-500">').slice(1);
  return blocks.map((block) => ({
    table: block.slice(0, block.indexOf("<")),
    // Every status reads amber: one in any other colour fails here, rather than being left out.
    statuses: [...block.matchAll(/<p\b([^>]*\brole="status"[^>]*)>([^<]*)<\/p>/g)].map((m) => {
      expect(m[1], m[2]).toMatch(/\bbg-accent-50\b/);
      expect(m[1], m[2]).toMatch(/\btext-accent-600\b/);
      return m[2];
    }),
    alerts: [...block.matchAll(/<p\b[^>]*role="alert"[^>]*>/g)].length,
    // Every paragraph with no role above the table's list of columns, and whether it reads grey.
    notes: [...block.slice(0, block.indexOf("<ul")).matchAll(/<p\b([^>]*)>([^<]*)<\/p>/g)]
      .filter((m) => !/\brole=/.test(m[1]))
      .map((m) => ({
        text: m[2].replaceAll("&#x27;", "'"),
        grey: /\btext-ink-500\b/.test(m[1]) && !/accent|red/.test(m[1]),
      })),
  }));
}
const instructionAt = (width: number) =>
  setFieldWidth(structuredClone(TRAVELER_DEFAULT_CONFIG), "steps", "step_instruction", width);

/** The rows of one table under Column widths, as shown: the name, the grey text of the width
 *  box, its spoken name, and the words beside the box. */
function widthRows(contract: TemplateContract, config: TemplateConfig, table: string) {
  const html = renderToStaticMarkup(
    <WidthsPanel contract={contract} config={config} apply={() => {}} disabled={false}
                 editTitle={undefined} locks={lockIndex(contract)} />,
  );
  const block = html.split('<span class="text-xs font-semibold uppercase tracking-wide text-ink-500">').slice(1)
    .find((b) => b.startsWith(`${table}<`))!;
  return [...block.matchAll(/<li\b[^>]*><span\b[^>]*>([^<]*)<\/span><input\b([^>]*)>\s*<span\b[^>]*>([^<]*)<\/span><\/li>/g)]
    .map((m) => ({
      name: m[1],
      grey: /\bplaceholder="([^"]*)"/.exec(m[2])?.[1],
      spoken: /\baria-label="([^"]*)"/.exec(m[2])?.[1],
      beside: m[3],
    }));
}

/** The owner's words of 2026-10-16 under a ticket's container table: S1 at the built-in widths. Its 39 pt warning
 *  (S2, S3) and its "not measured" note are retired (owner ruling R-A, 2026-11-17, #991). */
const SHARE_54 = "Containers and Tare get 54 pt each.";
const TICKETS = [
  ["SHIPPER", SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG],
  ["MOS_SHIPPER", MOS_SHIPPER_CONTRACT, MOS_SHIPPER_DEFAULT_CONFIG],
] as const;

describe("the Column widths panel's printed-width warning (#450, #457)", () => {
  it("shows nothing extra under any table of a built-in config or a traveler that fits, but the ticket's share", () => {
    let count = 0;
    for (const [docType, config] of [
      // The types with a column table (the container tag has none, so its panel draws no table).
      ...TEMPLATE_DOC_TYPES.filter((d) => Object.keys(COLUMN_TABLE_LAYOUTS[d]).length > 0)
        .map((d) => [d, defaultConfigFor(d)] as const),
      ["TRAVELER", instructionAt(350)] as const,
    ]) {
      const rendered = tables(contractFor(docType), config);
      expect(rendered.length, docType).toBeGreaterThan(0);
      for (const t of rendered) {
        const ticketContainers = (docType === "SHIPPER" || docType === "MOS_SHIPPER") && t.table === "containers";
        expect(t, `${docType} ${t.table}`).toEqual({
          table: t.table, statuses: [], alerts: 0, notes: ticketContainers ? [{ text: SHARE_54, grey: true }] : [],
        });
        count++;
      }
    }
    // The fifteen tables of the eight built-in configs, and the traveler's four again.
    expect(count).toBe(19);
  });

  it("shows the printed-width refusal (owner ruling R-B) under the steps table alone, where #450 warned", () => {
    const rendered = tables(TRAVELER_CONTRACT, instructionAt(351));
    expect(rendered.find((t) => t.table === "steps")).toMatchObject({ statuses: [], alerts: 1 });
    for (const t of rendered.filter((t) => t.table !== "steps")) {
      expect(t, t.table).toMatchObject({ statuses: [], alerts: 0 });
    }
  });

  it.each([
    ["the cert's parts", CERT_CONTRACT, setFieldWidth(structuredClone(CERT_DEFAULT_CONFIG), "parts", "part_identity", 404), "parts"],
    ["the invoice's columns", INVOICE_CONTRACT, setFieldWidth(structuredClone(INVOICE_DEFAULT_CONFIG), "column_header", "col_info", 362), "columns"],
  ] as const)("shows the printed-width refusal under %s alone, where #457 warned", (_name, contract, config, table) => {
    expect(printedWidthWarning(contract, config, table)).toBeNull();
    for (const t of tables(contract, config)) {
      expect(t, t.table).toEqual({ table: t.table, statuses: [], alerts: t.table === table ? 1 : 0, notes: [] });
    }
  });

  it("shows the invoice's totals refusal (#991 review F1) under the column headers, whose Amount column the totals read", () => {
    const config = setFieldWidth(structuredClone(INVOICE_DEFAULT_CONFIG), "column_header", "col_amount", 353);
    for (const t of tables(INVOICE_CONTRACT, config)) {
      expect(t, t.table).toMatchObject({ statuses: [], alerts: t.table === "columns" ? 1 : 0 });
    }
    // The alert is the totals' own sentence, under the columns' block.
    const html = renderToStaticMarkup(
      <WidthsPanel contract={INVOICE_CONTRACT} config={config} apply={() => {}} disabled={false}
                   editTitle={undefined} locks={lockIndex(INVOICE_CONTRACT)} />,
    );
    const columns = html.split('<span class="text-xs font-semibold uppercase tracking-wide text-ink-500">').slice(1)
      .find((b) => b.startsWith("columns<"))!;
    expect(columns).toContain('role="alert">The totals lines need 565pt on paper (the 353pt Amount column beside their ' +
      "212pt label and gaps), more than the 564pt content width: they would print past the page. Narrow the Amount column.</p>");
  });

  it("shows the heading warning (#991) in amber under a table whose headings pass the page, with no refusal", () => {
    const config = setFieldWidth(structuredClone(TRAVELER_DEFAULT_CONFIG), "quantities", "order_qty", 150);
    const message = printedWidthWarning(TRAVELER_CONTRACT, config, "quantities")!.message;
    expect(message).toMatch(/^On paper the “quantities” table's flexible column has what its fixed columns leave: /);
    for (const t of tables(TRAVELER_CONTRACT, config)) {
      // The static markup escapes the apostrophe; the page shows it.
      expect(t, t.table).toEqual({
        table: t.table, statuses: t.table === "quantities" ? [message.replaceAll("'", "&#x27;")] : [], alerts: 0, notes: [],
      });
    }
  });

  it("shows the refusal alone once the declared widths are over budget", () => {
    expect(tables(TRAVELER_CONTRACT, instructionAt(377)).find((t) => t.table === "steps"))
      .toMatchObject({ statuses: [], alerts: 1 });
  });
});

describe.each(TICKETS)("the Column widths panel under the %s container table's shared columns (#519)", (_docType, contract, config) => {
  /** Every table's words but the container table's, which are none. */
  const othersSayNothing = (rendered: ReturnType<typeof tables>) => {
    for (const t of rendered.filter((t) => t.table !== "containers")) {
      expect(t, t.table).toEqual({ table: t.table, statuses: [], alerts: 0, notes: [] });
    }
  };
  const typeAt = (width: number) => setFieldWidth(structuredClone(config), "containers", "container_type", width);

  it("states the share in grey above the column list at the built-in widths, with no warning", () => {
    const rendered = tables(contract, config);
    expect(rendered.find((t) => t.table === "containers"))
      .toEqual({ table: "containers", statuses: [], alerts: 0, notes: [{ text: SHARE_54, grey: true }] });
    othersSayNothing(rendered);
  });

  it("states a share under 39 pt in grey and warns of nothing where the headings fit (the 39 pt warning is retired, R-A)", () => {
    // 38.95 pt each: the headings' widest word, "Containers", needs 38.91.
    expect(printedWidthWarning(contract, typeAt(110.1), "containers")).toBeNull();
    const rendered = tables(contract, typeAt(110.1));
    expect(rendered.find((t) => t.table === "containers")).toEqual({
      table: "containers", statuses: [], alerts: 0,
      notes: [{ text: "Containers and Tare get 38.95 pt each.", grey: true }],
    });
    othersSayNothing(rendered);
  });

  it("shows the heading warning (#991) as the one status where the shares are under the headings' widest word", () => {
    // 38.5 pt each, under 38.91.
    const heading = printedWidthWarning(contract, typeAt(111), "containers")!.message;
    expect(heading).toMatch(/^On paper each half of the “containers” table shares what its fixed columns leave: /);
    const rendered = tables(contract, typeAt(111));
    expect(rendered.find((t) => t.table === "containers")).toEqual({
      table: "containers", statuses: [heading], alerts: 0,
      notes: [{ text: "Containers and Tare get 38.5 pt each.", grey: true }],
    });
    othersSayNothing(rendered);
  });

  it("shows the heading warning at another body size, beside the share alone (the not-measured note is retired, R-A)", () => {
    for (const base12 of [setFonts(config, { baseSize: 12 }), setFonts(typeAt(111), { baseSize: 12 })]) {
      const rendered = tables(contract, base12);
      // At 12 pt "Containers" needs more than either share, so the heading warning (#991) is the status.
      const heading = printedWidthWarning(contract, base12, "containers")!.message;
      expect(rendered.find((t) => t.table === "containers")).toEqual({
        table: "containers", statuses: [heading], alerts: 0,
        notes: [{ text: sharedWidthNotice(contract, base12, "containers")!.share, grey: true }],
      });
      othersSayNothing(rendered);
    }
  });

  it("shows the printed-width refusal alone once the columns and padding pass the 282 pt each half has (R-B)", () => {
    // 189 + 62 = 251 declared, and 32 of padding: 283.
    expect(tables(contract, typeAt(189)).find((t) => t.table === "containers"))
      .toEqual({ table: "containers", statuses: [], alerts: 1, notes: [] });
  });

  it("shows the refusal alone once the declared widths are over the 282 pt each half has", () => {
    // 221 + 62 = 283 declared.
    expect(tables(contract, typeAt(221)).find((t) => t.table === "containers"))
      .toEqual({ table: "containers", statuses: [], alerts: 1, notes: [] });
  });
});

describe("a renamed column's row in Column widths (the weights design §13.3, ED15)", () => {
  it("names a renamed column by its new name, on the row and in the spoken name of its width box", () => {
    // The lines table's columns in the built-in order: line_qty, line_part, line_each_weight, line_weight.
    expect(widthRows(TRAVELER_CONTRACT, TRAVELER_DEFAULT_CONFIG, "lines")[2])
      .toEqual({ name: "Each weight", grey: "78", spoken: "Width for Each weight", beside: "pt (default)" });
  });
});

describe("the editor's words for the traveler's Order totals column (weights design §13.3: ED1, ED6, ED15, ED17)", () => {
  it("names the column Order totals under Column widths, shown and hidden", () => {
    const row = { name: "Order totals", grey: "88", spoken: "Width for Order totals", beside: "pt (default)" };
    expect(widthRows(TRAVELER_CONTRACT, TRAVELER_DEFAULT_CONFIG, "quantities").at(-1)).toEqual(row);
    const unticked = toggleFieldVisible(TRAVELER_DEFAULT_CONFIG, "quantities", "gross_weight");
    expect(widthRows(TRAVELER_CONTRACT, unticked, "quantities").at(-1)).toEqual({ ...row, name: "Order totals (hidden)" });
  });

  it("says hidden on the column's row when its section, Quantities and containers, is unticked and the column's own box is not", () => {
    // `toggleSectionVisible` changes the section's tick alone, so the row is hidden by its section.
    const sectionUnticked = toggleSectionVisible(TRAVELER_DEFAULT_CONFIG, "quantities");
    expect(widthRows(TRAVELER_CONTRACT, sectionUnticked, "quantities").at(-1))
      .toEqual({ name: "Order totals (hidden)", grey: "88", spoken: "Width for Order totals", beside: "pt (default)" });
  });

  it("names it Order totals under Sections and fields, with the built-in label as the grey text of its label box", () => {
    const html = renderToStaticMarkup(
      <SectionsPanel contract={TRAVELER_CONTRACT} config={TRAVELER_DEFAULT_CONFIG} apply={() => {}} disabled={false}
                     editTitle={undefined} locks={lockIndex(TRAVELER_CONTRACT)} />,
    );
    // One row of the panel holds the name, and only one.
    const rows = [...html.matchAll(/<li\b[^>]*>(.*?)<\/li>/g)].map((m) => m[1]).filter((row) => row.includes("Order totals"));
    expect(rows).toHaveLength(1);
    expect({
      name: /<span\b[^>]*>([^<]*)<\/span>/.exec(rows[0])?.[1],
      spoken: [...rows[0].matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]),
      grey: /\bplaceholder="([^"]*)"/.exec(rows[0])?.[1],
    }).toEqual({
      name: "Order totals", grey: "Order totals",
      spoken: ["Show field Order totals", "Label for Order totals", "Move up", "Move down"],
    });
  });
});

describe("the Column widths panel: the ticket's Tare column (ED17)", () => {
  it.each([
    ["SHIPPER", SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG],
    ["MOS_SHIPPER", MOS_SHIPPER_CONTRACT, MOS_SHIPPER_DEFAULT_CONFIG],
  ] as const)("lists Tare third, as a column that shares width, and says so when it is unticked (%s)", (_docType, contract, config) => {
    const shown = widthRows(contract, config, "containers");
    expect(shown.map((r) => r.name)).toEqual(["Container type", "Containers", "Tare", "Customer container id"]);
    expect(shown[2]).toEqual({
      name: "Tare", grey: "Flexible", spoken: "Width for Tare", beside: "flex column (fills remaining width)",
    });
    const hidden = widthRows(contract, toggleFieldVisible(config, "containers", "container_tare"), "containers");
    expect(hidden[2]).toEqual({ ...shown[2], name: "Tare (hidden)" });
    // The same words when its section is unticked.
    expect(widthRows(contract, toggleSectionVisible(config, "containers"), "containers")[2].name).toBe("Tare (hidden)");
  });
});

describe("the words beside a typed width on a column that is flex by default (the owner's S8, 2026-10-16)", () => {
  const TYPED_FLEX = "pt (empty the box to make it flex)";

  it.each(TICKETS)("says how to make a typed Tare flex again, and its box's grey text stays flex (%s)", (_docType, contract, config) => {
    const rows = widthRows(contract, setFieldWidth(structuredClone(config), "containers", "container_tare", 50), "containers");
    expect(rows[2]).toEqual({ name: "Tare", grey: "Flexible", spoken: "Width for Tare", beside: TYPED_FLEX });
    // Containers, flex by default too and still empty, fills the remaining width as before.
    expect(rows[1]).toEqual({
      name: "Containers", grey: "Flexible", spoken: "Width for Containers", beside: "flex column (fills remaining width)",
    });
  });

  it("says the same beside the traveler's Step instruction, so the words reach every document's flex columns", () => {
    const instruction = (config: TemplateConfig) =>
      widthRows(TRAVELER_CONTRACT, config, "steps").find((r) => r.spoken === "Width for Step instruction");
    const row = { name: "Step instruction", grey: "Flexible", spoken: "Width for Step instruction" };
    expect(instruction(TRAVELER_DEFAULT_CONFIG)).toEqual({ ...row, beside: "flex column (fills remaining width)" });
    expect(instruction(instructionAt(351))).toEqual({ ...row, beside: TYPED_FLEX });
  });

  it("keeps pt beside a typed width on a column that is not flex by default", () => {
    const typed = setFieldWidth(structuredClone(TRAVELER_DEFAULT_CONFIG), "lines", "line_qty", 78);
    expect(widthRows(TRAVELER_CONTRACT, typed, "lines")[0])
      .toEqual({ name: "Part quantity", grey: "78", spoken: "Width for Part quantity", beside: "pt" });
  });
});
