// Client-safe and pure: where New order takes the operator when the SERVER refuses a part line's
// or a serial's value (#546, owner ruling 2026-10-18). The page's own checks refuse what they can
// first, so this is reached when the two disagree, or when the server knows what the page cannot
// (a part made inactive, or a quote closed, while the page was open). The refusal keeps the
// server's own sentence; this decides only which box takes the cursor. vitest has no component
// renderer, so the page asks this and shows what it answers (tests/line-refusal-field.test.ts).
//
// The server names a refused value in one of two ways:
// - by its path (`readableMessage`, src/server/error-message.ts): `lines.<i>.<key>: <sentence>`,
//   or `lines.<i>.serials.<j>.<key>: <sentence>` for a serial, each index counting from 0 as the
//   rows stand in the body the page sent. A key the create schema does not know is refused one
//   level up, as `lines.<i>: Unrecognized key: "<key>"`;
// - by the label `lineLabel` writes (src/server/order-internals.ts), counting from 1: `Line N:
//   <sentence>`, or `Line N (<customer code> · <part number>): <sentence>`. New order's create
//   writes it as a refusal in `resolveLineParts`, `resolveQuoteLinks` and `duplicateSerialError`
//   (and as a warning in `buildWarnings`). The label's number picks the line, and the box is
//   chosen from the words after the label only: the customer code and the part number are the
//   customer's to choose, so either can hold a word (`QTY-9`), a `): ` or another label
//   (`Line 3 (`). The words after the label begin after `: ` when it follows the label directly,
//   and otherwise after the LAST `): ` in the message: no sentence the server writes after the
//   label holds `): `, but for the quoted serial of a serial entered twice, which is read before
//   any word is.
//
// A serial entered twice (`Line N (…): serial "X" is entered twice`, X as the server trimmed it)
// goes to the first serial on that line whose trimmed value is X (owner ruling, 2026-10-18). Each
// serial is compared whole against the message, never searched for, so a serial whose value only
// appears in it, inside the label's customer code or part number (`P "B"`) or inside the repeated
// value, is not taken for the repeat. A serial blank after trimming is never taken for it (owner
// answer 3, 2026-10-18). A sentence of that shape is never read for words: when no serial on the
// line matches, it goes to the line's Add serial(s) box (below), so a repeated serial such as
// `QUOTE-9` cannot lead to the quote box.
//
// One contrived message stays ambiguous, and is accepted. It needs a serial value holding
// `): serial "`, and `): serial "` twice in the message, in one of two forms: the repeated value is
// `<text>): serial "<the value of a serial earlier on the line>` (`K): serial "V` after `V`, the
// label naming an ordinary part), or the customer code or part number holds `): serial "` and a
// serial earlier on the line reads, whole, the rest of the label after it, `: serial "` and the
// repeated value. Both serials then make the message match whole, and the first on the line is
// chosen (tests/line-refusal-field.test.ts pins the first form).
//
// A refused quote link goes to the line's Part box when the line's quote picker shows no list
// (owner ruling, 2026-10-18), which the page answers through `shown` (the `-quote` id is on the
// picker's list alone).
//
// A refusal that names a row the page holds but no box it can find goes to that row's own first
// box (owner answer 2, 2026-10-18). That departs from #494's container leaf, which reads the words
// of a container row's refusal that names no key, because some container keys were renamed and an
// old name's words lead to the box that took its place. No line, serial or charge key was renamed.
//
// A refusal that names no line the page holds goes to the lead line's Part box (owner ruling,
// 2026-10-18), stated at each place below.

/** The last part of each part line box's id on New order (`OrderLineCard`). `serials` is the line's
 *  Add serial(s) box. */
export type LineBox = "part" | "qty" | "weight" | "serials" | "quote";

/** The box of one serial on a line: its value, or its description. */
export type SerialBox = "serial" | "description";

/** Each key of the server's part line (`LINE`, src/server/order-internals.ts) and the box that
 *  holds it. */
export const LINE_KEY_BOXES = {
  partId: "part",
  qty: "qty",
  weight: "weight",
  serials: "serials",
  quoteLineId: "quote",
} as const satisfies Record<string, LineBox>;

/** Each key of the server's serial (`SERIAL_ITEM`, src/server/order-internals.ts) and the box that
 *  holds it. */
export const SERIAL_KEY_BOXES = {
  serial: "serial",
  description: "description",
} as const satisfies Record<string, SerialBox>;

/** A part line as the page holds it: its id and its serials, in the order it sends them. */
export type RefusalLine = { id: string; serials: readonly { id: string; serial: string }[] };

const PATH = /^lines(?:\.(\d+)(?:\.([^.:\s]+)(?:\.(\d+)(?:\.([^.:\s]+))?)?)?)?: /;
/** `lineLabel`'s label alone: `Line N`, then `: ` or ` (`. Another screen's `Line N · …` is
 *  not it. */
const LABEL = /^Line (\d+)(?=: | \()/;
/** `duplicateSerialError`'s sentence, for a serial of any value. */
const DUPLICATE = /: serial "[\s\S]*" is entered twice$/;

const lineBoxId = (line: RefusalLine, box: LineBox) => `entry-line-${line.id}-${box}`;
const serialBoxId = (line: RefusalLine, serialId: string, box: SerialBox) =>
  `entry-line-${line.id}-serial-${serialId}${box === "description" ? "-description" : ""}`;

/** The line's box, or its Part box for a quote box the page does not show (owner ruling,
 *  2026-10-18: a refused quote link on a line whose quote picker shows no list goes to that line's
 *  Part box). */
function shownLineBox(line: RefusalLine, box: LineBox, shown: (fieldId: string) => boolean): string {
  const id = lineBoxId(line, box);
  return box === "quote" && !shown(id) ? lineBoxId(line, "part") : id;
}

/** The box the words after a label lead to. The words, their order and the Part box for any other
 *  words are the page's routing before #546 (`serverProblem`, which still routes a refusal that
 *  names no line this way), kept by the ruling for the words after the label. No sentence the
 *  server writes after a label holds two of these words (a quote reason holds `quote` alone of
 *  them, each of the saved order's sentences at most one, and a serial entered twice never reaches
 *  here), so their order among themselves is unexercised by any server sentence: only each word's
 *  precedence over the Part box is, and of `quantity|qty` only `qty` (no sentence after a label
 *  holds `quantity`). */
function boxByWords(words: string): LineBox {
  if (/quote/i.test(words)) return "quote";
  if (/serial/i.test(words)) return "serials";
  if (/weight/i.test(words)) return "weight";
  if (/quantity|qty/i.test(words)) return "qty";
  return "part";
}

/** The first serial on the line that the message names as entered twice, by its trimmed value. */
function repeatedSerial(message: string, label: string, line: RefusalLine) {
  return line.serials.find(({ serial }) => {
    const value = serial.trim();
    if (!value) return false;
    const tail = `: serial "${value}" is entered twice`;
    if (!message.endsWith(tail)) return false;
    const head = message.slice(0, message.length - tail.length);
    return head === label || (head.startsWith(`${label} (`) && head.endsWith(")"));
  });
}

/** The words after the label, or null when the label is not followed by `: ` or a closed `(…): `. */
function wordsAfterLabel(message: string, label: string): string | null {
  if (message.startsWith(": ", label.length)) return message.slice(label.length + 2);
  const end = message.lastIndexOf("): ");
  return end === -1 ? null : message.slice(end + 3);
}

/** The id of the box a server refusal is about, or null when it is not about a part line. `lines`
 *  are the page's part lines, in the order it sent them; `shown` answers whether a box is in the
 *  document. */
export function lineRefusalField(
  message: string, lines: readonly RefusalLine[], shown: (fieldId: string) => boolean,
): string | null {
  // The page always holds the lead line; for a page that holds none there is no box to choose.
  const lead = lines[0];
  if (lead === undefined) return null;

  const path = message.match(PATH);
  if (path) {
    const line = path[1] === undefined ? undefined : lines[Number(path[1])];
    // The line list itself, or a line past the page's lines: the lead line's Part box (owner
    // ruling, 2026-10-18). The page sends every line it holds, so neither is expected.
    if (line === undefined) return lineBoxId(lead, "part");
    const key = path[2];
    if (key === "serials" && path[3] !== undefined) {
      const serial = line.serials[Number(path[3])];
      // A serial the line does not hold: that line's Add serial(s) box (owner answer 2, 2026-10-18).
      if (serial === undefined) return lineBoxId(line, "serials");
      const serialKey = path[4];
      // A held serial with no key, or a key the schema does not know: its value box (owner answer
      // 2, 2026-10-18).
      const box = serialKey !== undefined && Object.hasOwn(SERIAL_KEY_BOXES, serialKey)
        ? SERIAL_KEY_BOXES[serialKey as keyof typeof SERIAL_KEY_BOXES]
        : "serial";
      return serialBoxId(line, serial.id, box);
    }
    // A held line with no key, or a key the schema does not know: that line's Part box (owner
    // answer 2, 2026-10-18).
    const box = key !== undefined && Object.hasOwn(LINE_KEY_BOXES, key)
      ? LINE_KEY_BOXES[key as keyof typeof LINE_KEY_BOXES]
      : "part";
    return shownLineBox(line, box, shown);
  }

  const label = message.match(LABEL);
  if (!label) return null;
  const line = lines[Number(label[1]) - 1];
  // A line number past the page's lines, or Line 0: the lead line's Part box (owner ruling,
  // 2026-10-18). The server numbers the lines it was sent from 1, so neither is expected.
  if (line === undefined) return lineBoxId(lead, "part");
  const serial = repeatedSerial(message, label[0], line);
  if (serial !== undefined) return serialBoxId(line, serial.id, "serial");
  // A serial entered twice that the line does not hold: that line's Add serial(s) box (owner
  // answer 2, 2026-10-18), never a box the serial's own words would lead to.
  if (DUPLICATE.test(message)) return lineBoxId(line, "serials");
  const words = wordsAfterLabel(message, label[0]);
  // A label with no sentence after it that can be told apart: that line's Part box (owner answer
  // 2, 2026-10-18). `lineLabel` always closes its parentheses, so the server does not write one.
  if (words === null) return lineBoxId(line, "part");
  return shownLineBox(line, boxByWords(words), shown);
}
