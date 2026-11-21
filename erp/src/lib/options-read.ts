// The state of a pick-list options read on the part page (#684), and the title of a select that
// waits on one. Pure and client-safe.
//
// The select stays disabled until its read is ready, and a failed read still reports in the page's
// persistent banner through `onOptionsError` (F9); this leaf decides only what the greyed select
// says. A read that is out is not a failure: it says so in the owner's words, and a closed gate
// keeps its own title (waiting-titles.ts's rule). A read that failed keeps the sentence it always
// carried, ahead of the gate, as before.
import type { Gate } from "./permission-ui";
import { LOADING_OPTIONS, waitingTitle } from "./waiting-titles";

export type OptionsRead = "loading" | "ready" | "failed";

/** The title of a select whose options read failed. Not a waiting title, so not in that leaf. */
export const OPTIONS_FAILED = "Options failed to load — reload the page";

/** The title of a select that waits on an options read: the failure sentence once it failed, the
 *  loading title while it is out (a closed gate keeps its own), and the gate's title once ready. */
export function optionsSelectTitle(gate: Gate, read: OptionsRead): string | undefined {
  if (read === "failed") return OPTIONS_FAILED;
  if (read === "loading") return waitingTitle(gate, true, LOADING_OPTIONS);
  return gate.title;
}
