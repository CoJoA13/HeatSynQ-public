/**
 * A stubbed docType for the cases that need a contract whose canvas does not print (design 2026-11-12
 * §4.6, call 12). The quotation was "the document with no canvas" until its profile; these cases now
 * stand on a docType the registry does not know, so a later profile cannot empty them into a pass
 * that proves nothing. Given no profile, the stub reaches the registry's no-profile refusal; given one
 * (`withTestContract`'s `canvas` option), it stands outside `CANVAS_PRINTS` and reaches the
 * later-release refusal, which since quote canvas PR 2 no real docType reaches, every one printing.
 *
 * The stub is registered only for the length of one `withTestContract` call: a plain property save
 * and delete on `CONTRACTS`, never a spy (a spy's restore does not put a property back reliably), and
 * deleted however the call ends. A stub case never hands "TEST" to a table keyed by docType
 * (`COLUMN_TABLE_LAYOUTS`, `previewRecordSpec`, `CANVAS_RECORD_WORDS`, `designOnCanvasGate`,
 * `pickRecordFirst`), none of which has a TEST row.
 */
import {
  CONTRACTS, QUOTE_CONTRACT, type TemplateContract, type TemplateDocTypeString,
} from "@/lib/template-contracts/index";
import type { CanvasProfile } from "@/lib/template-contracts/types";

/** A docType the registry does not know, for the cases that need a contract with no canvas (design
 *  2026-11-12 §4.6, call 12). Cast: `TemplateDocTypeString` has no such member. */
export const TEST_DOC_TYPE = "TEST" as unknown as TemplateDocTypeString;

/** The quotation's contract under TEST_DOC_TYPE, named "Test": its sections without the four column
 *  fields of `column_header` (COLUMN_TABLE_LAYOUTS has no TEST row), its text blocks and knobs, and no
 *  `canvas` key at all (deleted, so the stub stays profile-free once QUOTE_CONTRACT gains one), unless
 *  `canvas` is given, which is put back as the stub's profile. */
export function testContract(canvas?: CanvasProfile): TemplateContract {
  const contract: TemplateContract = {
    ...QUOTE_CONTRACT,
    docType: TEST_DOC_TYPE,
    name: "Test",
    sections: QUOTE_CONTRACT.sections.map((section) => (
      section.key === "column_header"
        ? { ...section, fields: section.fields.filter((field) => field.column === undefined) }
        : section)),
  };
  delete contract.canvas;
  if (canvas !== undefined) contract.canvas = canvas;
  return contract;
}

const registry = CONTRACTS as typeof CONTRACTS & { TEST?: TemplateContract };

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null
    && typeof (value as { then?: unknown }).then === "function";
}

/** Registers testContract(opts.canvas) as CONTRACTS.TEST, runs `run`, and deletes the key afterwards,
 *  on each of the three ways `run` can end: a synchronous throw, a returned thenable once it settles,
 *  and a plain return. Throws, before registering, when the key is already present. A plain property
 *  save and delete, never a spy. The leak case in tests/template-canvas.test.ts is its one witness. */
export function withTestContract<T>(run: () => T, opts: { canvas?: CanvasProfile } = {}): T {
  if (Object.hasOwn(registry, "TEST")) {
    throw new Error("CONTRACTS.TEST is already registered: a stub case left it behind, or two are nested.");
  }
  registry.TEST = testContract(opts.canvas);
  let result: T;
  try {
    result = run();
  } catch (error) {
    delete registry.TEST; // delete 1: a synchronous throw
    throw error;
  }
  if (isThenable(result)) {
    return Promise.resolve(result).finally(() => { delete registry.TEST; }) as T; // delete 2: a thenable, once it settles
  }
  delete registry.TEST; // delete 3: a plain return
  return result;
}
