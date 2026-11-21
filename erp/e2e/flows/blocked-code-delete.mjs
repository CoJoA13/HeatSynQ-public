// Flow 4: attempt to delete E2E-QNCH — the step code the fixture part's process steps still use —
// from the admin Process step codes screen. Spec §3.2/§7: ANY live use blocks the delete, and the
// refusal must name what's blocking it (CLAUDE.md "blocked deletes need discoverable blockers" —
// the Visual Shop dead end this app is escaping), not just say no. Also checks the blocker export
// link actually serves a file.
import assert from "node:assert/strict";
import { answerModal, modalTitle } from "../lib/modal.mjs";

const EM_DASH = "—";

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;
  const { stepCodeA } = fixtures;
  const codeHeading = `${stepCodeA.code} ${EM_DASH} ${stepCodeA.name}`;

  await page.goto(`${ctx.baseURL}/admin/step-codes`);
  // A click on the row's middle, off the Code text: the Code button's target is stretched over it.
  await page.getByRole("row").filter({ hasText: stepCodeA.code }).click();
  await page.getByRole("heading", { name: codeHeading }).waitFor({ state: "visible" });
  await shot("step-code-selected");

  await page.getByRole("button", { name: "Delete step code", exact: true }).click();
  assert.equal(await modalTitle(page), `Delete step code "${codeHeading}"?`);
  await answerModal(page);

  const panel = page.getByText(/Cannot delete process step code/);
  await panel.waitFor({ state: "visible", timeout: 10000 });
  await page.getByText(/1 record\(s\) use it/).waitFor({ state: "visible" });

  // Names what's blocking the delete, and links to each one — the panel is never a dead end.
  const partLink = page.getByRole("link", { name: `${fixtures.customerCode} · ${fixtures.partNumber}` });
  await partLink.waitFor({ state: "visible" });
  assert.equal(await partLink.getAttribute("href"), `/parts/${fixtures.partId}`);

  await shot("blocked-delete-panel");

  const exportHref = await page.getByRole("link", { name: "Export list to Excel" }).getAttribute("href");
  const exportUrl = new URL(exportHref, ctx.baseURL).toString();
  const response = await page.request.get(exportUrl, { maxRetries: 1 });
  assert.equal(response.status(), 200, `blocker export should respond 200, got ${response.status()}`);
  const contentType = response.headers()["content-type"] ?? "";
  assert.ok(contentType.includes("spreadsheetml"), `unexpected export content-type: ${contentType}`);

  await page.getByRole("button", { name: "dismiss" }).click();
  await panel.waitFor({ state: "hidden" });
  await shot("panel-dismissed");
}
