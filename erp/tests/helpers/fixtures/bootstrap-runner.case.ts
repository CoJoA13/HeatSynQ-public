import { it } from "vitest";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PrismaClient } from "../../../prisma/generated/prisma/client";
import { createBootstrapDatabaseFixture } from "../bootstrap-database";

const record = (event: string) => appendFileSync(join(process.env.BOOTSTRAP_PROBE_DIRECTORY!, "events"), event + "\n");
let phase = "ordinary";
const fixture = createBootstrapDatabaseFixture({
  source: () => "postgresql://localhost/fixture_test",
  admin: async (_source, _name, operation) => {
    if (operation === "drop") { await delay(200); record(`${phase} drop`); }
  },
  client: () => ({ $disconnect: async () => {} }) as PrismaClient,
});

it("ordinary body has a separate cleanup deadline", async ctx => {
  await fixture(ctx, async () => { record("ordinary body"); });
}, 100);

it("timeout belongs to the aborted case", async ctx => {
  phase = "aborted";
  await fixture(ctx, async () => {
    await new Promise<void>(resolve => {
      if (ctx.signal.aborted) resolve();
      else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await delay(30);
    record("aborted body settled");
  });
}, 100);

it("later case only starts after prior work settles", async ctx => {
  phase = "later";
  await fixture(ctx, async () => { record("later body"); });
}, 100);
