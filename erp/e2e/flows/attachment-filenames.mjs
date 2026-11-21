// #226: real uploads on both owners must keep the complete filename and controls inside the row.
import { openOrderTab } from "../lib/orders.mjs";
import assert from "node:assert/strict";
import { assertNeverVisible } from "../lib/ui.mjs";
import { answerModal, modalTitle } from "../lib/modal.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";

export async function assertAttachmentFits(link) {
  const layout = await link.evaluate((anchor) => {
    const row = anchor.closest("li");
    const controls = anchor.nextElementSibling;
    const button = controls.querySelector("button");
    const box = (element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const range = document.createRange();
    range.selectNodeContents(anchor);
    return {
      row: box(row), link: box(anchor), controls: box(controls), button: box(button),
      clientWidth: row.clientWidth, scrollWidth: row.scrollWidth, viewport: innerWidth,
      textRects: [...range.getClientRects()].map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })),
    };
  });
  assert.ok(layout.scrollWidth <= layout.clientWidth, "attachment row must not scroll horizontally");
  assert.ok(layout.row.right <= layout.viewport, "attachment row must remain inside the viewport");
  assert.ok(layout.link.right < layout.controls.left, "filename and metadata need a visible gap");
  assert.ok(layout.button.width > 0 && layout.button.right <= layout.row.right, "Delete must remain inside the row");
  assert.ok(new Set(layout.textRects.map((r) => r.top)).size > 1, "the complete long filename must wrap, not truncate");
  for (const rect of layout.textRects) {
    assert.ok(rect.left >= layout.link.left - 1 && rect.right <= layout.link.right + 1 &&
      rect.top >= layout.link.top - 1 && rect.bottom <= layout.link.bottom + 1,
    "every rendered filename line must fit without clipping");
  }
  return layout;
}

export async function run(page, shot, ctx) {
  assert.ok(ctx.created.orderId, "order-entry-full must create the attachment owner first");
  const originalViewport = page.viewportSize();
  for (const [area, id] of [["parts", ctx.fixtures.partId], ["orders", ctx.created.orderId]]) {
    const filename = `E2E_${area}_${"A".repeat(210)}_scan.txt`;
    const bytes = Buffer.from(`Attachment layout fixture for ${area}\n`);
    const basePath = `/api/${area}/${id}/attachments`;
    await page.goto(`${ctx.baseURL}/${area}/${id}`);
    // Attachments sits on the order hub's Files & history tab (PR 2) and the part's Fields & files (PR 9).
    const openAttachments = async () => { await (area === "orders" ? openOrderTab(page, "Files & history") : openRecordTab(page, "Fields & files")); };
    await openAttachments();
    const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Attachments", exact: true }) });
    const upload = page.waitForResponse((res) => new URL(res.url()).pathname === basePath && res.request().method() === "POST");
    await section.locator('input[type="file"]').setInputFiles({ name: filename, mimeType: "text/plain", buffer: bytes });
    const uploaded = await upload;
    assert.ok(uploaded.ok(), `attachment upload failed: ${uploaded.status()}`);
    const attachment = await uploaded.json();
    assert.ok(attachment.id, "upload must identify the created attachment");
    const link = section.getByRole("link", { name: filename, exact: true });
    await link.waitFor({ state: "visible" });
    assert.equal(await link.getAttribute("href"), `${basePath}/${attachment.id}`);
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.textContent(), filename);
    // The display contract is MM/DD/YYYY in the browser's timezone, independent of its locale.
    // Keep this oracle separate from the production formatter so a formatting regression fails.
    const uploadDate = await page.evaluate((createdAt) => new Date(createdAt).toLocaleDateString("en-US", {
      month: "2-digit", day: "2-digit", year: "numeric",
    }), attachment.createdAt);
    const metadata = link.locator("..").getByText(`${bytes.length} B · ${uploadDate}`, { exact: true });
    for (const width of [1280, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await metadata.waitFor({ state: "visible" });
      await assertAttachmentFits(link);
      await shot(`${area}-filename-${width}`);
    }
    // Fetch the actual bytes through the displayed URL and the browser's authenticated context.
    const downloaded = await page.request.get(`${ctx.baseURL}${await link.getAttribute("href")}`, { maxRetries: 1 });
    assert.equal(downloaded.status(), 200);
    assert.deepEqual(await downloaded.body(), bytes);
    assert.ok(downloaded.headers()["content-disposition"].includes(`filename*=UTF-8''${filename}`));
    await page.reload();
    await openAttachments();
    await link.waitFor({ state: "visible" });
    await metadata.waitFor({ state: "visible" });
    await assertAttachmentFits(link);
    const removed = page.waitForResponse((res) => new URL(res.url()).pathname === `${basePath}/${attachment.id}` && res.request().method() === "DELETE");
    await link.locator("..").getByRole("button", { name: "Delete", exact: true }).click();
    assert.equal(await modalTitle(page), `Delete attachment "${filename}"?`);
    await answerModal(page);
    assert.ok((await removed).ok(), "attachment deletion must succeed");
    await link.waitFor({ state: "hidden" });
    await assertNeverVisible(link, "deleted attachment should disappear after list refresh", 500);
  }
  await page.setViewportSize(originalViewport);
}
