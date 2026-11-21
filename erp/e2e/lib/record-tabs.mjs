// A record page's tabs (src/components/RecordTabs.tsx; the UX redesign's ruling 7): every panel
// stays mounted and the inactive ones are hidden, so a box, button or heading on another tab is
// not found by role and cannot be waited on, typed into or clicked until its tab is open. Flows
// open a tab through this helper, by the label the page's own tab leaf gives it
// (src/lib/order-hub-tabs.ts, src/lib/quote-tabs.ts), never by a raw click on a pill. Swept suite
// source: no routing, no raw requests.

/** Opens the tab named `label` unless it is already selected, and waits for its panel. */
export async function openRecordTab(page, label) {
  // A dirty tab's name ends in its Unsaved badge ("Parts & containers Unsaved changes"), so the
  // tab and its panel (named by the tab) are both matched on the label with that suffix allowed.
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(`^${escaped}(\\s*Unsaved changes)?$`);
  const tab = page.getByRole("tab", { name: named });
  await tab.waitFor({ state: "visible", timeout: 15000 });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await page.getByRole("tabpanel", { name: named }).waitFor({ state: "visible", timeout: 15000 });
}
