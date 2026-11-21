import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { chromium } from "playwright";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { withManualBackupFolder } from "./lib/manual-backup-folder.mjs";

let browser;
let page;
const original = "/home/fictional-user/checkout/erp/backups";
const fixture = `<body style="margin:0"><h1>Backups</h1>
  <div role="alert">No readable backup status file was found</div>
  <span>Backup folder: <code>${original}</code></span>
  <p>Restore with <code>npm run db:restore</code></p></body>`;
const folder = () => page.locator("span").filter({ hasText: /^Backup folder:/ }).locator("code");

before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("http://manual-capture.test/**", route => route.fulfill({
    contentType: "text/html", body: fixture,
  }));
});
after(async () => { await browser?.close(); });
beforeEach(async () => { await page.goto("http://manual-capture.test/admin/backups"); });

test("only the folder is substituted during capture, then restored", async () => {
  const before = await page.locator("body").innerHTML();
  const result = await withManualBackupFolder(page, async () => {
    assert.equal(await folder().textContent(), "[installation-specific folder]");
    assert.equal(await page.locator("p code").textContent(), "npm run db:restore");
    assert.equal(await page.getByRole("alert").textContent(), "No readable backup status file was found");
    assert.ok(await page.getByRole("alert").isVisible());
    return page.screenshot();
  });
  assert.ok(result.length > 0);
  assert.equal(await page.locator("body").innerHTML(), before);
});

test("restores the folder when screenshot capture rejects", async () => {
  const failure = new Error("screenshot failed");
  await assert.rejects(withManualBackupFolder(page, async () => {
    assert.equal(await folder().textContent(), "[installation-specific folder]");
    throw failure;
  }), err => err === failure);
  assert.equal(await folder().textContent(), original);
});

test("different installation paths produce identical screenshot bytes", async () => {
  const shots = [];
  for (const value of ["/srv/backups", "/home/fictional-user/" + "checkout-".repeat(100) + "/backups"]) {
    await folder().evaluate((el, text) => { el.textContent = text; }, value);
    shots.push(await withManualBackupFolder(page, () => page.screenshot({ fullPage: true })));
    assert.equal(await folder().textContent(), value);
  }
  assert.ok(shots[0].equals(shots[1]), "installation paths must produce identical figures");
});

test("other routes retain even an identically labelled folder", async () => {
  await page.goto("http://manual-capture.test/admin/backups/other");
  await withManualBackupFolder(page, async () => {
    assert.equal(await folder().textContent(), original);
  });
});

for (const count of [0, 2]) {
  test(`refuses a backup screenshot with ${count} matching folder elements`, async () => {
    if (count === 0) await folder().evaluate(el => el.remove());
    else await folder().evaluate(el => el.after(el.cloneNode(true)));
    let captured = false;
    await assert.rejects(withManualBackupFolder(page, async () => { captured = true; }),
      { code: "ERR_ASSERTION", message: /exactly one backup folder/ });
    assert.equal(captured, false);
  });
}

// The capture entry point starts a server at module scope. Evaluate its actual shoot function
// in isolation so this regression exercises the screenshot pipeline without starting that server.
for (const route of ["/admin/backups", "/other-screen"]) {
  test(`height read failure still writes a screenshot on ${route}`, async () => {
    await page.goto(`http://manual-capture.test${route}`);
    const source = await readFile(new URL("./manual-capture.mjs", import.meta.url), "utf8");
    const start = source.indexOf("async function shoot(page, name, { tallWindow = false } = {}) {");
    const end = source.indexOf("\n}\n", start) + 2;
    assert.ok(start >= 0 && end > start, "capture harness must contain shoot()");
    const dir = await mkdtemp(path.join(tmpdir(), "manual-capture-height-"));
    try {
      const shoot = vm.runInNewContext(`(${source.slice(start, end)})`, {
        path, stat, IMG_DIR: dir, DEV_CHROME_CSS: "", VIEWPORT: { width: 1440 },
        MAX_SHOT_HEIGHT: 4000, withManualBackupFolder,
      });
      let evaluations = 0;
      // Only the height measurement fails. The real browser still evaluates width, resolves the
      // folder, applies/restores the placeholder, and writes a real PNG through screenshot().
      const failingHeightPage = new Proxy(page, {
        get(target, key) {
          if (key === "evaluate") return async (...args) => {
            evaluations++;
            if (evaluations === 2) throw new Error("simulated transient height read failure");
            return target.evaluate(...args);
          };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const result = await shoot(failingHeightPage, "height-fallback");
      assert.equal(evaluations, 2, "the height failure was injected");
      assert.equal(result.height, 0);
      assert.equal(result.clipped, false);
      assert.equal(result.width, 1440);
      assert.equal(result.overWide, false);
      const png = await readFile(path.join(dir, "height-fallback.png"));
      assert.equal(png.readUInt32BE(0), 0x89504e47);
      assert.equal(result.bytes, png.length);
      assert.equal(await folder().textContent(), original);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
