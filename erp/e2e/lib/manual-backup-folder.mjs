import assert from "node:assert/strict";

// Capture-only normalization (#317). Keep live folder rendering and API responses untouched.
// Refuse an unexpected Backups DOM rather than writing a figure with the original host path.
export async function withManualBackupFolder(page, capture) {
  if (new URL(page.url()).pathname !== "/admin/backups") return capture();
  const folder = page.locator("span").filter({ hasText: /^Backup folder:/ }).locator("code");
  assert.equal(await folder.count(), 1, "manual capture requires exactly one backup folder");
  const element = await folder.elementHandle();
  assert.ok(element, "manual capture backup folder disappeared");
  const original = await element.textContent();
  try {
    await element.evaluate(el => { el.textContent = "[installation-specific folder]"; });
    return await capture();
  } finally {
    // Restore the same element even on screenshot failure; never target a newly rendered node.
    await element.evaluate((el, text) => { el.textContent = text; }, original);
    await element.dispose();
  }
}
