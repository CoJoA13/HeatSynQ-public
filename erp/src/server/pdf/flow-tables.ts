/**
 * Which flow sections the column clamp keeps inside the page (#991, design
 * `docs/superpowers/specs/2026-11-17-991-flow-tables-in-box-design.md` §4.1): every top-level node a flow builder
 * emits for a section its type's canvas profile names as a section-keyed table block (`CanvasProfile.tables`,
 * `keyed: "section"`), the nodes a canvas wraps as blocks. Headers, the ticket's and the certification's party boxes (the invoice's and the quote's
 * `parties` are table sections, and clamped), identity rows, footers, the
 * ticket's liability and tear-off strip and the field-keyed blocks are fields, outside the clamp on both layouts.
 *
 * Each builder's flow branch calls `inBoxFlowSection` at its one `renderSection` call site, after the seed's
 * wrappers, never inside `renderSection` (a canvas reaches the section builders too, and keeps its own scope).
 */
import { contractFor } from "../../lib/template-contracts/index";
import type { TemplateDocTypeString } from "../../lib/template-contracts/types";
import { markFlowTable } from "./canvas-nodes";

const cache = new Map<TemplateDocTypeString, ReadonlySet<string>>();

/** The section keys of `docType`'s flow the clamp keeps inside the page. */
export function flowTableSections(docType: TemplateDocTypeString): ReadonlySet<string> {
  let keys = cache.get(docType);
  if (keys === undefined) {
    keys = new Set((contractFor(docType).canvas?.tables ?? []).filter((t) => t.keyed === "section").map((t) => t.key));
    cache.set(docType, keys);
  }
  return keys;
}

/** Marks each of `nodes` (a section's top-level nodes) when `section` is one of `docType`'s flow table
 *  sections, and hands them back. Out of scope, the nodes unchanged. */
export function inBoxFlowSection<T>(docType: TemplateDocTypeString, section: string, nodes: T[]): T[] {
  if (!flowTableSections(docType).has(section)) return nodes;
  for (const node of nodes) markFlowTable(node, section);
  return nodes;
}
