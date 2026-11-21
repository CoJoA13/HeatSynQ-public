// The Receivables pages' helpers (PR 7 of the UX redesign; src/lib/receivables-presets.ts,
// src/lib/receipt-batch-page.ts, src/lib/close-tabs.ts). The batch list's three views are ListTabs,
// a group named "Batch views" of pressed buttons over the status filter; the batch page's status is
// the At a glance card's Status row (the one node reading exactly "Open" or "Posted"), which a flow
// reads through `batchStatus` where it used to read the heading's chip. Swept suite source: no
// routing, no raw requests, assertions through node:assert.
import assert from "node:assert/strict";
import { glanceValue } from "./invoicing.mjs";

const VIEWS = ["Open", "Posted", "All"];

/** Opens the batch list's view named `label` unless it is already lit, and waits for the table. */
export async function openBatchesView(page, label) {
  assert.ok(VIEWS.includes(label), `no batch view is named ${JSON.stringify(label)}`);
  const pill = page.getByRole("group", { name: "Batch views", exact: true }).getByRole("button", { name: label, exact: true });
  await pill.waitFor({ state: "visible", timeout: 15000 });
  if ((await pill.getAttribute("aria-pressed")) !== "true") await pill.click();
  await page.getByRole("heading", { name: "Batches", exact: true }).waitFor({ state: "visible", timeout: 15000 });
}

/** The batch page's status as the card shows it ("Open", "Posted"). */
export async function batchStatus(page) {
  const value = glanceValue(page, "Status");
  await value.waitFor({ state: "visible", timeout: 15000 });
  return ((await value.textContent()) ?? "").trim();
}
