// Typed values and explicit overrides only. Server previews/defaults never enter this payload.
import { normalizeRequestNonce } from "@/lib/idempotent-save";
import { CERT_SCOPES, type CertScopeValue } from "@/lib/cert-constants";
import { normalizeTravelerSelection, type TravelerSelection } from "@/lib/traveler-selection";
import { newId } from "@/lib/client-id";

export type LoadAdjustmentDraft = {
  enabled: boolean; leadPartId: string | null; loadQty: string; loadWeight: string;
};
export function blankLoadAdjustment(): LoadAdjustmentDraft {
  return { enabled: false, leadPartId: null, loadQty: "", loadWeight: "" };
}
function normalizeLoadAdjustment(raw: unknown): LoadAdjustmentDraft {
  const r = rec(raw);
  return { enabled: r.enabled === true, leadPartId: strOrNull(r.leadPartId),
    loadQty: str(r.loadQty), loadWeight: str(r.loadWeight) };
}
/** Invalid stored sets fall back in their entirety; never salvage an arbitrary subset. */
export function storedTravelerSelection(raw: unknown): TravelerSelection {
  try { return normalizeTravelerSelection(raw); }
  catch { return { mode: "all" }; }
}

export type CustomerOption = {
  id: string; code: string; name: string;
  defaultPo: string; orderNotes: string; creditHold: boolean;
};

export type PartOption = {
  id: string; customerId: string; partNumber: string; name: string;
  eachWeight: number; serializationRequired: boolean;
  /** Whether the part's current process revision carries ≥1 step — surfaced by listParts
   *  (src/server/parts.ts) so the lead-part picker can show this up front (spec §11) rather than
   *  only after a pick. Irrelevant for riders, which never lock a revision. */
  hasProcessSteps: boolean;
  /** Certification chain (spec §6.1, Task 17): the part's own three-state override plus what a
   *  null would inherit (customer default, else plant — computed server-side, parts.ts). The
   *  untouched entry preview composes `certRequired ?? inheritedCertRequired` per line at render
   *  (2C-3: derive, never store), which is exactly `resolveCertSettings`'s own chain because
   *  every part in this customer's catalog shares this customer's defaults. */
  certRequired: boolean | null; certScope: CertScopeValue | null;
  inheritedCertRequired: boolean; inheritedCertScope: CertScopeValue;
};

/** A container type as the pick list sends it. `tareEach` is the type's default tare each in
 *  pounds, or null when the type has none (the weights design §9.4). */
export type ContainerTypeOption = { id: string; name: string; tareEach: number | null };

export type SerialDraft = { id: string; serial: string; description: string };

export type LineDraft = {
  id: string;
  partId: string | null;
  qty: string;
  /** null = show `computed eachWeight × qty`, recomputed every render; non-null = the user's own
   *  typed text, which wins until they use the "reset to computed" affordance. */
  weightOverride: string | null;
  serials: SerialDraft[];
  /** The three-way quote-link pick (spec §5.2, Task 9). ABSENT/undefined = untouched — the
   *  create body OMITS `quoteLineId` and the SERVER's auto-resolution stays authoritative at the
   *  moment it saves; a string = the operator's explicit re-pick; null = the explicit "No quote".
   *  The previewed auto-link's id is NEVER copied in here (QuoteLinkPicker's own contract: the
   *  preview is display, the sentinel is state), which is what structurally guarantees an
   *  untouched control sends ABSENT, not the displayed id. Autosave round-trip: JSON.stringify
   *  drops undefined keys, so a draft carries the pick exactly — absent key = auto, null and an
   *  explicit id survive as themselves (`pickOrUndefined` restores all three states). */
  quoteLineIdOverride?: string | null;
};

export type ContainerDraft = {
  id: string; typeId: string | null;
  /** How many containers the row holds. */
  count: string;
  /** The row's total pieces, in all its containers together. Nothing multiplies it by the count. */
  pieces: string;
  /** null = the Tare each box was never typed in: it shows the picked type's default and follows a
   *  change of type. A string = the operator's own text, a cleared box ("") included, which wins
   *  from then on. The type's default is never stored here (`entryTareEach`,
   *  src/lib/container-tare-prefill.ts). */
  tareEachOverride: string | null;
  /** The row's containers on a scale. Typed only when the row was weighed. */
  scaleGross: string;
  /** §3.22 (Task 17): the customer's own bin id — the ticket's "Cust Cont Id" column. */
  customerContainerId: string;
};

export type ChargeDraft = { id: string; description: string; amount: string };

/** Exactly what gets PUT to /api/order-drafts as `{ payload }`, and exactly what a resumed draft
 *  hydrates back into state — typed values and override flags only, never a server default. */
export type OrderDraftState = {
  /**
   * This draft's idempotency nonce (fix-wave R4 finding 5), minted when a fresh form mounts and
   * carried through every autosave. It lives INSIDE the payload deliberately: that is what makes
   * two tabs resuming the same draft — and the automatic 409 retry of either one's save — the
   * same request as far as `createOrder` is concerned, so they settle on ONE order instead of two.
   * Not something the user types, so `isDraftEmpty` ignores it exactly as it ignores the
   * synthetic row ids.
   */
  clientRequestId: string;
  customerId: string | null;
  /** null = show the selected customer's defaultPo; non-null = the user's own text. */
  poOverride: string | null;
  vsOrderNumber: string;
  customerJobNo: string;
  /** Cert preview overrides (spec §6.1 "overridable at entry", Task 17). null = show the chain's
   *  own resolution, recomputed every render from the picked parts (2C-3: nothing derived is
   *  ever stored); non-null = the user's explicit answer, which wins until reset and is the only
   *  case where the create body carries the key at all. */
  certRequiredOverride: boolean | null;
  certScopeOverride: CertScopeValue | null;
  /** null = show today (recomputed every render); non-null = the user's own text. */
  receivedDateOverride: string | null;
  /** null = show the entry-defaults fetch result; non-null = the user's own text. */
  requestDateOverride: string | null;
  targetDate: string | null;
  notes: string;
  lines: LineDraft[];
  containers: ContainerDraft[];
  charges: ChargeDraft[];
  loadAdjustmentDraft: LoadAdjustmentDraft;
  travelerSelection: TravelerSelection;
};

// ---------------------------------------------------------------------------------------------
// Blank-state builders and defensive normalization for a resumed draft.
// ---------------------------------------------------------------------------------------------

export function blankLine(): LineDraft {
  return { id: newId(), partId: null, qty: "", weightOverride: null, serials: [] };
}
export function blankContainer(): ContainerDraft {
  return { id: newId(), typeId: null, count: "", pieces: "", tareEachOverride: null, scaleGross: "", customerContainerId: "" };
}
export function blankCharge(): ChargeDraft {
  return { id: newId(), description: "", amount: "" };
}
export function blankDraft(): OrderDraftState {
  return {
    clientRequestId: newId(),
    customerId: null, poOverride: null, vsOrderNumber: "", customerJobNo: "",
    certRequiredOverride: null, certScopeOverride: null,
    receivedDateOverride: null, requestDateOverride: null, targetDate: null,
    notes: "", lines: [blankLine()], containers: [], charges: [],
    loadAdjustmentDraft: blankLoadAdjustment(), travelerSelection: { mode: "all" },
  };
}

// The autosaved payload is `unknown` on the wire (OrderDraft.payload is opaque Json) — normalize
// defensively on the way back in rather than trusting it blindly, the same caution the old
// per-step process editor's `buildStepOriginals` callers took with server data of unknown shape.
function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function strOrNull(v: unknown): string | null { return typeof v === "string" ? v : null; }
/** The quote pick's three states must all survive the round trip — unlike `strOrNull`, a
 *  genuine null here means the explicit "No quote", so only a truly absent/garbage value
 *  degrades to undefined (= auto, the safe state: the server resolves). */
function pickOrUndefined(v: unknown): string | null | undefined {
  return v === null ? null : typeof v === "string" ? v : undefined;
}
function arr(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function normalizeLine(raw: unknown): LineDraft {
  const r = rec(raw);
  return {
    id: typeof r.id === "string" ? r.id : newId(),
    partId: strOrNull(r.partId),
    qty: str(r.qty),
    weightOverride: strOrNull(r.weightOverride),
    // Two stored shapes (#663): the compact `[serial, description]` pair the autosave writes, and
    // the `{id, serial, description}` object drafts stored before it hold. Both mint an id on
    // read; the ids only route refusals within one page session.
    serials: arr(r.serials).map((s) => {
      if (Array.isArray(s)) return { id: newId(), serial: str(s[0]), description: str(s[1]) };
      const sr = rec(s);
      return { id: typeof sr.id === "string" ? sr.id : newId(), serial: str(sr.serial), description: str(sr.description) };
    }),
    quoteLineIdOverride: pickOrUndefined(r.quoteLineIdOverride),
  };
}
// The keys are read by name. A draft saved before the weights change held `qty`, `tareWeight` and
// `grossWeight`, which meant other things: pieces in one container, a row's tare, a row's gross.
// They are not read. Such a draft resumes with Pieces and Scale gross blank and Tare each following
// its type, as a new row's does (the weights design §9.4 and §9.9, point 22). No stored draft is
// rewritten: the next autosave writes the new shape.
function normalizeContainer(raw: unknown): ContainerDraft {
  const r = rec(raw);
  return {
    id: typeof r.id === "string" ? r.id : newId(),
    typeId: strOrNull(r.typeId), count: str(r.count), pieces: str(r.pieces),
    tareEachOverride: strOrNull(r.tareEachOverride), scaleGross: str(r.scaleGross),
    customerContainerId: str(r.customerContainerId),
  };
}
/** A resumed draft's stored override is trusted only when it is one of the three real scopes —
 *  anything else (a hand-edited payload, a future enum change) degrades to "no override", which
 *  is the safe state: the preview re-derives. */
function scopeOrNull(v: unknown): CertScopeValue | null {
  return typeof v === "string" && (CERT_SCOPES as readonly string[]).includes(v) ? (v as CertScopeValue) : null;
}
function boolOrNull(v: unknown): boolean | null { return typeof v === "boolean" ? v : null; }
function normalizeCharge(raw: unknown): ChargeDraft {
  const r = rec(raw);
  return { id: typeof r.id === "string" ? r.id : newId(), description: str(r.description), amount: str(r.amount) };
}
/** The draft as the autosave stores it (#663): each line's serials as `[serial, description]`
 *  pairs, without the 36-character client ids, which made a draft of about 3,200 serials outgrow
 *  the server's cap while Save accepts 10,000 per line. `normalizeDraft` reads this shape and the
 *  older object shape alike. Everything else is stored as typed. */
export function compactDraft(draft: OrderDraftState): unknown {
  return { ...draft, lines: draft.lines.map((line) => ({ ...line, serials: line.serials.map((s) => [s.serial, s.description]) })) };
}
export function normalizeDraft(raw: unknown): OrderDraftState {
  const r = rec(raw);
  const lines = arr(r.lines).map(normalizeLine);
  return {
    // KEPT, not regenerated: a resumed draft carrying the same nonce is precisely how the second
    // tab's save is recognized as the first tab's request rather than a new order. A draft
    // autosaved before this field existed gets a fresh one (normalizeRequestNonce).
    clientRequestId: normalizeRequestNonce(r.clientRequestId),
    customerId: strOrNull(r.customerId),
    poOverride: strOrNull(r.poOverride),
    vsOrderNumber: str(r.vsOrderNumber),
    customerJobNo: str(r.customerJobNo),
    certRequiredOverride: boolOrNull(r.certRequiredOverride),
    certScopeOverride: scopeOrNull(r.certScopeOverride),
    receivedDateOverride: strOrNull(r.receivedDateOverride),
    requestDateOverride: strOrNull(r.requestDateOverride),
    targetDate: strOrNull(r.targetDate),
    notes: str(r.notes),
    lines: lines.length > 0 ? lines : [blankLine()],
    containers: arr(r.containers).map(normalizeContainer),
    charges: arr(r.charges).map(normalizeCharge),
    loadAdjustmentDraft: normalizeLoadAdjustment(r.loadAdjustmentDraft),
    travelerSelection: storedTravelerSelection(r.travelerSelection),
  };
}

/** True for the untouched blank starting state (ignoring the synthetic local `id` fields and the
 *  draft's own `clientRequestId` nonce, none of which is anything the user typed and all of which
 *  differ from a freshly-generated blank's by construction). Gates autosave so that simply
 *  visiting this page and leaving — without typing anything — does not leave behind a draft that
 *  greets the next visit with a "Resume a draft?" prompt for nothing (caught live in this task's
 *  own dev-server smoke test, not a hypothetical). A draft that WAS resumed or edited and is then
 *  cleared back to blank still autosaves normally — this only suppresses the FIRST write. */
export function isDraftEmpty(d: OrderDraftState): boolean {
  return d.customerId === null && d.poOverride === null && d.vsOrderNumber === ""
    && d.customerJobNo === "" && d.certRequiredOverride === null && d.certScopeOverride === null
    && d.receivedDateOverride === null && d.requestDateOverride === null && d.targetDate === null
    && d.notes === "" && d.containers.length === 0 && d.charges.length === 0
    && d.lines.length === 1 && d.lines[0].partId === null && d.lines[0].qty === ""
    && d.lines[0].weightOverride === null && d.lines[0].serials.length === 0
    && d.lines[0].quoteLineIdOverride === undefined
    && !d.loadAdjustmentDraft.enabled && d.loadAdjustmentDraft.loadQty === ""
    && d.loadAdjustmentDraft.loadWeight === "" && d.travelerSelection.mode === "all";
}

