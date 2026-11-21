import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SectionsPanel } from "@/app/admin/templates/[id]/edit/panels";
import {
  SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG, TRAVELER_CONTRACT, TRAVELER_DEFAULT_CONFIG,
  normalizeStoredConfig, type TemplateConfig, type TemplateContract,
} from "@/lib/template-contracts";
import { lockIndex } from "@/lib/template-editor";
import { seedLiteral } from "./helpers/stored-configs";

/**
 * #408, §5.16: the template editor's section and field ↑/↓ say why they are disabled. The gates
 * are unit-tested (`tests/template-editor.test.ts`); here the PANEL is rendered, so what is proven
 * is that each button really receives its own section's or field's answer, in its own direction.
 * `SectionsPanel` is props-in, markup-out (the `row-controls` precedent).
 */
type Move = { disabled: boolean; title: string | undefined };

/** Each section's own ↑/↓ and its fields' ↑/↓ pairs, in order, from the rendered panel. */
function rendered(gate: { disabled: boolean; editTitle: string | undefined }) {
  const html = renderToStaticMarkup(
    <SectionsPanel contract={TRAVELER_CONTRACT} config={TRAVELER_DEFAULT_CONFIG} apply={() => {}}
                   disabled={gate.disabled} editTitle={gate.editTitle} locks={lockIndex(TRAVELER_CONTRACT)} />,
  );
  const move = (tag: string): Move => ({ disabled: tag.includes('disabled=""'), title: tag.match(/title="([^"]*)"/)?.[1] });
  // A section's own pair is two items of its Section actions menu (PR 13, #828); a field's stays
  // its row's arrows.
  const own = (chunk: string) => {
    const item = (name: string) => move(chunk.match(new RegExp(`<button\\b[^>]*role="menuitem"[^>]*>Move ${name}<`))![0]);
    return { up: item("up"), down: item("down") };
  };
  const pairs = (chunk: string) => {
    const tags = [...chunk.matchAll(/<button\b[^>]*aria-label="Move (up|down)"[^>]*>/g)];
    expect(tags.length % 2, "an ↑ and a ↓ per row").toBe(0);
    const out: { up: Move; down: Move }[] = [];
    for (let i = 0; i < tags.length; i += 2) {
      expect([tags[i][1], tags[i + 1][1]]).toEqual(["up", "down"]);
      out.push({ up: move(tags[i][0]), down: move(tags[i + 1][0]) });
    }
    return out;
  };
  // One card per section: its header row holds the section's pair, its list the fields' pairs.
  const cards = html.split(/<div role="group"[^>]*class="rounded border border-line">/).slice(1);
  expect(cards).toHaveLength(TRAVELER_DEFAULT_CONFIG.sections.length);
  return TRAVELER_DEFAULT_CONFIG.sections.map((s, i) => {
    const fields = pairs(cards[i]);
    expect(fields, s.key).toHaveLength(s.fields.length);
    return { key: s.key, own: own(cards[i]), fields };
  });
}

const open: Move = { disabled: false, title: undefined };
const STEPS_LOCK = lockIndex(TRAVELER_CONTRACT).get("section:steps")!;
/** The pinned section's pair, as the markup carries the lock's text. */
const LOCKED: Move = { disabled: true, title: STEPS_LOCK.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;") };

describe("the template editor's section and field ↑/↓ say why they are disabled (#408)", () => {
  const sections = rendered({ disabled: false, editTitle: undefined });
  const at = (key: string) => sections.find((s) => s.key === key)!;

  it("the first section's ↑ and the last section's ↓ name the end of the list", () => {
    expect(at("header").own).toEqual({ up: { disabled: true, title: "Already first" }, down: open });
    expect(at("footer").own.down).toEqual({ disabled: true, title: "Already last" });
  });

  it("a section beside the pinned one says that neighbour is pinned, on the side that faces it", () => {
    expect(at("inspections").own).toEqual({ up: open, down: { disabled: true, title: "The next section is pinned in place" } });
    expect(at("footer").own.up).toEqual({ disabled: true, title: "The previous section is pinned in place" });
  });

  it("the pinned section's own pair still shows its lock reason", () => {
    expect(STEPS_LOCK).toMatch(/Step-fields ruling/);
    expect(at("steps").own).toEqual({ up: LOCKED, down: LOCKED });
  });

  it("every other section's ↑/↓ is enabled, with no title", () => {
    for (const key of ["lines", "quantities", "process"]) expect(at(key).own, key).toEqual({ up: open, down: open });
  });

  it("in every section the first field's ↑ and the last field's ↓ name the end, and the rest are enabled", () => {
    let checked = 0;
    for (const s of sections) {
      s.fields.forEach((f, i) => {
        const last = s.fields.length - 1;
        expect(f.up, `${s.key} field ${i} up`).toEqual(i === 0 ? { disabled: true, title: "Already first" } : open);
        expect(f.down, `${s.key} field ${i} down`).toEqual(i === last ? { disabled: true, title: "Already last" } : open);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("with the editor blocked, every pair shows the editor's reason, the pinned section its lock", () => {
    const blocked = rendered({ disabled: true, editTitle: "Requires admin.edit" });
    const reason = { disabled: true, title: "Requires admin.edit" };
    for (const s of blocked) {
      if (s.key === "steps") expect(s.own, "steps").toEqual({ up: LOCKED, down: LOCKED });
      else expect(s.own, s.key).toEqual({ up: reason, down: reason });
      for (const f of s.fields) expect(f, s.key).toEqual({ up: reason, down: reason });
    }
  });

  it("rendered from a reordered config, each card and field gets the config's answer, not the contract's", () => {
    /** Swap two adjacent entries by hand, so the config never depends on the mover. */
    const swap = <T,>(xs: readonly T[], i: number): T[] => [...xs.slice(0, i), xs[i + 1], xs[i], ...xs.slice(i + 2)];
    const base = TRAVELER_DEFAULT_CONFIG;
    const lines = base.sections[1];
    const config = { ...base, sections: [{ ...lines, fields: swap(lines.fields, 0) }, base.sections[0], ...base.sections.slice(2)] };
    expect(config.sections.slice(0, 2).map((s) => s.key)).toEqual(["lines", "header"]);
    expect(config.sections[0].fields.slice(0, 2).map((f) => f.key)).toEqual(["line_part", "line_qty"]);
    const html = renderToStaticMarkup(
      <SectionsPanel contract={TRAVELER_CONTRACT} config={config} apply={() => {}}
                     disabled={false} editTitle={undefined} locks={lockIndex(TRAVELER_CONTRACT)} />,
    );
    const cards = html.split(/<div role="group"[^>]*class="rounded border border-line">/).slice(1);
    const sectionName = (key: string) => TRAVELER_CONTRACT.sections.find((s) => s.key === key)!.name;
    // Each card is the section the config lists there, and the first card's fields are in the config's order.
    expect([...html.matchAll(/<div role="group" aria-label="([^"]*)"/g)].map((m) => m[1])).toEqual(config.sections.map((s) => sectionName(s.key)));
    const fieldName = (key: string) => TRAVELER_CONTRACT.sections.find((s) => s.key === "lines")!.fields.find((f) => f.key === key)!.name;
    expect([...cards[0].matchAll(/aria-label="Show field ([^"]*)"/g)].map((m) => m[1]).slice(0, 2)).toEqual([fieldName("line_part"), fieldName("line_qty")]);
    const move = (tag: string): Move => ({ disabled: tag.includes('disabled=""'), title: tag.match(/title="([^"]*)"/)?.[1] });
    const tags = (chunk: string) => [...chunk.matchAll(/<button\b[^>]*aria-label="Move (up|down)"[^>]*>/g)].map((m) => move(m[0]));
    const items = (chunk: string) => [...chunk.matchAll(/<button\b[^>]*role="menuitem"[^>]*>Move (?:up|down)</g)].map((m) => move(m[0]));
    const [partUp, partDown, qtyUp] = tags(cards[0]);
    expect(items(cards[0])).toEqual([{ disabled: true, title: "Already first" }, open]); // lines, now first
    expect(items(cards[1])).toEqual([open, open]); // header, now second
    expect([partUp, partDown]).toEqual([{ disabled: true, title: "Already first" }, open]); // line_part, now the first field
    expect(qtyUp).toEqual(open); // line_qty, now second
  });
});

/** One field's row of the rendered panel: the name it shows, the spoken names of its controls in
 *  order, and the grey text of its empty label box. */
function fieldRow(contract: TemplateContract, config: TemplateConfig, sectionKey: string, fieldKey: string) {
  const html = renderToStaticMarkup(
    <SectionsPanel contract={contract} config={config} apply={() => {}}
                   disabled={false} editTitle={undefined} locks={lockIndex(contract)} />,
  );
  const at = config.sections.findIndex((s) => s.key === sectionKey);
  const card = html.split(/<div role="group"[^>]*class="rounded border border-line">/).slice(1)[at];
  const row = card.split("<li ").slice(1)[config.sections[at].fields.findIndex((f) => f.key === fieldKey)];
  return {
    name: row.match(/<span\b[^>]*>([^<]*)<\/span>/)?.[1],
    spoken: [...row.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]),
    grey: row.match(/placeholder="([^"]*)"/)?.[1],
  };
}

describe("a renamed field's row in Sections and fields (the weights design §13.3: ED1, ED2, ED8b and ED15)", () => {
  it.each([
    ["TRAVELER", "line_each_weight", TRAVELER_CONTRACT, TRAVELER_DEFAULT_CONFIG, "lines", "Each weight", "Each weight"],
    // The name and the built-in label differ here, by the colon.
    ["SHIPPER", "total_weight", SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG, "totals", "Net weight", "Net weight:"],
  ] as const)("[%s] %s: the row shows the new name, speaks it on the tick box and the label box, and greys the built-in label",
    (_docType, fieldKey, contract, config, sectionKey, name, grey) => {
      expect(fieldRow(contract, config, sectionKey, fieldKey)).toEqual({
        name, spoken: [`Show field ${name}`, `Label for ${name}`, "Move up", "Move down"], grey,
      });
    });
});

describe("a new field's row in Sections and fields (the weights design §13.3: ED1, ED9 and ED15)", () => {
  it.each([
    ["container_tare", "containers", "Tare", "Tare"],
    ["total_tare", "totals", "Tare", "Tare:"],
    ["total_gross", "totals", "Gross weight", "Gross weight:"],
  ] as const)("[SHIPPER] %s: the row shows its name, speaks it on the tick box and the label box, and greys its built-in label",
    (fieldKey, sectionKey, name, grey) => {
      expect(fieldRow(SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG, sectionKey, fieldKey)).toEqual({
        name, spoken: [`Show field ${name}`, `Label for ${name}`, "Move up", "Move down"], grey,
      });
    });
});

describe("the traveler's Purchase order row, on a version stored before po_number existed (#518)", () => {
  // The seed migration's literal as the editor's reads hand it over. Devtest's in-use version
  // stores that literal, as the 2026-10-15 exports showed.
  const stored = seedLiteral("TRAVELER") as { sections: { key: string; fields: { key: string }[] }[] };
  const config = normalizeStoredConfig("TRAVELER", seedLiteral("TRAVELER"));
  const html = renderToStaticMarkup(
    <SectionsPanel contract={TRAVELER_CONTRACT} config={config} apply={() => {}}
                   disabled={false} editTitle={undefined} locks={lockIndex(TRAVELER_CONTRACT)} />,
  );

  it("the stored literal holds no po_number, so the row below is the read's backfill", () => {
    expect(stored.sections.find((s) => s.key === "header")!.fields.map((f) => f.key)).not.toContain("po_number");
  });

  it("the header card lists Purchase order right after Customer phone", () => {
    const at = config.sections.findIndex((s) => s.key === "header");
    const card = html.split(/<div role="group"[^>]*class="rounded border border-line">/).slice(1)[at];
    const names = [...card.matchAll(/<span class="w-40 truncate text-ink-800">([^<]*)<\/span>/g)].map((m) => m[1]);
    const phone = names.indexOf("Customer phone");
    expect(phone).toBeGreaterThanOrEqual(0);
    expect(names.slice(phone, phone + 2)).toEqual(["Customer phone", "Purchase order"]);
  });

  it("the row is shown, speaks its name, and its empty label box greys PO:", () => {
    const tick = html.match(/<input\b[^>]*aria-label="Show field Purchase order"[^>]*>/)?.[0];
    expect(tick, "the Show field Purchase order box").toContain('checked=""');
    const box = html.match(/<input\b[^>]*aria-label="Label for Purchase order"[^>]*>/)?.[0];
    expect(box, "the Label for Purchase order box").toContain('placeholder="PO:"');
    expect(box, "the Label for Purchase order box").toContain('value=""');
    expect(fieldRow(TRAVELER_CONTRACT, config, "header", "po_number")).toEqual({
      name: "Purchase order",
      spoken: ["Show field Purchase order", "Label for Purchase order", "Move up", "Move down"],
      grey: "PO:",
    });
  });
});
