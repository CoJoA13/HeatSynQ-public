// #693: ticking Certification required on the hub while the scope reads By order is a PATCH whose
// server side mints the order-scope cert in the same transaction (§6.2, Phase 4 ruling 26). The
// hub tells the Certifications section to read its list again, so the cert is listed without a
// reload; the picker's default target is then that same order, and Create is the named collision.
// Keys its own order against the shipping fixture customer with the part that needs no
// certification (the `cert-scope-create` opening), ships nothing and leaves nothing a later flow
// reads.
import assert from "node:assert/strict";
import { createOrderViaUi, openOrderTab } from "../lib/orders.mjs";

const PICKER = "#cert-raise-target";

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;
  const order = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.shipCustomerCode,
    lines: [{ partNumber: fixtures.shipPartANumber, qty: 10 }],
  });
  // The Certifications section sits on the hub's Shipping & certs tab, the scope select and the
  // Certification required box on Overview (PR 2): each is opened before it is read.
  await openOrderTab(page, "Shipping & certs");
  await page.getByText("None — this order does not require a certification.").waitFor({ state: "visible", timeout: 15000 });
  await openOrderTab(page, "Overview");

  const patched = () => page.waitForResponse((res) =>
    new URL(res.url()).pathname === `/api/orders/${order.id}` && res.request().method() === "PATCH" && res.ok());
  // The select sits inside its label with an sr-only caption, so the label's text runs on into
  // the option texts: found by the caption, as the draft-recovery flow finds Terms.
  const scope = page.locator("label").filter({ hasText: "Certification scope" }).locator("select");
  if (await scope.inputValue() !== "ORDER") {
    const scoped = patched();
    await scope.selectOption("ORDER");
    await scoped;
  }
  const required = patched();
  await page.getByLabel("Certification required", { exact: true }).check();
  await required;
  await shot("required-ticked");

  // No reload and no navigation: the section lists the cert the PATCH minted.
  await openOrderTab(page, "Shipping & certs");
  await page.getByRole("link", { name: "By order", exact: true }).waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.getByText("No certifications yet.", { exact: true }).count(), 0,
    "the section must not go on saying there is no certification");
  await shot("cert-listed-without-reload");

  // The picker still offers the order, the server refuses the duplicate, and the screen names it.
  await page.locator(PICKER).selectOption("ORDER");
  const refused = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/certs" && res.request().method() === "POST" && res.status() === 400);
  await page.getByRole("button", { name: "Create certification", exact: true }).click();
  await refused;
  // Non-exact: the sentence shares its element with the "Open it" link (the cert-scope-create match).
  await page.getByText("A live certification already covers this order.").waitFor({ state: "visible", timeout: 10000 });
  await shot("collision-named");
}
