import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The page-shape components the page PRs adopt (spec 2026-10-30 §4.3, §4.4, §4.5): PageHeader,
 * AtAGlance, ListTabs and RecordTabs, rendered statically. RecordTabs reads the location through
 * next/navigation and the unsaved registry; both are stubbed to one fixed answer here, and the
 * leaf that decides from them is tests/record-tabs.test.ts's.
 */
const nav = vi.hoisted(() => ({ search: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => "/orders/o1",
  useRouter: () => ({ replace: nav.replace }),
}));
vi.mock("@/lib/unsaved-guard", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/unsaved-guard")>();
  return { ...real, unsavedLabels: () => ["Containers"], subscribeUnsaved: () => () => {} };
});

import { PageHeader } from "@/components/PageHeader";
import { AtAGlance } from "@/components/AtAGlance";
import { ListTabs } from "@/components/ListTabs";
import { RecordTabs } from "@/components/RecordTabs";
import { CARD, PILL_ACTIVE, PILL_IDLE, TEXT_MUTED } from "@/lib/ui-classes";

describe("PageHeader", () => {
  it("draws the title, the subtitle under it and the actions at the right", () => {
    const html = renderToStaticMarkup(<PageHeader title="Order #1048" subtitle="Northstar Tool · NS-4821 · Open" actions={<button>Print</button>} />);
    expect(html).toContain('<h1 class="text-[28px] font-semibold leading-[39px] text-ink-800">Order #1048</h1>');
    expect(html).toContain(`<p class="${TEXT_MUTED}">Northstar Tool · NS-4821 · Open</p>`);
    expect(html).toContain('<div class="ml-auto flex min-w-0 flex-wrap justify-end gap-2"><button>Print</button></div>');
  });
});

describe("AtAGlance", () => {
  it("is a labelled aside of label/value rows, sticky beside the panels from 1360px", () => {
    const html = renderToStaticMarkup(<AtAGlance rows={[{ label: "Customer", value: "Northstar Tool" }]}><p>extra</p></AtAGlance>);
    expect(html).toContain(`<aside role="region" aria-label="At a glance" class="${CARD} w-full min-[1360px]:sticky min-[1360px]:top-4 min-[1360px]:w-[292px] min-[1360px]:shrink-0">`);
    expect(html).toContain("Customer");
    expect(html).toContain('<div class="text-[15px] font-medium text-ink-800">Northstar Tool</div>');
    expect(html).toContain("<p>extra</p>");
  });
});

describe("ListTabs", () => {
  it("marks the active preset pressed and draws the pill pair", () => {
    const html = renderToStaticMarkup(<ListTabs label="Order views" active="open"
      tabs={[{ key: "open", label: "Open orders" }, { key: "all", label: "All orders" }]} onSelect={() => {}} />);
    expect(html).toContain('role="group" aria-label="Order views"');
    expect(html).toContain(`aria-pressed="true" class="${PILL_ACTIVE}">Open orders</button>`);
    expect(html).toContain(`aria-pressed="false" class="${PILL_IDLE}">All orders</button>`);
  });
});

describe("RecordTabs", () => {
  const TABS = [
    { key: "overview", label: "Overview", sections: ["Overview"] },
    { key: "parts", label: "Parts & containers", sections: ["Lines", "Containers"] },
  ];
  const html = renderToStaticMarkup(<RecordTabs label="Order sections" tabs={TABS}
    panels={{ overview: <p>overview body</p>, parts: <p>parts body</p> }} />);
  it("renders every panel, only the selected one shown, and a tablist of pills", () => {
    expect(html).toContain('role="tablist" aria-label="Order sections"');
    expect(html).toContain('role="tabpanel" id="panel-overview" aria-labelledby="tab-overview"><p>overview body</p>');
    expect(html).toContain('role="tabpanel" id="panel-parts" aria-labelledby="tab-parts" hidden=""><p>parts body</p>');
    expect(html).toContain(`id="tab-overview" aria-selected="true" aria-controls="panel-overview" tabindex="0" class="${PILL_ACTIVE}"`);
    expect(html).toContain(`id="tab-parts" aria-selected="false" aria-controls="panel-parts" tabindex="-1" class="${PILL_IDLE}"`);
  });
  it("badges the tab whose section holds unsaved work", () => {
    expect(html).toMatch(/Parts &amp; containers<span class="rounded-\[5px\] bg-accent-50[^"]*">Unsaved changes<\/span>/);
    expect(html).not.toMatch(/Overview<span/);
  });
});
