import { describe, expect, it } from "vitest";
import { customerOptions, glAccountOptions, labelledOptions, partOptions, withBlank } from "@/lib/menu-options";

describe("customerOptions", () => {
  const rows = [
    { id: "z", code: "AAA", name: "Zed Forge", active: true },
    { id: "w10", code: "W10", name: "Works 10", active: false },
    { id: "w9", code: "W9", name: "works 9" },
    { id: "a2", code: "ACME2", name: "Acme Steel" },
    { id: "a1", code: "ACME1", name: "Acme Steel" },
  ];

  it("lists customers by name (#1056 ruling 5), each digit run by value, ignoring case, labelled CODE · Name", () => {
    expect(customerOptions(rows).map((o) => o.value)).toEqual(["a1", "a2", "w9", "w10", "z"]);
    expect(customerOptions(rows)[0]).toEqual({ value: "a1", label: "ACME1 · Acme Steel" });
  });

  it("orders two customers of one name by code", () => {
    expect(customerOptions(rows).slice(0, 2).map((o) => o.label)).toEqual(["ACME1 · Acme Steel", "ACME2 · Acme Steel"]);
  });

  it("puts a blank choice first, takes another separator and marks an inactive customer where asked", () => {
    expect(customerOptions(rows, { blank: "All customers", separator: " — ", markInactive: true }).map((o) => o.label))
      .toEqual(["All customers", "ACME1 — Acme Steel", "ACME2 — Acme Steel", "W9 — works 9", "W10 — Works 10 (inactive)", "AAA — Zed Forge"]);
    expect(customerOptions(rows, { blank: "All customers" })[0]).toEqual({ value: "", label: "All customers" });
  });
});

describe("partOptions", () => {
  it("lists parts by part number by value, then by customer code, across customers", () => {
    const parts = [
      { id: "1", partNumber: "P-10", name: "Ten", customerCode: "ACME" },
      { id: "2", partNumber: "P-9", name: "Nine", customerCode: "ZED" },
      { id: "3", partNumber: "P-9", name: "Nine too", customerCode: "BOLT" },
    ];
    expect(partOptions(parts, { blank: "All parts" }).map((o) => o.label)).toEqual(["All parts", "P-9 · Nine too", "P-9 · Nine", "P-10 · Ten"]);
  });

  it("prints the part number alone for a part with no name", () => {
    expect(partOptions([{ id: "1", partNumber: "X-1", name: "" }])).toEqual([{ value: "1", label: "X-1" }]);
  });

  it("closes a part with its reason, and marks an inactive one where asked", () => {
    const parts = [{ id: "1", partNumber: "A", name: "Alpha", active: false }, { id: "2", partNumber: "B", name: "Beta", active: true }];
    expect(partOptions(parts, { separator: " — ", markInactive: true, disabledReason: (p) => (p.id === "2" ? "No process steps" : undefined) }))
      .toEqual([
        { value: "1", label: "A — Alpha (inactive)" },
        { value: "2", label: "B — Beta", disabled: true, disabledReason: "No process steps" },
      ]);
  });
});

describe("glAccountOptions", () => {
  it("lists accounts by number, segment by segment, with or without their description", () => {
    const rows = [{ id: "b", name: "4000.10", description: "Rework" }, { id: "a", name: "4000.2", description: "Sales" }, { id: "c", name: "1200", description: null }];
    expect(glAccountOptions(rows, { blank: "(none)" }).map((o) => o.label)).toEqual(["(none)", "1200", "4000.2 Sales", "4000.10 Rework"]);
    expect(glAccountOptions(rows, { describe: false }).map((o) => o.label)).toEqual(["1200", "4000.2", "4000.10"]);
  });
});

describe("labelledOptions and withBlank", () => {
  it("sorts by the text shown", () => {
    expect(labelledOptions([{ id: "x", n: "Dock 10" }, { id: "y", n: "Dock 2" }], (r) => r.n, { blank: "— none —" }))
      .toEqual([{ value: "", label: "— none —" }, { value: "y", label: "Dock 2" }, { value: "x", label: "Dock 10" }]);
  });

  it("adds nothing when no blank is named", () => {
    expect(withBlank(undefined, [{ value: "a", label: "A" }])).toEqual([{ value: "a", label: "A" }]);
  });
});
