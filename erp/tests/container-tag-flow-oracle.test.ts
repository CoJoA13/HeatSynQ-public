import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildContainerTags, type ContainerTagData } from "@/server/pdf/container-tags";

/**
 * The container tag's frozen node tree (since container tag PR 1). Written once at the base
 * (`CONTAINER_TAG_ORACLE_WRITE=1`, against the hard-coded `buildContainerTags` before it reads a template
 * config), then every later build is deep-equalled to it: the Standard template prints today's
 * definition exactly.
 *
 * THIS FILE AND ITS FIXTURE ARE NEVER EDITED after the commit that wrote them (the plan's `ORACLE_SHA`
 * check: `git diff --quiet "$ORACLE_SHA" HEAD -- <both>`). The writer stays in the file; that diff, not
 * the writer's absence, is what catches a rewrite. Every case's data is built by hand here, never
 * through `containerTagsData`.
 */

const ORACLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "container-tag-flow-oracle.json");

const tag = (over: Partial<ContainerTagData> = {}): ContainerTagData => ({
  orderNumber: "92036",
  customer: "Acme Heat Treat",
  poNumber: "PO-5531",
  parts: ["WIDGET-100 × 100", "GADGET-200 × 40"],
  containersTotal: "3",
  received: "10/23/2026, 9:02 AM",
  ...over,
});
const parts = (n: number): string[] => Array.from({ length: n }, (_, i) => `PART-${i + 1} × ${(i + 1) * 10}`);

export const ORACLE_CASES: { name: string; tags: ContainerTagData[] }[] = [
  { name: "one-tag", tags: [tag()] },
  { name: "three-tags", tags: [tag(), tag(), tag()] },
  { name: "blank-po", tags: [tag({ poNumber: "—" })] },
  { name: "parts-0", tags: [tag({ parts: [] })] },
  { name: "parts-6", tags: [tag({ parts: parts(6) })] },
  { name: "parts-7", tags: [tag({ parts: parts(7) })] },
  { name: "long-customer", tags: [tag({ customer: "Northern Illinois Precision Gear and Spline Manufacturing Company, Incorporated".padEnd(80, "X").slice(0, 80) })] },
  { name: "long-po", tags: [tag({ poNumber: "PO-".padEnd(60, "9") })] },
  {
    name: "line-breaks",
    tags: [tag({ customer: "Acme\nHeat Treat", poNumber: "PO-5531\r\nREV-B", parts: ["WIDGET 100 × 100"] })],
  },
];

const built = (name: string): unknown => {
  const c = ORACLE_CASES.find((x) => x.name === name);
  if (!c) throw new Error(`No oracle case named ${name}`);
  return JSON.parse(JSON.stringify(buildContainerTags(c.tags)));
};

describe("the container tag's frozen definitions (since container tag PR 1)", () => {
  it.skipIf(process.env.CONTAINER_TAG_ORACLE_WRITE !== "1")("writes the oracle (CONTAINER_TAG_ORACLE_WRITE=1, at the base commit only)", () => {
    const out = Object.fromEntries(ORACLE_CASES.map((c) => [c.name, built(c.name)]));
    writeFileSync(ORACLE, `${JSON.stringify(out, null, 1)}\n`);
  });

  const oracle = (): Record<string, unknown> => JSON.parse(readFileSync(ORACLE, "utf8")) as Record<string, unknown>;

  it("holds exactly the matrix's cases (pin)", () => {
    expect(Object.keys(oracle())).toEqual(ORACLE_CASES.map((c) => c.name));
  });

  it("the matrix's shapes are what its names say (pin)", () => {
    const by = (n: string) => ORACLE_CASES.find((c) => c.name === n)!.tags;
    expect(by("three-tags")).toHaveLength(3);
    expect(by("long-customer")[0].customer).toHaveLength(80);
    expect(by("long-po")[0].poNumber).toHaveLength(60);
    expect(by("parts-0")[0].parts).toHaveLength(0);
    expect(by("parts-6")[0].parts).toHaveLength(6);
    expect(by("parts-7")[0].parts).toHaveLength(7);
  });

  it.each(ORACLE_CASES.map((c) => c.name))("%s builds the definition it built at the base commit", (name) => {
    expect(built(name)).toEqual(oracle()[name]);
  });
});
