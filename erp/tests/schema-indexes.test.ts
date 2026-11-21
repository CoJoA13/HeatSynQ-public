import { describe, it, expect } from "vitest";
import { prisma } from "./helpers/db";

/**
 * #718 (review plan P9): the lookup indexes the code's `where` shapes need and the trigram indexes
 * behind global and board search. The indexes are read from `pg_indexes` on the test database (the
 * `tests/process-schema.test.ts` shape), so a dropped or retyped index reds here. The public tree
 * starts from the heatsynq-public-v2 baseline, which already holds them, so the migration's own
 * backfill of a role permission is not tested here: a public install has nothing to backfill.
 */

// [table, index, a fragment its definition must carry]
const INDEXES: [string, string, string][] = [
  ["Shipper", "Shipper_reversesShipperId_idx", 'btree ("reversesShipperId")'],
  ["Session", "Session_userId_idx", 'btree ("userId")'],
  ["InvoiceLine", "InvoiceLine_processStepCodeId_idx", 'btree ("processStepCodeId")'],
  ["InvoiceLine", "InvoiceLine_surchargeId_idx", 'btree ("surchargeId")'],
  ["InvoiceLine", "InvoiceLine_glAccountId_idx", 'btree ("glAccountId")'],
  ["GlPosting", "GlPosting_glAccountId_idx", 'btree ("glAccountId")'],
  ["OrderSerial", "OrderSerial_serial_trgm_idx", "gin (serial gin_trgm_ops)"],
  ["Part", "Part_partNumber_trgm_idx", 'gin ("partNumber" gin_trgm_ops)'],
  ["Part", "Part_name_trgm_idx", "gin (name gin_trgm_ops)"],
];

describe("the search and lookup indexes (#718)", () => {
  it("pg_trgm is installed", async () => {
    const rows = await prisma.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`;
    expect(rows).toHaveLength(1);
  });

  it.each(INDEXES)("%s carries %s", async (table, index, fragment) => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = ${table} AND indexname = ${index}`;
    expect(rows[0]?.indexdef).toContain(fragment);
  });

  // #718 step 1 measured Order.poNumber, Order.vsOrderNumber, Customer.code and Customer.name and
  // the planner used none of them, so none was added; the btree indexes beside them stay.
  it("adds no trigram index the planner did not choose", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexdef LIKE '%gin_trgm_ops%'
      ORDER BY indexname`;
    expect(rows.map((r) => r.indexname)).toEqual(
      ["OrderSerial_serial_trgm_idx", "Part_name_trgm_idx", "Part_partNumber_trgm_idx"]);
  });
});
