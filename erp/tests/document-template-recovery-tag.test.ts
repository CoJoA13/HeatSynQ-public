import { describe, expect, it } from "vitest";
import { documentTemplateBaselineFrom, type DocumentTemplateDetail } from "../src/lib/document-template-recovery";
import { defaultConfigFor, type TemplateConfig } from "../src/lib/template-contracts";
import { TEMPLATE_DOC_TYPES, type TemplateDocTypeString } from "../src/lib/template-contracts/types";

// A container tag's config holds the `labelSize` format key, which the editor's recovery must read
// (the editor answered "This editor is unavailable" for every tag template without it).
const detailOf = (config: TemplateConfig, docType: TemplateDocTypeString = "CONTAINER_TAG"): DocumentTemplateDetail => ({
  id: "tag-a", name: "Tag", docType,
  draft: { versionNumber: 2, config, updatedAt: "2026-11-13T00:00:00.000Z", logoMimeType: null },
});

describe("document template recovery, the container tag's label size", () => {
  it("accepts a container tag draft holding the default config, label size kept", () => {
    const config = defaultConfigFor("CONTAINER_TAG");
    expect(config.formats.labelSize).toBe("4x3-landscape");
    const baseline = documentTemplateBaselineFrom(detailOf(config), ["templates.edit"]);
    expect(baseline).not.toBeNull();
    expect(baseline?.config.formats.labelSize).toBe("4x3-landscape");
  });

  it("refuses a label size the contract does not list", () => {
    const config = structuredClone(defaultConfigFor("CONTAINER_TAG"));
    (config.formats as Record<string, unknown>).labelSize = "5x5";
    expect(documentTemplateBaselineFrom(detailOf(config), ["templates.edit"])).toBeNull();
  });
});

// The final review's recommendation: `validConfig` hand-lists the format keys, so a new format knob
// on any type repeats PR 1's defect unless the recovery is held to every type's default config.
describe("document template recovery, every type's default config", () => {
  it("covers the nine types", () => {
    expect(TEMPLATE_DOC_TYPES).toHaveLength(9);
  });
  for (const docType of TEMPLATE_DOC_TYPES) {
    it(`accepts ${docType}'s default draft and keeps its config whole`, () => {
      const config = defaultConfigFor(docType);
      const baseline = documentTemplateBaselineFrom(detailOf(config, docType), ["templates.edit"]);
      expect(baseline, docType).not.toBeNull();
      expect(baseline?.config, docType).toEqual({ ...config, layout: config.layout ?? null });
    });
  }
});
