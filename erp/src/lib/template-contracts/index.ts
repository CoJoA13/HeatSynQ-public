/**
 * The template-contract registry (spec §5.3) — one contract per docType, keyed by the string
 * union, which tests/template-doc-type-enum.test.ts holds to the Prisma `TemplateDocType` enum as a
 * set. All nine types are registered (§8's eight, and the container tag of the design of
 * 2026-11-13); the record stays Partial only because the tests register a stubbed docType on it
 * (tests/helpers/test-contract.ts), and `contractFor` remains the only sanctioned lookup —
 * it throws on an unregistered type, so no caller can validate against `undefined`.
 *
 * `validateConfig(docType, json)` lives HERE, not in ./types.ts, because the registry imports
 * the contract modules, which import ./types — the docType-keyed entry point cannot sit below
 * them without a cycle (the invoice-guards leaf lesson, applied preemptively). The
 * contract-shaped machinery (`validateContractConfig`, `configSchema`, `defaultConfig`) stays in
 * ./types.ts for callers that hold a contract directly.
 */
import {
  TemplateConfigError,
  assertWithheld,
  defaultConfig,
  validateContractConfig,
  type CanvasProfile,
  type TemplateConfig,
  type TemplateContract,
  type TemplateDocTypeString,
} from "./types";
import {
  TRAVELER_CONTRACT, DEFAULT_CONFIG as TRAVELER_DEFAULT_CONFIG,
  normalizeTravelerHandwritingFields, travelerStepsPrintedWidth,
} from "./traveler";
import { canvasPageFor } from "./canvas";
import { printedBudgetProblems } from "./printed-budget";
import { canvasProfile, validateCanvasLayout } from "../template-canvas";
import { SHIPPER_CONTRACT, DEFAULT_CONFIG as SHIPPER_DEFAULT_CONFIG } from "./shipper";
import { MOS_SHIPPER_CONTRACT, DEFAULT_CONFIG as MOS_SHIPPER_DEFAULT_CONFIG } from "./mos-shipper";
import { BOL_CONTRACT, DEFAULT_CONFIG as BOL_DEFAULT_CONFIG } from "./bol";
import { CERT_CONTRACT, DEFAULT_CONFIG as CERT_DEFAULT_CONFIG } from "./cert";
import { INVOICE_CONTRACT, DEFAULT_CONFIG as INVOICE_DEFAULT_CONFIG } from "./invoice";
import { STATEMENT_CONTRACT, DEFAULT_CONFIG as STATEMENT_DEFAULT_CONFIG } from "./statement";
import { QUOTE_CONTRACT, DEFAULT_CONFIG as QUOTE_DEFAULT_CONFIG } from "./quote";
import {
  CONTAINER_TAG_CONTRACT, DEFAULT_CONFIG as CONTAINER_TAG_DEFAULT_CONFIG, assertTagFits,
} from "./container-tag";

export * from "./types";
export { travelerStepsPrintedWidth };
export type { TravelerStepsPrintedWidth } from "./traveler";
export {
  TRAVELER_CONTRACT, TRAVELER_DEFAULT_CONFIG,
  SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG,
  MOS_SHIPPER_CONTRACT, MOS_SHIPPER_DEFAULT_CONFIG,
  BOL_CONTRACT, BOL_DEFAULT_CONFIG,
  CERT_CONTRACT, CERT_DEFAULT_CONFIG,
  INVOICE_CONTRACT, INVOICE_DEFAULT_CONFIG,
  STATEMENT_CONTRACT, STATEMENT_DEFAULT_CONFIG,
  QUOTE_CONTRACT, QUOTE_DEFAULT_CONFIG,
  CONTAINER_TAG_CONTRACT, CONTAINER_TAG_DEFAULT_CONFIG,
};

export const CONTRACTS: Partial<Record<TemplateDocTypeString, TemplateContract>> = {
  TRAVELER: TRAVELER_CONTRACT,
  SHIPPER: SHIPPER_CONTRACT,
  MOS_SHIPPER: MOS_SHIPPER_CONTRACT,
  BOL: BOL_CONTRACT,
  CERT: CERT_CONTRACT,
  INVOICE: INVOICE_CONTRACT,
  STATEMENT: STATEMENT_CONTRACT,
  QUOTE: QUOTE_CONTRACT,
  CONTAINER_TAG: CONTAINER_TAG_CONTRACT,
};

export function contractFor(docType: TemplateDocTypeString): TemplateContract {
  const contract = CONTRACTS[docType];
  if (contract === undefined) {
    throw new TemplateConfigError(`No template contract is registered for docType "${docType}"`);
  }
  return contract;
}

/** Parses a stored config for one docType, applying the §5.3 backfill — see
 *  `validateContractConfig` for the full contract. Throws on an unregistered docType. */
export function validateConfig(docType: TemplateDocTypeString, json: unknown): TemplateConfig {
  return withCanvasRules(docType, withPrintedBudgets(docType, withTagRules(docType, validateContractConfig(contractFor(docType), json))));
}

/** The flow's printed-width budget (#991, owner ruling R-B): a flow config whose table's fixed columns, padding and
 *  rules, and one grid step where a "*" column is shown, pass its budget is refused in the first such table's sentence
 *  (`printedBudgetProblems`, ./printed-budget.ts). A canvas config passes through: rule 9 judges its tables. */
function withPrintedBudgets(docType: TemplateDocTypeString, config: TemplateConfig): TemplateConfig {
  if (config.layout !== null) return config;
  const [problem] = printedBudgetProblems(contractFor(docType), config.sections, config.fonts.baseSize);
  if (problem !== undefined) throw new TemplateConfigError(problem.sentence);
  return config;
}

/** The container tag's rules, run on a parsed config before the canvas rules (the container tag
 *  design of 2026-11-13 §5): the controls its contract withholds (`assertWithheld`), and, on a flow
 *  config alone (call 17), the two fit rules (`assertTagFits`: R10's flow half, then R11). Every
 *  other docType passes through. */
function withTagRules(docType: TemplateDocTypeString, config: TemplateConfig): TemplateConfig {
  if (docType !== "CONTAINER_TAG") return config;
  assertWithheld(contractFor(docType), config);
  if (config.layout === null) assertTagFits(config);
  return config;
}

/** The documents whose canvas PRINTS: a layout on a contract with a profile outside this set is refused
 *  until its paper lands (the shipping ticket's landed in PR 2a of its lane, the bill of lading's in PR 2
 *  of its own, the certification's in PR 2 of its own, the invoice's in PR 3 of its own, design
 *  2026-11-10 §7, the statement's in PR 2 of its own, design 2026-11-11 §7, the quotation's in PR 2 of
 *  its own, design 2026-11-12 §7, and the container tag's in PR 3 of its own, design 2026-11-13 §7.4,
 *  whose profile landed a task before its paper). Every docType is in the set, and every docType has a
 *  profile, so no real docType reaches either refusal: the later-release one is pinned on the tests'
 *  stubbed docType given a profile (tests/helpers/test-contract.ts), in tests/template-canvas.test.ts
 *  (through `assertCanvasPrints`, `validateConfig` and `canvasPrints`) and
 *  tests/template-canvas-seed.test.ts (through the seed), and the no-profile one on the stub given
 *  none. */
const CANVAS_PRINTS: ReadonlySet<TemplateDocTypeString> = new Set(["TRAVELER", "SHIPPER", "MOS_SHIPPER", "BOL", "CERT", "INVOICE", "STATEMENT", "QUOTE", "CONTAINER_TAG"]);

/** Whether the document's canvas PRINTS: a profile, and a docType in CANVAS_PRINTS. The editor's offer
 *  (panels.tsx, TemplateEditor.tsx) reads it, so no draft shows Design on a canvas before its paper. */
export function canvasPrints(docType: TemplateDocTypeString): boolean {
  return contractFor(docType).canvas !== undefined && CANVAS_PRINTS.has(docType);
}

/** Refuses a canvas on a docType whose canvas does not print: no profile, `canvasProfile`'s sentence;
 *  a profile outside CANVAS_PRINTS, `The ${name} template's canvas prints in a later release; it keeps
 *  its sections until then.` The registry and the seed both call it (one sentence each). */
export function assertCanvasPrints(docType: TemplateDocTypeString): CanvasProfile {
  const contract = contractFor(docType);
  const profile = canvasProfile(contract);
  if (!CANVAS_PRINTS.has(docType)) {
    throw new TemplateConfigError(
      `The ${contract.name} template's canvas prints in a later release; it keeps its sections until then.`,
    );
  }
  return profile;
}

/** The canvas rules, run on a parsed config: a layout on a docType whose canvas does not print is
 *  refused (`assertCanvasPrints`: no profile, or a profile whose paper has not landed), and the rest
 *  run `validateCanvasLayout` against their own contract. */
function withCanvasRules(docType: TemplateDocTypeString, config: TemplateConfig): TemplateConfig {
  if (config.layout === null) return config;
  assertCanvasPrints(docType);
  validateCanvasLayout(config.layout, contractFor(docType), {
    pageFooter: config.pageFooter, page: canvasPageFor(docType, config.formats.labelSize), fonts: config.fonts,
  });
  return config;
}

/** Read compatibility for immutable versions saved while traveler sign-off fields were optional. */
export function normalizeStoredConfig(docType: TemplateDocTypeString, json: unknown): TemplateConfig {
  if (docType !== "TRAVELER") return validateConfig(docType, json);
  const legacyContract: TemplateContract = {
    ...TRAVELER_CONTRACT,
    sections: TRAVELER_CONTRACT.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => (
        field.key === "step_eq" || field.key === "step_op" || field.key === "step_date"
          ? { ...field, removable: true, lockReason: undefined }
          : field)),
    })),
  };
  const parsed = validateContractConfig(legacyContract, json);
  return withCanvasRules("TRAVELER", withPrintedBudgets("TRAVELER", validateContractConfig(TRAVELER_CONTRACT, {
    ...parsed,
    sections: normalizeTravelerHandwritingFields(parsed.sections, parsed.fonts.baseSize),
  })));
}

/** The type's complete "today's paper" default — what Task 3's seed and `truncateAll()` build
 *  the Standard templates from. */
export function defaultConfigFor(docType: TemplateDocTypeString): TemplateConfig {
  return defaultConfig(contractFor(docType));
}
