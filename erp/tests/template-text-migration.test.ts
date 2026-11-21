import { describe, expect, it } from "vitest";
import { defaultConfigFor, validateConfig } from "@/lib/template-contracts/index";

// Public v1 carries explicit neutral text from the outset. Historical conversion
// preconditions remain tested against the private migration in its own lineage.
const types = [
  { docType: "CERT", key: "cert_statement" },
  { docType: "SHIPPER", key: "shipper_liability_text" },
  { docType: "MOS_SHIPPER", key: "shipper_liability_text" },
] as const;

describe.each(types)("public $docType standing-text contract", ({ docType, key }) => {
  it.each(["", "Shop-approved wording."])("preserves explicitly stored text %j", text => {
    const config = defaultConfigFor(docType);
    config.textBlocks[key] = text;
    expect(validateConfig(docType, config).textBlocks[key]).toBe(text);
  });
  it("fills a missing field with the neutral public default without mutating the input", () => {
    const config = defaultConfigFor(docType);
    delete config.textBlocks[key];
    expect(validateConfig(docType, config).textBlocks[key]).toBe("");
    expect(Object.hasOwn(config.textBlocks, key)).toBe(false);
  });
  it.each([null, 123, {}])("refuses invalid standing text %j without mutating stored content", shape => {
    const config = structuredClone(defaultConfigFor(docType)) as unknown as { textBlocks: Record<string, unknown> };
    config.textBlocks[key] = shape;
    const before = structuredClone(config);
    expect(() => validateConfig(docType, config)).toThrow();
    expect(config).toEqual(before);
  });
});
