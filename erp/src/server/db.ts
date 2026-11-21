import { resolve } from "node:path";
import { createPublicClient, publicDatabaseUrl } from "../../scripts/lib/public-client";

const url = publicDatabaseUrl();
const globalForPrisma = globalThis as unknown as {
  publicClient?: ReturnType<typeof createPublicClient>;
  publicDatabaseUrl?: string;
};
if (globalForPrisma.publicClient && globalForPrisma.publicDatabaseUrl !== url) {
  throw new Error("Public database endpoint changed during this process; restart services");
}
// The /*turbopackIgnore: true*/ is load-bearing (#334): without it the tracer copies all of prisma/ (seeds,
// schema, generated client) into the standalone build; next.config.ts's outputFileTracingIncludes names the files read.
const client = globalForPrisma.publicClient ?? createPublicClient(url, resolve(/*turbopackIgnore: true*/ process.cwd(), "prisma"));
export const prisma = client.prisma;
/** Fresh admission for destructive and seed boundaries, independent of lazy runtime caching. */
export const assertPublicDatabase = client.admit;
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.publicClient = client;
  globalForPrisma.publicDatabaseUrl = url;
}
