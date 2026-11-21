// Client-safe and pure: where New order takes the operator when the SERVER refuses a container
// row's value (#494). The page's own checks refuse the same values first, each on its own row, so
// this is reached only when the two disagree. The refusal keeps the server's own sentence; this
// decides only which box takes the cursor, and so which row opens its optional boxes
// (`EntryContainerRow`). vitest has no component renderer, so the page asks this and shows what it
// answers (tests/container-refusal-field.test.ts).
//
// The server names a refused container value by its path, `containers.<index>.<key>: <sentence>`
// (`readableMessage`, src/server/error-message.ts). The index counts from 0, as the rows stand in
// the body the page sent. A key the create schema does not know is refused one level up, as
// `containers.<index>: Unrecognized key: "<key>"`, and the words of the quoted key lead to the box
// that took its place.
//
// A refusal that names no row goes to the Containers section's Add container button, and no row's
// box is chosen (owner ruling, 2026-10-15): the server's refusal of a container type deleted while
// the page was open, which names no row, a refusal of the container list itself, and a path to a
// row the page no longer holds.
import { REFERENCE_LABELS } from "./reference-constants";

/** The last part of each container box's id on New order (`EntryContainerRow`). */
export type ContainerBox = "type" | "count" | "pieces" | "tareEach" | "scaleGross" | "customerContainerId";

/** Each key of the server's container row (`CONTAINER_ITEM`, src/server/order-internals.ts) and the
 *  box that holds it. */
export const CONTAINER_KEY_BOXES = {
  typeId: "type",
  count: "count",
  pieces: "pieces",
  tareEach: "tareEach",
  scaleGross: "scaleGross",
  customerContainerId: "customerContainerId",
} as const satisfies Record<string, ContainerBox>;

/** The id of the Containers section's Add container button. */
export const ADD_CONTAINER_ID = "entry-add-container";

/** `assertRefExists`'s refusal of a container type that is not live (src/server/reference-guards.ts). */
const NO_SUCH_TYPE = `That ${REFERENCE_LABELS.containerType.singular.toLowerCase()} does not exist`;

/** The box a row-level refusal's words lead to: the old names of the renamed keys among them. */
function boxByWords(message: string): ContainerBox {
  if (/tare/i.test(message)) return "tareEach";
  if (/gross/i.test(message)) return "scaleGross";
  if (/count/i.test(message)) return "count";
  if (/pieces|quantity|qty/i.test(message)) return "pieces";
  return "type";
}

/** The id of the box a server refusal is about, or null when it is not about a container row.
 *  `rowIds` are the page's container rows, in the order it sent them. */
export function containerRefusalField(message: string, rowIds: readonly string[]): string | null {
  if (message === NO_SUCH_TYPE) return ADD_CONTAINER_ID;
  const path = message.match(/^containers(?:\.(\d+)(?:\.([^.:\s]+))?)?: /);
  if (!path) return null;
  const rowId = path[1] === undefined ? undefined : rowIds[Number(path[1])];
  if (rowId === undefined) return ADD_CONTAINER_ID;
  const key = path[2];
  const box = key !== undefined && Object.hasOwn(CONTAINER_KEY_BOXES, key)
    ? CONTAINER_KEY_BOXES[key as keyof typeof CONTAINER_KEY_BOXES]
    : boxByWords(message);
  return `entry-container-${rowId}-${box}`;
}
