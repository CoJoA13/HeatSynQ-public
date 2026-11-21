// The traveler preview dialog's decisions (spec 2026-09-26 §5), as pure functions: which header
// the render is asked for, whether a render may be requested at all, and what a response must
// carry to be shown. Client-safe — no server imports — and kept out of the component so each rule
// can be exercised both ways without a DOM and proven by mutation.

export type PreviewContext = Readonly<{ orderId: string; orderNumber: number; loadNumber: number }>;
/** One order/load pair's identity in the picker and in a request's `contextKey`. */
export const contextKeyOf = (c: PreviewContext): string => `${c.orderId}:${c.loadNumber}`;

/** A SAMPLE header needs only these two (Task 6); a real order also needs `orders.view`. */
export const PREVIEW_VIEW_PERMISSIONS = ["parts.view", "processes.view"] as const;
export const SAMPLE_NO_ORDERS_VIEW = "A real order needs orders.view access, so this preview has a SAMPLE header.";
/** The owner's wording (2026-09-27). The context list holds only live orders that lead with this
 *  part AND have a load, so an order without a load yet cannot supply the header either. */
export const SAMPLE_NO_ORDER = "No order for this part has a load yet, so this preview has a SAMPLE header.";

/** `order`: render around that order and load. `sample`: render the SAMPLE header, for the stated
 *  reason. `pending`: the context list has not answered for the current key. `none`: nothing to
 *  render — a search with no match, a page past the end, or a list read that failed. */
export type PreviewTarget =
  | Readonly<{ kind: "order"; context: PreviewContext }>
  | Readonly<{ kind: "sample"; reason: string }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "none"; reason: string }>;

/**
 * Which header the preview renders around the draft.
 *
 * "No eligible order" means the UNFILTERED list is empty (pre-flight M13): an exact-number search
 * that matched nothing, or a page walked past the last order, is not a reason to print a SAMPLE
 * over what the operator asked for. The first item is the default — the newest order with its
 * lowest load, the order the server lists them in — and a selection that is no longer listed
 * falls back to it rather than to nothing.
 */
export function resolvePreviewTarget(args: Readonly<{
  ordersAllowed: boolean; error: string | null; listed: boolean; items: readonly PreviewContext[]; selected: string; filtered: boolean; query: string;
}>): PreviewTarget {
  if (!args.ordersAllowed) return { kind: "sample", reason: SAMPLE_NO_ORDERS_VIEW };
  if (args.error !== null) return { kind: "none", reason: args.error };
  if (!args.listed) return { kind: "pending" };
  if (args.items.length === 0) {
    if (!args.filtered) return { kind: "sample", reason: SAMPLE_NO_ORDER };
    return { kind: "none", reason: args.query ? `No saved order ${args.query} leads with this part and has a load.` : "No more orders." };
  }
  return { kind: "order", context: args.items.find(c => contextKeyOf(c) === args.selected) ?? args.items[0] };
}

/** Whether a render may be requested. `open` is load-bearing (pre-flight M8): the dialog is
 *  mounted with the section, so without it every part-page load and every debounced edit would
 *  POST a traveler render nobody is looking at — and `manual:capture` counts an aborted one as a
 *  screen failure. */
export function previewAvailable(args: Readonly<{
  open: boolean; viewAllowed: boolean; denied: boolean; target: PreviewTarget; hasDocument: boolean; unavailableReason: string | undefined;
}>): boolean {
  return args.open && args.viewAllowed && !args.denied && args.hasDocument && args.unavailableReason === undefined
    && (args.target.kind === "order" || args.target.kind === "sample");
}

/** The server refused the caller (401/403): its own kind, so the dialog says what is required
 *  instead of offering a retry that cannot help. */
export class PreviewDenied extends Error {}

export type PreviewResult = Readonly<{ pages: number; templateName: string; sample: boolean; blob: Blob }>;

/**
 * The checks carried over from the side panel: a PDF body type, a sane page count, the generation
 * this request asked for (an answer to an older request is invalid, not merely stale), the
 * template's identity, and the `%PDF-` magic on the bytes themselves.
 */
export async function readPreviewResponse(response: Response, generation: number): Promise<PreviewResult> {
  if (response.status === 401 || response.status === 403) throw new PreviewDenied("Preview requires current parts and processes view access.");
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Preview failed (${response.status})`);
  }
  const pages = Number(response.headers.get("X-Preview-Page-Count"));
  if (response.headers.get("content-type")?.split(";")[0] !== "application/pdf" || !Number.isSafeInteger(pages) || pages < 1
    || response.headers.get("X-Preview-Generation") !== String(generation)) throw new Error("The server returned an invalid PDF preview. Retry the preview.");
  const name = response.headers.get("X-Preview-Template-Name");
  if (!name || !response.headers.get("X-Preview-Template-Id")) throw new Error("The preview template could not be identified.");
  const blob = await response.blob();
  if ((await blob.slice(0, 5).text()) !== "%PDF-") throw new Error("The server returned an invalid PDF preview.");
  return { pages, templateName: decodeURIComponent(name), sample: response.headers.get("X-Preview-Sample") === "1", blob };
}
