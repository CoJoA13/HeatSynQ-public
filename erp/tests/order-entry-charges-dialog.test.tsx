// PR 2 (owner ruling 2026-10-31, #817): New order's "Additional charges" collapsible became a
// "Review extra charges" button that opens the charges editor in a page-local <dialog>, opened
// NON-modally so the sticky header (Save & Print, Save only, the refusal banner's Review button)
// stays live while it is open; a refusal naming a charge box opens it before the cursor jumps.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChargesDialog, followOpen } from "../src/app/orders/new/ChargesDialog";

describe("the charges dialog", () => {
  it("draws a labelled dialog holding its children, a title and Done, closed until opened", () => {
    const html = renderToStaticMarkup(<ChargesDialog open={false} onClose={() => {}}><p>Charge rows</p></ChargesDialog>);
    expect(html).toMatch(/<dialog[^>]*aria-label="Extra charges"/);
    expect(html).not.toMatch(/<dialog[^>]*\sopen(=""|\s|>)/);
    expect(html).toContain("<h2");
    expect(html).toContain("Extra charges</h2>");
    expect(html).toContain("Charge rows");
    expect(html).toContain(">Done</button>");
  });

  it("is bound to the viewport and scrolls inside itself (Codex, #833)", () => {
    // Fixed in the viewport, the dialog cannot be scrolled to by the page: with enough charge rows or
    // a short window its last rows, Add charge and Done fell below the screen. A viewport-relative
    // maximum height with its own vertical scroll keeps every control reachable.
    const html = renderToStaticMarkup(<ChargesDialog open={false} onClose={() => {}}><p>Charge rows</p></ChargesDialog>);
    const className = /<dialog[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(className).toMatch(/\bfixed\b/);
    expect(className).toMatch(/\bmax-h-\[calc\(100dvh-[^\]]+\)\]/);
    expect(className).toMatch(/\boverflow-y-auto\b/);
  });

  it("follows `open` with show(), never showModal(), once, and close() once", () => {
    const el = { open: false, show: vi.fn(() => { el.open = true; }), showModal: vi.fn(), close: vi.fn(() => { el.open = false; }) };
    followOpen(true, el); followOpen(true, el);
    expect(el.show).toHaveBeenCalledTimes(1);
    expect(el.showModal).not.toHaveBeenCalled();
    followOpen(false, el); followOpen(false, el);
    expect(el.close).toHaveBeenCalledTimes(1);
  });

  it("page.tsx opens it from Review extra charges and on a refused charge box, with no collapsible left", () => {
    const src = readFileSync(new URL("../src/app/orders/new/page.tsx", import.meta.url), "utf8");
    expect(src).toContain("Review extra charges");
    expect(src).not.toContain('title="Additional charges"');
    const reveal = src.slice(src.indexOf("function reveal("), src.indexOf("function refuse("));
    expect(reveal).toContain('startsWith("entry-charge-")');
    expect(reveal).toContain("setChargesOpen(true)");
    expect(src).toContain("<ChargesDialog open={chargesOpen}");
  });
});
