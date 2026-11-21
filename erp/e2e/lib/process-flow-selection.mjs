import assert from "node:assert/strict";
const dependencies = {
  "typed-fields": [],
  "revision-cut": ["typed-fields"],
  "permission-gating": ["revision-cut"],
  "draft-recovery": [],
  "session-expiry": [],
  "numbered-recipes": [],
  "process-traveler-editor": ["revision-cut"],
  "order-entry-workspace": [],
  "order-entry-workspace-races": [],
  "order-entry-workspace-recovery": [],
  "order-entry-workspace-print": [],
  "order-entry-server-refusal": [],
  "insecure-origin": [],
  "weights-two-examples": [],
  "money-decimal-entry": [],
  "rates-decimal-entry": [],
  "pick-list-saves": [],
  "parts-certs-decimal-entry": [],
  "enter-saves": [],
  "shipment-ship-to": [],
  "hub-invoice-reread": [],
  "shipment-reverse-reread": [],
  "invoice-shipped-order": [],
  "invoice-step-pick": [],
  "saved-views": [],
  "container-tags": [],
  // PR 2 (the hub's tabs): the three hub flows that read the one order order-entry-full creates.
  "order-entry-full": [],
  "attachment-filenames": ["order-entry-full"],
  "loads-after-print": ["order-entry-full"],
  // PR 3 (the quote page's tabs): reads the harness's own quote fixtures and builds the rest itself.
  "quotes": [],
  // PR 4 (the shipment pages' tabs): creates its own order and shipment from the harness fixtures.
  "shipment-decimal-entry": [],
  "multi-order-shipment": [],
  // PR 5 (the certification page's tabs): its own order, its own cert.
  "cert-results-print": [],
  // PR 7 (the receivables pages' tabs): each builds its own order, batch and payments from the
  // harness fixtures.
  "receivables-apply-age-statement": [],
  "close-month-end": [],
  // PR 8 (the customer page's tabs): reads its own fixture customer and makes its own templates.
  "templates-admin": [],
  // PR 9 (the part page's and step-code page's tabs): each reads the harness's own fixture part.
  "pricing-decimal-entry": [],
  "blocked-code-delete": [],
  "admin-selector-keyboard": [],
  "people-admin": [],
  "setup-checklist": [],
  // PR 10 (the reports' headers): reads the page's own filters and export.
  "reports": [],
  // Release updates (PR 3): its own status file and users; restores both before it ends.
  "release-updates": [],
};
/** A bounded Task 6 subset. Unfiltered runs always retain the complete suite. */
export function selectProcessFlows(flows, selection) {
  if (selection === undefined) return flows;
  const requested = new Set();
  function include(name) {
    assert.ok(Object.hasOwn(dependencies, name), `Unsupported focused process flow: ${name}`);
    assert.ok(flows.some(flow => flow.name === name), `Unregistered process flow: ${name}`);
    if (requested.has(name)) return;
    for (const dependency of dependencies[name]) include(dependency);
    requested.add(name);
  }
  const names = selection.split(",").map(name => name.trim()).filter(Boolean);
  assert.ok(names.length, "At least one registered process flow is required");
  for (const name of names) include(name);
  return flows.filter(flow => requested.has(flow.name));
}
