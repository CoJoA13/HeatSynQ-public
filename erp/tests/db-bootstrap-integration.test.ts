import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { bootstrapPublicDatabase } from "../scripts/lib/public-bootstrap";
import { assertPublicInstallation } from "../scripts/lib/public-installation";
import { loadPublicMigrations } from "../scripts/lib/public-migrations";
import { withBootstrapDatabase } from "./helpers/bootstrap-database";
import { ALL_PERMISSIONS } from "../src/server/permissions";

describe("public bootstrap and administrator initialization", () => {
  it("starts without business rows, explicitly seeds a usable admin, and keeps initialization stable", async ctx => {
    await withBootstrapDatabase(ctx, async (db, url, exec) => {
      const options = { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, maxBuffer: 1024 * 1024 };
      const deploy = () => exec(process.execPath, [join(process.cwd(), "node_modules/prisma/build/index.js"), "migrate", "deploy"], options).then(() => {});
      await bootstrapPublicDatabase(db, deploy);
      expect(await db.customer.count()).toBe(0);
      expect(await db.order.count()).toBe(0);
      expect(await db.user.count()).toBe(0);
      const templates = await db.documentTemplate.findMany({ include: { versions: true }, orderBy: { id: "asc" } });
      expect(templates).toHaveLength(9);
      expect(templates.flatMap(row => row.versions)).toHaveLength(9);
      expect(await db.updateHold.findMany({ select: { id: true, held: true } })).toEqual([{ id: "singleton", held: false }]);
      const marker = await db.publicInstallation.findMany();
      const history = await db.$queryRaw`SELECT * FROM public._prisma_migrations ORDER BY id`;
      const seed = () => exec(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "prisma/seed.ts"], options);
      await seed();
      await seed();
      const admin = await db.user.findUniqueOrThrow({ where: { username: "admin" }, include: { role: { include: { permissions: true } } } });
      expect(await db.user.count()).toBe(1);
      expect(admin.role?.permissions.map(row => row.permission).sort()).toEqual([...ALL_PERMISSIONS].sort());
      const { verify } = await import("argon2");
      expect(await verify(admin.passwordHash, "admin")).toBe(true);
      expect(admin.role?.permissions.some(row => row.permission.startsWith("ar."))).toBe(false);
      await assertPublicInstallation(db, await loadPublicMigrations());
      await deploy();
      expect(await db.documentTemplate.findMany({ include: { versions: true }, orderBy: { id: "asc" } })).toEqual(templates);
      expect(await db.publicInstallation.findMany()).toEqual(marker);
      expect(await db.$queryRaw`SELECT * FROM public._prisma_migrations ORDER BY id`).toEqual(history);
      await expect(bootstrapPublicDatabase(db, deploy)).rejects.toThrow("completely empty");
    });
  }, 60_000);
});
