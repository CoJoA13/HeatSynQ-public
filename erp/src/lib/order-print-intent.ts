import { z } from "zod";
import { normalizeTravelerSelection, travelerSelectionSchema, type TravelerSelection } from "./traveler-selection";
import { newId } from "./client-id";

export type OrderPrintIntent = {
  version: 1; orderId: string; selection: TravelerSelection; expectedPrintFingerprint: string;
};

const intentSchema = z.object({
  version: z.literal(1), orderId: z.string().min(1).max(200),
  selection: travelerSelectionSchema, expectedPrintFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const PREFIX = "heatsynq:order-print:";
const KEY = /^heatsynq:order-print:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BYTES = 8192;

function validated(input: unknown): OrderPrintIntent {
  const parsed = intentSchema.parse(input);
  return { ...parsed, selection: normalizeTravelerSelection(parsed.selection) };
}

/** Only a small, validated print request crosses navigation; never persist the create DTO. */
export function storeOrderPrintIntent(storage: Storage, intent: OrderPrintIntent): string {
  const raw = JSON.stringify(validated(intent));
  if (new TextEncoder().encode(raw).length > MAX_BYTES) throw new Error("Print intent is too large");
  const key = PREFIX + newId();
  storage.setItem(key, raw);
  return key;
}

/** A URL value cannot address another feature's storage. Consumption precedes validation and
 * return; if removal cannot be proven, the caller must use manual saved-order review. */
export function takeOrderPrintIntent(storage: Storage, key: string, orderId: string): OrderPrintIntent | null {
  if (!KEY.test(key)) return null;
  try {
    const raw = storage.getItem(key);
    storage.removeItem(key);
    if (raw === null || new TextEncoder().encode(raw).length > MAX_BYTES) return null;
    const intent = validated(JSON.parse(raw));
    return intent.orderId === orderId ? intent : null;
  } catch { return null; }
}

type PrintLoad = { loadNumber: number; qty: number | null; weight: number | null };
export type CreatedOrderForPrint = {
  order: { id: string; loads: PrintLoad[] }; printExpectation?: string; deduped?: true;
};

/** A replay is review-only. Match the displayed load plan against the actual saved response,
 * then carry the server's saved-state expectation through to its transactional print check. */
export function prepareOrderPrintIntent(
  result: CreatedOrderForPrint, selection: TravelerSelection, reviewedLoads: readonly PrintLoad[],
): OrderPrintIntent | null {
  if (result.deduped) return null;
  try {
    const saved = result.order.loads;
    if (saved.length !== reviewedLoads.length || new Set(saved.map(load => load.loadNumber)).size !== saved.length) return null;
    if (reviewedLoads.some(load => !saved.some(row => row.loadNumber === load.loadNumber && row.qty === load.qty && row.weight === load.weight))) return null;
    const intent = validated({ version: 1, orderId: result.order.id, selection, expectedPrintFingerprint: result.printExpectation });
    if (intent.selection.mode === "all") {
      if (saved.length > 100) return null;
    } else if (intent.selection.loadNumbers.some(number => !saved.some(load => load.loadNumber === number))) return null;
    return intent;
  } catch { return null; }
}
