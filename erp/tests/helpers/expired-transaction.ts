// Prisma's expired-transaction P2028 as the installed runtime raises it, for the suites that hand
// one to a print's catch: shipping-ticket.test.ts and cert-pdf.test.ts (#556). db-errors.test.ts
// keeps its own copy, the pin of the runtime's shape.
//
// Not named `*.test.ts`, so it is type-checked and linted but vitest never runs it as a suite.
import { setTimeout as delay } from "node:timers/promises";
import { prisma } from "./db";

/** The query-phase expiry: a 50 ms timeout passed by a 200 ms delay, then a query on the expired
 *  transaction. Resolves with the error that query threw; the transaction itself writes nothing. */
export const expiredAtQuery = (): Promise<unknown> =>
  prisma.$transaction(async (tx) => {
    await delay(200);
    await tx.role.count();
  }, { timeout: 50 }).catch((e: unknown) => e);
