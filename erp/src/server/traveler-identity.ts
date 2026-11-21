import { createHash } from "node:crypto";
import { canonicalPrintExpectation, type PrintExpectationInput } from "../lib/traveler-selection";

export function printExpectationFor(input: PrintExpectationInput): string {
  return createHash("sha256").update(canonicalPrintExpectation(input)).digest("hex");
}
