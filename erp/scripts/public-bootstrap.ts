import "dotenv/config";
import { execFile } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { bootstrapPublicDatabase, validateBootstrapUrl } from "./lib/public-bootstrap";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const canonicalUrl = validateBootstrapUrl(process.env.DATABASE_URL);
  // Ambient libpq configuration cannot redirect one of the two database clients.
  for (const key of Object.keys(process.env)) if (key.startsWith("PG")) delete process.env[key];
  process.env.DATABASE_URL = canonicalUrl;
  // Provisioning must never import the application client: startup admission correctly
  // refuses the empty database that this command is responsible for initializing.
  const [{ PrismaClient }, { PrismaPg }] = await Promise.all([
    import("../prisma/generated/prisma/client"), import("@prisma/adapter-pg"),
  ]);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: canonicalUrl }) });
  try {
    await bootstrapPublicDatabase(db, () => new Promise<void>((resolve, reject) => {
      execFile(process.execPath, [
        resolvePath(process.cwd(), "node_modules/prisma/build/index.js"), "migrate", "deploy",
      ], { cwd: process.cwd(), env: process.env, maxBuffer: 1024 * 1024 }, error => {
        // Neither child output nor the adapter error is logged: either can include endpoint
        // details or SQL row content. Operators get a bounded failure at this boundary.
        if (error) reject(new Error("Public migrations failed"));
        else resolve();
      });
    }), undefined, resolvePath(process.cwd(), "prisma"));
    console.log("New public database initialized. Certification and shipping text are blank and configurable.");
    console.log("Next: npm run db:seed, then configure your shop's wording in Admin > Templates before use.");
  } finally { await db.$disconnect(); }
}

main().catch(() => {
  console.error("Public bootstrap failed. Keep application services stopped. Inspect the target and migration history; an incomplete installation cannot be resumed automatically.");
  process.exitCode = 1;
});
