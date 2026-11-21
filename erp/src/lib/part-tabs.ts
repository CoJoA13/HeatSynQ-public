// The part page's tabs, title, subtitle and card words (spec 2026-10-30-ux-redesign-design.md
// §4.3–§4.4; the UX redesign PR 9, owner 2026-11-01 on #824): the file's six tabs over the page's
// mounted sections. Two sections register unsaved work, and their labels are those tabs' `sections`,
// so a retained draft on a tab that is not open still badges it; the ids are the sections a hash
// may target. A retained draft's Return to editor link rides the tab in the query (`partDraftHref`),
// never a hash, which a soft navigation's effects can read before the address bar holds it.
// Client-safe; the E2E helpers read the tabs under plain node.
import type { RecordTab } from "./record-tabs";

export const PART_TAB_LABEL = "Part sections";

export function partTabs(): RecordTab[] {
  return [
    { key: "identity", label: "Identity & defaults", sections: [], ids: ["part-identity", "load-defaults"] },
    { key: "process", label: "Process recipe", sections: ["Process steps"], ids: ["process-steps"] },
    { key: "specs", label: "Specifications & inspections", sections: [], ids: ["specifications", "inspections"] },
    { key: "pricing", label: "Pricing & quotes", sections: [], ids: ["pricing", "active-quotes"] },
    { key: "files", label: "Fields & files", sections: ["Custom fields"], ids: ["custom-fields", "attachments"] },
    { key: "history", label: "History", sections: [], ids: ["history"] },
  ];
}

/** Where a retained draft's Return to editor link goes: the tab that holds its notice. */
export function partDraftHref(partId: string, tab: "process" | "files"): string {
  return `/parts/${partId}?tab=${tab}`;
}

/** What the Process section hands up: the saved recipe number and the current revision, whatever
 *  revision is selected; a new part has neither. */
export type PartRecipe = { recipeNumber: string | null; revision: number | null };

/** The page's title: the number and the name, the number alone while the name is blank. */
export function partTitle(part: { partNumber: string; name: string }): string {
  return part.name.trim() === "" ? part.partNumber : `${part.partNumber} · ${part.name}`;
}

/** The page's subtitle: the customer, then the recipe and revision once the section has read them
 *  (never, without processes.view). A part with no revision yet says nothing of one. */
export function partSubtitle(customerName: string, recipe: PartRecipe | null): string {
  if (recipe === null) return customerName;
  return [
    customerName,
    `Recipe ${recipe.recipeNumber ?? "unassigned"}`,
    ...(recipe.revision === null ? [] : [`Revision ${recipe.revision}`]),
  ].join(" · ");
}

const DASH = "—";
const blank = (value: number | string | null): boolean => value === null || String(value).trim() === "";

/** The card's Recipe revision: the current revision's number, a dash until read or with none. */
export function recipeRevisionText(recipe: PartRecipe | null): string {
  return recipe?.revision == null ? DASH : String(recipe.revision);
}

/** The card's Each weight: its label carries no unit, so the figure keeps "lb" (CLAUDE.md,
 *  Container rows and weights). The box's own text, so the card follows it as typed. */
export function eachWeightText(value: number | string): string {
  return blank(value) ? DASH : `${value} lb`;
}

/** The card's Load quantity, the box's own text; a blank is no cap. */
export function loadQuantityText(value: number | string | null): string {
  return blank(value) ? DASH : String(value);
}

/** Remove operation price's question (owner, 2026-11-01): the row and its breaks go at once. */
export function removePriceQuestion(stepName: string): { title: string; body: string; confirm: string; danger: true } {
  return {
    title: `Remove ${stepName} pricing?`,
    body: "This removes the part's operation price and its price breaks. The process step stays.",
    confirm: "Remove operation price",
    danger: true,
  };
}
