import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  documentSteps, insertProcessStep, moveProcessStep, normalizeUnit, parametersFromSuggestions, parseProcessDocument, sameProcessContent,
  PROVISIONAL_KEY, type ProcessDraftStep, type ProcessEditorCode, type ProcessParameterInput,
} from "@/lib/process-document";

const UUID = "11111111-1111-4111-8111-111111111111";
const param = (key: string, over: Partial<ProcessParameterInput> = {}): ProcessParameterInput =>
  ({ key, label: "Load", type: "TEXT", unit: null, value: "", ...over });
const row = (id: string, parameters: ProcessParameterInput[] = []): ProcessDraftStep =>
  ({ clientId: id, stepId: id, codeId: "code", instruction: id, parameters });
const parse = (steps: unknown[]) => parseProcessDocument({ expectedBaselineToken: "token", steps });

describe("process document contract (pure)", () => {
  it("documentSteps names each added step's code from the catalog it is handed, and nothing else (R11, #659)", () => {
    const codes = [{ id: "code", code: "HT", name: "Heat" }];
    const added = { ...row("x"), clientId: `new:${UUID}`, stepId: null, codeSeen: { code: "OLD", name: "Old" } };
    const unlisted = { ...added, clientId: `new:${UUID.replace("1111-4", "2222-4")}`, codeId: "gone" };
    const existing = { ...row("a"), codeSeen: { code: "HT", name: "Heat" } };
    expect(documentSteps([added, unlisted, existing], codes)).toEqual([
      { ...added, codeSeen: { code: "HT", name: "Heat" } },
      { clientId: unlisted.clientId, stepId: null, codeId: "gone", instruction: "x", parameters: [] },
      row("a"),
    ]);
  });
  it("moves and inserts complete rows without mutating the source", () => {
    const rows = ["a", "b", "c"].map(id => row(id));
    expect(moveProcessStep(rows, 2, 0)).toEqual([rows[2], rows[0], rows[1]]);
    expect(rows.map(s => s.clientId)).toEqual(["a", "b", "c"]);
    expect(moveProcessStep(rows, 0, 0)).toEqual(rows);
    expect(insertProcessStep(rows, 1, row("d"))).toEqual([rows[0], row("d"), rows[1], rows[2]]);
    expect(() => moveProcessStep(rows, -1, 0)).toThrow();
    expect(() => insertProcessStep(rows, 5, row("d"))).toThrow();
  });

  it("accepts a provisional hand-added row, trims labels and units, and turns an empty unit into null", () => {
    const submitted = row("a", [param(`new:${UUID}`, { label: "  Load  ", unit: "  ", value: "" })]);
    const parsed = parse([submitted]).steps[0];
    expect(parsed.parameters).toEqual([{ key: `new:${UUID}`, label: "Load", type: "TEXT", unit: null, value: "" }]);
    expect(PROVISIONAL_KEY.test(`new:${UUID}`)).toBe(true);
    expect(PROVISIONAL_KEY.test("saved-key")).toBe(false);
    const unit = parse([row("a", [param("k", { unit: " °F " })])]).steps[0].parameters[0].unit;
    expect(unit).toBe("°F");
    // Multiline instructions and decimal strings survive parsing verbatim.
    const step = { ...row("b", [param("n", { type: "NUMBER", value: "1.200" })]), instruction: "\n\n" };
    expect(parse([step]).steps[0]).toEqual(step);
  });

  it("refuses a missing or empty key, an empty or long label, a long unit, a long value and duplicate keys", () => {
    const refuses = (steps: unknown[]) => expect(() => parse(steps)).toThrow(ZodError);
    refuses([{ ...row("a"), parameters: [{ label: "Load", type: "TEXT", unit: null, value: "" }] }]);
    refuses([row("a", [param("")])]);
    refuses([row("a", [param("k", { label: "" })])]);
    refuses([row("a", [param("k", { label: "   " })])]);
    refuses([row("a", [param("k", { label: "x".repeat(61) })])]);
    refuses([row("a", [param("k", { unit: "u".repeat(21) })])]);
    refuses([row("a", [param("k", { value: "v".repeat(501) })])]);
    refuses([row("a", [param("k"), param("k", { label: "Other" })])]);
    refuses([{ ...row("a"), parameters: [{ ...param("k"), extra: true }] }]);
    // The limits themselves are accepted.
    expect(() => parse([row("a", [param("k", { label: "x".repeat(60), unit: "u".repeat(20), value: "v".repeat(500) })])])).not.toThrow();
  });

  it("rejects duplicate identities, unknown keys and aggregate UTF-8 excess", () => {
    expect(() => parse([row("a"), row("a")])).toThrow();
    expect(() => parse([{ ...row("a"), extra: true }])).toThrow();
    expect(() => parse([{ ...row("a"), instruction: "x".repeat(4001) }])).toThrow();
    expect(() => parse(Array.from({ length: 100 }, (_, i) => ({ ...row(String(i)), instruction: "界".repeat(4000) })))).toThrow(/1 MiB/);
  });

  it("compares parameters in order, trims values and labels, and compares keys unless told to ignore them", () => {
    const a = row("a", [param("k1", { label: "Temp", value: "1500" }), param("k2", { label: "Soak", value: "30" })]);
    const swapped = { ...a, parameters: [a.parameters[1], a.parameters[0]] };
    expect(sameProcessContent([a], [swapped])).toBe(false);
    const trimmed = { ...a, clientId: "other", stepId: null, parameters: a.parameters.map(p => ({ ...p, label: ` ${p.label} `, value: `${p.value} `, unit: p.unit ?? "  " })) };
    expect(sameProcessContent([a], [trimmed])).toBe(true);
    const rekeyed = { ...a, parameters: a.parameters.map((p, i) => i === 0 ? { ...p, key: "elsewhere" } : p) };
    expect(sameProcessContent([a], [rekeyed])).toBe(false);
    expect(sameProcessContent([a], [rekeyed], { ignoreKeys: true })).toBe(true);
    expect(sameProcessContent([a], [{ ...a, instruction: "" }])).toBe(false);
    expect(sameProcessContent([a], [{ ...a, parameters: a.parameters.map(p => ({ ...p, type: "NUMBER" as const })) }])).toBe(false);
    expect(sameProcessContent([a], [{ ...a, parameters: a.parameters.map(p => ({ ...p, unit: "F" })) }])).toBe(false);
  });

  it("copies a code's suggestions in order as parameters keyed by suggestion ID with empty values", () => {
    const code: ProcessEditorCode = { id: "code", code: "HT", name: "Heat", active: true, defaultInstruction: "",
      fields: [{ id: "s-2", label: "Soak", type: "NUMBER", unit: " min ", sort: 1 }, { id: "s-1", label: "Temp", type: "NUMBER", unit: "°F", sort: 0 }, { id: "s-3", label: "Media", type: "TEXT", unit: "", sort: 2 }] };
    expect(parametersFromSuggestions(code)).toEqual([
      { key: "s-2", label: "Soak", type: "NUMBER", unit: "min", value: "" },
      { key: "s-1", label: "Temp", type: "NUMBER", unit: "°F", value: "" },
      { key: "s-3", label: "Media", type: "TEXT", unit: null, value: "" },
    ]);
  });

  it("normalizes units through one rule: trimmed, and empty means none", () => {
    expect(normalizeUnit(undefined)).toBeNull();
    expect(normalizeUnit(null)).toBeNull();
    expect(normalizeUnit("")).toBeNull();
    expect(normalizeUnit(" \t ")).toBeNull();
    expect(normalizeUnit(" °F ")).toBe("°F");
  });
});
