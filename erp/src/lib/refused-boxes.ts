// Whole-form Save refusals on New order and New shipment (owner ruling R13, 2026-10-22; G2-5,
// G8-3): the refusals stay in the page-top banner, the cursor jumps to the first refused box, and
// each box a refusal names carries `aria-invalid`. Both pages name a box by an element id; the id
// may sit on the box itself or on a wrapper holding it (a combobox, a row), so both are resolved
// here, once. Import-free and typed structurally so the tests drive it without a DOM.

/** The part of a DOM element these two functions use. */
export type BoxNode = {
  matches(selector: string): boolean;
  querySelector(selector: string): BoxNode | null;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};
export type BoxDocument = { getElementById(id: string): BoxNode | null };

const BOX = "input,select,textarea,button";
/** The boxes the mark is for. A button (Save, Refresh plan) can be jumped to but is not marked. */
const MARKED = "input,select,textarea";

/** The control an id names: the element itself when it is one, else the first control inside it. */
export function refusedBox(doc: BoxDocument, id: string): BoxNode | null {
  const owner = doc.getElementById(id);
  if (!owner) return null;
  return owner.matches(BOX) ? owner : owner.querySelector(BOX);
}

/** Sets `aria-invalid="true"` on every box the ids name and returns the function that takes the
 *  marks off again. A box that already carries the attribute is left alone, and so is its value
 *  after the cleanup: that one is the page's own mark (the load adjustment's), not this one's. */
export function markRefused(doc: BoxDocument, ids: readonly string[]): () => void {
  const marked: BoxNode[] = [];
  for (const id of new Set(ids)) {
    const box = refusedBox(doc, id);
    if (!box || !box.matches(MARKED) || box.hasAttribute("aria-invalid")) continue;
    box.setAttribute("aria-invalid", "true");
    marked.push(box);
  }
  return () => {
    for (const box of marked) box.removeAttribute("aria-invalid");
  };
}
