/**
 * The container tag (#743): the order hub's Print tags, one tag per container row, for telling on the
 * shop floor which container belongs to which work order (owner ruling 1, 2026-10-23). PURE by
 * construction, the Invoice register's contract (`pdf/invoice-register.ts`): `ContainerTagData[]` in,
 * a plain-JSON pdfmake definition out, no I/O and no clock. Every value arrives as the text it
 * prints: turning the order into that text is `src/server/container-tags.ts`'s, and the bytes are
 * `render.ts`'s.
 *
 * Internal paper, a download only (ruling 4, informational): nothing stores it, so it has no template
 * type and its layout is fixed here. The page is a 4 in × 3 in label (ruling 3) and every tag is one
 * page, so a label printer takes the file page by page: each tag after the first starts on a new
 * page, and a tag's height never depends on its text. Every line is `noWrap`, so a long customer
 * name or PO is cut at the label's edge instead of wrapping into the lines below it; a line break
 * saved inside a value prints as one space (`oneLine`, src/lib/line-break.ts; Codex P2 on #744),
 * since `noWrap` stops wrapping by width and nothing else; and the parts
 * are at most `TAG_PARTS_SHOWN` lines, the rest counted in one more (an assumption the issue did not
 * rule on, stated in the pull request). The label is landscape, so nothing here may take the
 * renderer's measurement paths: no `LAYOUT.steps` table, no keep-together or measured-row id, no
 * `unbreakable` block (which, taller than a page, prints on no page at all) and no footer.
 */
import type { Content, ContentText } from "pdfmake/interfaces";
import type { RenderableDefinition } from "./render";
import { oneLine } from "../../lib/line-break";
import {
  CONTAINER_TAG_CONTRACT, DEFAULT_CONFIG as CONTAINER_TAG_DEFAULT_CONFIG, TAG_JOIN,
} from "../../lib/template-contracts/container-tag";
import { TAG_LABEL_SIZES } from "../../lib/template-contracts/canvas";
import { completeSections, type TemplateConfig } from "../../lib/template-contracts/types";
import { buildContainerTagCanvas } from "./container-tag-canvas";

/** One tag's text. A blank PO arrives as the text the mapping chose for none. */
export type ContainerTagData = {
  orderNumber: string;
  customer: string;
  poNumber: string;
  /** Each line of the order as it prints, lead first: `WIDGET-100 × 100`. */
  parts: string[];
  /** The order's container total, every row's count added up (owner confirmation, 2026-10-23). */
  containersTotal: string;
  /** The received date and the order's creation time on the plant's clock: `10/23/2026, 9:02 AM`. */
  received: string;
};

/** 4 in × 3 in, in points. */
export const TAG_PAGE = { width: 288, height: 216 } as const;
/** The parts a tag lists in full; the rest are one counting line. */
export const TAG_PARTS_SHOWN = 6;

/** `and 3 more parts`, `and 1 more part`: the line after the listed parts. */
export const moreParts = (count: number): string => `and ${count} more part${count === 1 ? "" : "s"}`;

const line = (text: string, extra: Partial<ContentText> = {}): ContentText => ({ text: oneLine(text), noWrap: true, ...extra });

type Fields = Map<string, { visible: boolean; label: string }>;

/** The tag section's fields in the config's order, each with its effective label (the typed one, a
 *  blank one included, else the contract's default). Read through the §5.6 belt, so an entry the
 *  config omits still prints at its default. */
function tagFieldsOf(config: TemplateConfig): Fields {
  const defaults = new Map(CONTAINER_TAG_CONTRACT.sections[0].fields.map((f) => [f.key, f.defaultLabel]));
  const section = completeSections(CONTAINER_TAG_CONTRACT, config.sections).find((s) => s.key === "tag");
  return new Map((section?.fields ?? []).map((f) => [f.key, { visible: f.visible, label: f.label ?? defaults.get(f.key) ?? "" }]));
}

function tagStack(tag: ContainerTagData, first: boolean, fields: Fields, config: TemplateConfig): Content {
  const { baseSize, headingSize } = config.fonts;
  const out: ContentText[] = [];
  for (const [key, field] of fields) {
    if (!field.visible) continue;
    switch (key) {
      case "order_number": out.push(line(TAG_JOIN(field.label, tag.orderNumber), { bold: true, fontSize: headingSize })); break;
      case "customer": out.push(line(TAG_JOIN(field.label, tag.customer), { bold: true, fontSize: baseSize + 2, margin: [0, 2, 0, 0] })); break;
      case "po_number": out.push(line(TAG_JOIN(field.label, tag.poNumber), { margin: [0, 4, 0, 0] })); break;
      case "containers_total": out.push(line(TAG_JOIN(field.label, tag.containersTotal))); break;
      case "received": out.push(line(TAG_JOIN(field.label, tag.received))); break;
      case "parts": {
        if (tag.parts.length === 0) break;
        // A typed heading is one of the six lines the field may print, and takes the field's top margin.
        const heading = field.label !== "";
        const shown = tag.parts.slice(0, TAG_PARTS_SHOWN - (heading ? 1 : 0));
        const rest = tag.parts.length - shown.length;
        if (heading) out.push(line(field.label, { margin: [0, 6, 0, 0] }));
        shown.forEach((part, i) => out.push(line(part, i === 0 && !heading ? { margin: [0, 6, 0, 0] } : {})));
        if (rest > 0) out.push(line(moreParts(rest), { italics: true }));
        break;
      }
    }
  }
  return { stack: out, ...(first ? {} : { pageBreak: "before" }) };
}

/** The tags' definition: the canvas's (`buildContainerTagCanvas`, container tag PR 3) when the config
 *  holds a layout, `logoDataUri` printing on a canvas Logo item; else the flow's, unchanged. */
export function buildContainerTags(
  tags: ContainerTagData[], config: TemplateConfig = CONTAINER_TAG_DEFAULT_CONFIG, logoDataUri?: string,
): RenderableDefinition {
  if (config.layout !== null) return buildContainerTagCanvas(tags, config, logoDataUri).def;
  if (tags.length === 0) throw new Error("A container tag file needs at least one tag");
  const fields = tagFieldsOf(config);
  // The page is the label stock's (R3), read from the table the contract's fit rules read.
  const size = TAG_LABEL_SIZES[(config.formats.labelSize ?? "4x3-landscape")];
  return {
    pageSize: { width: size.width, height: size.height },
    pageMargins: size.margin,
    defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
    content: tags.map((tag, i) => tagStack(tag, i === 0, fields, config)),
  };
}
