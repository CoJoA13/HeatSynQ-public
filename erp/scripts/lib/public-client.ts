import { resolve } from "node:path";
import { PrismaClient } from "../../prisma/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { validateBootstrapUrl } from "./public-bootstrap";
import { assertPublicInstallation } from "./public-installation";
import { loadPublicMigrations } from "./public-migrations";

/** Apply before constructing any adapter or spawning any command. Never log the URL. */
export function publicDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const url = validateBootstrapUrl(process.env.DATABASE_URL);
  for (const key of Object.keys(process.env)) if (key.startsWith("PG")) delete process.env[key];
  process.env.DATABASE_URL = url;
  return url;
}

/**
 * Runtime callers pass an app-root artifact directory: bundled import.meta.url is not the
 * source module's scripts/lib directory. Construction is offline; the first operation admits.
 * Successful admission lasts for this client's lifetime. Bootstrap, deploy and restore require
 * stopped services; replacing database/history behind a running process is unsupported.
 */
export function createPublicClient(url: string, prismaDirectory = resolve(/*turbopackIgnore: true*/ process.cwd(), "prisma")) {
  // The /*turbopackIgnore: true*/ is load-bearing (#334): without it the tracer copies all of prisma/ (seeds,
  // schema, generated client) into the standalone build; next.config.ts's outputFileTracingIncludes names the files read.
  const raw = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const admit = async () => assertPublicInstallation(raw, await loadPublicMigrations(prismaDirectory));
  let admission: Promise<void> | undefined;
  function ready(): Promise<void> {
    admission ??= admit().catch(error => { admission = undefined; throw error; });
    return admission;
  }
  const extended = raw.$extends({ query: { $allOperations: async ({ args, query }) => {
    await ready();
    return query(args);
  } } });
  // Prisma acquires an interactive transaction's connection before running its queries. Admit
  // before $transaction itself, so concurrent transactions cannot fill the pool while their
  // first query waits for an admission query that needs another connection.
  type TransactionMethod = (...args: unknown[]) => unknown;
  const transactionWrappers = new WeakMap<TransactionMethod, TransactionMethod>();
  const prisma = new Proxy(extended, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        const transaction = Reflect.get(target, property, receiver) as TransactionMethod;
        let wrapped = transactionWrappers.get(transaction);
        if (!wrapped) {
          // Capture this method now. Looking it up again when called would follow a
          // later interceptor back into itself when it calls its saved original.
          wrapped = async (...args: unknown[]) => {
            await ready();
            return Reflect.apply(transaction, target, args);
          };
          transactionWrappers.set(transaction, wrapped);
          // Restoring a saved wrapper restores that exact method, without another layer.
          transactionWrappers.set(wrapped, wrapped);
        }
        return wrapped;
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as PrismaClient;
  return { prisma, admit };
}
