/**
 * A measuring case's figures, for a report. When the run asks (`W5_MEASURES=1`) this writes one
 * console line that begins `MEASURED`, then what was measured and its value as JSON. Without the
 * variable it writes nothing. It holds nothing either way: the case's own assertions do that.
 */
export function measured(what: string, value: unknown): void {
  if (process.env.W5_MEASURES === "1") console.log(`MEASURED ${what}: ${JSON.stringify(value)}`);
}
