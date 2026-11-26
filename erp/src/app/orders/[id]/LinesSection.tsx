"use client";
import { formatDate } from "@/lib/format";
import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/fetcher";
import { getBrowserDraftSession } from "@/lib/draft-session";
import {
  NO_FIELD_SAVES, anyNotSaved, checkLineField, cleared, dispatched, failed, fieldKey, fieldView,
  landed, reconciled, refused, restoreIntent, retained, saveIntent, serverValues, settled, typed,
  unansweredStatus, type FieldSaves, type FieldView, type LineField,
} from "@/lib/line-field-saves";
import {
  NO_UNCONFIRMED_REMOVALS, REMOVAL_NOT_CONFIRMED, alreadyRemovedMessage, anyRemovalUnconfirmed,
  removalNotice, removalProvesGone, removalUnanswered, removalsListed, removedNotRefreshedMessage,
  type UnconfirmedRemovals,
} from "@/lib/line-removals";
import { decimalRefusal } from "@/lib/decimal-entry";
import { askConfirm } from "@/lib/modal";
import { lineWeightOffer } from "@/lib/net-weight";
import { LINE_NET_WEIGHT } from "@/lib/order-boxes";
import type { Gate } from "@/lib/permission-ui";
import { serialsScope, unsavedPresentInScope } from "@/lib/unsaved-guard";
import { useUnsavedSection } from "@/lib/use-unsaved-section";
import { NET_WEIGHT_LB } from "@/lib/weight-terms";
import { WeightOfferNote } from "@/components/WeightOfferNote";
import { Combobox, type ComboboxOption } from "@/components/Combobox";
import { computeLineWeight } from "../new/OrderLineCard";
import {
  QuoteLinkPicker, type EligiblePayload, type QuoteLinkPick,
} from "../new/QuoteLinkPicker";
import { FieldMark } from "./LineFieldStatus";
import { PanelMessage } from "@/components/PanelMessage";
import type { ApplyMutation, OrderLine, OrderMutationResult, PartOption } from "./page";
import { BUTTON_PRIMARY_COMPACT, CARD, INPUT_COMPACT, LINK } from "@/lib/ui-classes";
import { partOptions } from "@/lib/menu-options";

function lineLabel(line: OrderLine): string {
  return line.position === 1 ? "Lead" : `Line ${line.position}`;
}

/** What a Not saved box says in its line's detail row, or null for any other box. A client-side
 *  refusal is worded again here from the text in the box, so it names the line as it is numbered
 *  now (removing an earlier rider renumbers the ones after it). A server message is shown as it
 *  came: it names the line by part number as well. */
function fieldMessage(line: OrderLine, field: LineField, view: FieldView): string | null {
  if (view.mark !== "not-saved") return null;
  return checkLineField(field, view.text, lineLabel(line)) ?? view.message;
}

/** The lines a weight may be offered for, after a save of `field` landed for `lineId`. A quantity
 *  save adds its line: the stored quantity changed, so quantity × each weight may no longer be the
 *  stored weight. A weight save removes it: the stored weight is now one the operator chose, by
 *  accepting the offer or by typing a weight of their own. The same Set when nothing changes. */
function offerLinesAfter(cur: ReadonlySet<string>, lineId: string, field: LineField): ReadonlySet<string> {
  if (cur.has(lineId) === (field === "qty")) return cur;
  const next = new Set(cur);
  if (field === "qty") next.add(lineId);
  else next.delete(lineId);
  return next;
}

/**
 * The SAVED line's quote re-pick (spec §5.2's re-pick rule): mounted only when the user opens it,
 * and only while the section's edit gate is open (it takes no gate itself; #472),
 * it fetches eligibility against the order's CURRENT received date and PATCHes `quoteLineId`
 * only on an explicit selection. The untouched state is represented by the "keep" placeholder —
 * selecting nothing (or closing) sends NO request, so the stored link is kept by updateLine's
 * absent-key semantics rather than re-asserted; the stored id is never echoed back. The current
 * link is excluded from the option list (picking it again would be a no-op write minting an
 * empty audit diff), and "No quote" is offered only while a link exists to remove.
 */
function LineQuoteRepick({
  orderId, line, customerId, receivedDate, viewAllowed, applyMutation, onError, onClose,
}: {
  orderId: string;
  line: OrderLine;
  customerId: string;
  receivedDate: string;
  viewAllowed: boolean;
  applyMutation: ApplyMutation;
  onError: (message: string | null) => void;
  onClose: () => void;
}) {
  const [payload, setPayload] = useState<EligiblePayload | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const partId = line.partId;
  useEffect(() => {
    if (!viewAllowed) return;
    let stale = false;
    const qs = new URLSearchParams({ customerId, partId, receivedDate });
    api<EligiblePayload>(`/api/quotes/eligible?${qs}`).then((p) => {
      if (!stale) setPayload(p);
    }).catch((e) => {
      if (!stale) setFetchError((e as Error).message);
    });
    return () => { stale = true; };
  }, [customerId, partId, receivedDate, viewAllowed]);

  async function pick(quoteLineId: string | null) {
    setSaving(true);
    try {
      await applyMutation(() => api<OrderMutationResult>(
        `/api/orders/${orderId}/lines/${line.id}`,
        { method: "PATCH", body: JSON.stringify({ quoteLineId }) },
      ));
      onError(null);
      onClose();
    } catch (e) {
      // §5.13: the refusal (judgeQuoteLine's named reason) is shown; the control stays open with
      // everything as it was so the user can pick differently or close.
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!viewAllowed) {
    return (
      <span className="ml-2 text-xs text-ink-500">
        Re-pick requires orders.view.{" "}
        <button onClick={onClose} className={LINK}>close</button>
      </span>
    );
  }
  if (fetchError) {
    return (
      <span className="ml-2 text-xs text-accent-600">
        Could not check quotes: {fetchError}{" "}
        <button onClick={onClose} className={LINK}>close</button>
      </span>
    );
  }
  if (!payload) return <span className="ml-2 text-xs text-ink-500">Checking quotes…</span>;

  const options = payload.candidates.filter((c) => c.quoteLineId !== line.quoteLineId);
  const nothingToChange = options.length === 0 && line.quoteLineId === null;

  return (
    <span className="ml-2 inline-flex items-center gap-1.5 text-xs">
      {nothingToChange ? (
        <span className="text-ink-500">No eligible quotes as of the received date.</span>
      ) : (
        <select value="" disabled={saving} aria-label={`${lineLabel(line)} quote re-pick`}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") return; // the "keep" placeholder — never a request
                  void pick(v === "none" ? null : v);
                }}
                className={INPUT_COMPACT}>
          <option value="">
            {line.quoteNumber !== null ? `— keep Quote #${line.quoteNumber} —` : "— keep: no quote —"}
          </option>
          {options.map((c) => (
            <option key={c.quoteLineId} value={c.quoteLineId}>
              Quote #{c.quoteNumber} (effective {formatDate(c.effectiveDate)} to {formatDate(c.expiryDate)})
            </option>
          ))}
          {line.quoteLineId !== null && <option value="none">No quote</option>}
        </select>
      )}
      <button onClick={onClose} disabled={saving} className={LINK}>close</button>
    </span>
  );
}

/**
 * The lead (position 1, badged "Lead · Rev N locked" — part and revision immutable) plus every
 * rider (qty/weight editable, remove-with-confirm) and the add-rider form. Task 5's
 * `updateLine`/`addLine`/`removeLine` (spec §5a): customer and the lead part/revision can never
 * be changed here — a wrong-part order is voided and re-keyed, never edited down to its lead.
 *
 * Qty and Weight save per field, on blur or on Enter (owner ruling R7: every single-line blur-save
 * box commits on Enter; these two keep their own leaf rather than the edit guard's Enter), NOT
 * through the bulk-grid overlay (src/lib/bulk-grid.ts): there is no array-shaped
 * bulk PUT here, just one PATCH per field, each a thunk handed to `applyMutation`, and
 * `order.lines` is never patched optimistically. What the section keeps is one entry per box that
 * holds something the server does not show (`saves`, below). src/lib/line-field-saves.ts decides
 * what each box shows, whether it reads Saved or Not saved, and whether a blur, an Enter or a
 * Restore sends anything; this component holds the state, sends the request, says whether the
 * server answered it, and writes the section's message. A value that was not saved stays in its box
 * marked Not saved, with the reason in the row beneath and a Restore control, and it counts as
 * unsaved work under the label "Lines" (owner ruling 2026-10-07).
 *
 * Restore puts the stored value back, and where no save of the box went unanswered that is local:
 * nothing is sent. After a save the server did not answer (the connection dropped, or a 5xx; which
 * failures count was decided without the owner, HANDOFF §4 R13) that save may have been committed,
 * so the stored value on the page may not be what the server holds, and Restore SAVES it instead
 * (owner ruling 2026-10-07): one PATCH of that value, and the box stays Not saved until it lands.
 * A save answered 2xx whose body could not be read (`UnreadableAnswerError`) is counted with them,
 * by the owner's ruling of 2026-10-18 (#547): its write was committed, and Restore saves the
 * stored value after it too.
 * The stored value typed back over such a box is sent for the same reason. The box records that
 * a save of it went unanswered whichever of its saves that was: two can be out at once, and the
 * older one's lost answer is recorded although the box no longer waits on it. Short of its line
 * leaving the order, one thing ends that record: a later save of the box landing. A refusal the
 * server answers to a later request does not, nor does a refusal the page makes, a key typed, or
 * an order payload, whatever value it shows, because a payload can be older than the write that
 * was lost. So after such a save the box reads Not saved until Enter (which sends the box's
 * text) or Restore (which sends the stored value) lands, even when the page comes to show the
 * very value in the box (HANDOFF §4: R17 decided without the owner; R18 the owner's ruling of
 * 2026-10-15, #478). The known cost: on an order that refuses every line save (voided, under a
 * finalized invoice, or with orders.edit gone) such a box stays Not saved, and each Restore is
 * sent and refused, until the page is reloaded. Leaving still asks first and can be confirmed.
 *
 * After a quantity save lands, the row beneath that line offers quantity × the part's each weight
 * when it differs from the stored weight (`offerLines`, below; src/lib/net-weight.ts decides the
 * figure). It is never applied silently: a stored weight may be a deliberate received weight.
 * Accepting it is the weight box's own save, through `acceptOffer` and `commit`. Every Qty and
 * Weight request, a Restore's included, is made in one place, `checkAndSend`.
 *
 * A Remove that got no answer the page can trust, by the same rule (R13, `unansweredStatus`, with
 * the 2026-10-18 ruling's unreadable 2xx), may have been committed (after an unreadable 2xx it
 * was), so the line stays on the page marked Removal not confirmed, with the reason in its
 * detail row, and counts as unsaved work under "Lines" (#475, owner ruling 2026-10-15;
 * src/lib/line-removals.ts decides every change to the record, `removals`). Only a payload that
 * no longer lists the line ends the mark. A payload that lists it ends nothing (R18), nor does a
 * refusal the server answers to a retry, and a reload starts without it. Remove stays live and is
 * the retry: the same handler, confirm, serials refusal and edit gate. Any Remove answered 404
 * "Order line not found", a first as well as a retry, proves the line gone (the leaf's header
 * says why): the section asks the page once to read the order (`readAfterRemoval`, which tells
 * History and Shipments too; the page's `load` reads once more when a hub write was out as its
 * read was sent, #550) and says the line had already been removed, or, when that first read
 * fails, that the page could not be refreshed. "Order not found" and every 400 or 409 prove
 * nothing. A marked line's Qty and Net weight boxes stay as editable as any other line's.
 */
export function LinesSection({
  orderId, lines, shippedWeightByLineId, customerParts, editGate, partsGate, customerId, receivedDate,
  ordersViewAllowed, applyMutation, readAfterRemoval,
}: {
  orderId: string;
  lines: OrderLine[];
  /** The weight already shipped against each line, by line id (the order's `orderLineShippedToDate`).
   *  The server refuses a line weight below it, so an offered weight below it is shown blocked. */
  shippedWeightByLineId: ReadonlyMap<string, number>;
  /** The order's customer's full catalog (active AND inactive) — src/app/orders/[id]/page.tsx's
   *  own comment on why it fetches both. */
  customerParts: PartOption[];
  editGate: Gate;
  partsGate: Gate;
  /** For the quote-link surfaces (Task 9): the re-pick reads eligibility against the order's
   *  CURRENT received date (§5.2's re-pick rule) and the add-rider preview against the same —
   *  addLine judges against the ORDER's stored received date, however backdated (ruling 6). */
  customerId: string;
  receivedDate: string;
  ordersViewAllowed: boolean;
  applyMutation: ApplyMutation;
  /** The page's read of the order after a Remove answered that the order does not hold the line
   *  (#475): it tells History and Shipments the server state changed, then reads the order. It
   *  rejects when the read fails. */
  readAfterRemoval: () => Promise<void>;
}) {
  // One entry per Qty or Weight box that holds something the server does not show: text being
  // typed, a save in flight, or how the last save ended. Keyed by line AND field, so a quantity
  // save landing never touches text being typed into the same row's weight. A box with no entry
  // shows the stored value (`stored` below), so a fresh `lines` prop from another section's
  // mutation is never masked by a stale local copy.
  const [saves, setSaves] = useState<FieldSaves>(NO_FIELD_SAVES);
  // The lines whose quantity save landed in this visit and whose weight has not been saved since.
  // Only these may show an offered weight. It is momentary by design: it starts empty, so a reload
  // offers nothing, and a line whose weight differs from quantity × each weight for any other reason
  // (a received weight, a part whose each weight was corrected) is never offered to on sight.
  const [offerLines, setOfferLines] = useState<ReadonlySet<string>>(new Set());
  // The lines whose Remove got no answer the page can trust (#475, owner ruling 2026-10-15): the
  // DELETE may have been committed, so such a line may already be gone from the server while the
  // page still lists it. src/lib/line-removals.ts decides every change to it. It is page state and
  // nothing else, so a reload starts without it.
  const [removals, setRemovals] = useState<UnconfirmedRemovals>(NO_UNCONFIRMED_REMOVALS);
  /** The text the focused box held when focus arrived, or when Enter last saved it in place, or
   *  what a control that leaves focus in the box has put in it since: the stored value, by a
   *  Restore of that box, or an offered weight accepted into it. */
  const focusedValue = useRef("");
  /** Which Qty or Weight box has focus, by key; null when none has. Set on focus and cleared on
   *  that box's blur. `restore` and `acceptOffer` read it: only a Restore of the focused box, or
   *  an offer accepted into it, moves `focusedValue`. */
  const focusedKey = useRef<string | null>(null);
  // One counter for the whole section: bumped per request and per client-side refusal, never reset,
  // so a number cannot repeat for a box whose entry was dropped and started again. `newest` is the
  // latest of those per box, and only that one may write the section's message, which every box,
  // Remove, Add rider and the quote re-pick share.
  const attempts = useRef(0);
  const newest = useRef(new Map<string, number>());
  // Which Qty or Weight box last wrote a failure to the section's message, and the words it wrote;
  // null when none has since a save of one of them landed or a box took its own words off. (It and
  // `clearOwnBanner` keep the names they had while that slot was the page banner, before P6 step
  // 5a.) The message
  // does not say who wrote it, so this is how a box knows whether the message there can be its
  // own (`clearOwnBanner`, which is also where a box gives the record up). Otherwise it is
  // written only in `checkAndSend`, beside each message write made there: set with a failure,
  // given up at a landing. Nothing else that writes the message touches it: not Remove, Add rider
  // or the quote re-pick.
  const bannerOwner = useRef<{ key: string; message: string } | null>(null);
  // Which line's quote re-pick is open (one at a time — the control fetches on open, so leaving
  // every line's list mounted would mean N idle fetches for a control few saves ever touch).
  const [repickLineId, setRepickLineId] = useState<string | null>(null);
  // The section's own message (owner ruling R1, P6 step 5a), drawn through the shared PanelMessage
  // between the lines and the Add rider strip: the Qty and Weight boxes' failures, Remove, Add
  // rider and the quote re-pick all report here, where they used to write the page banner. The
  // setter keeps the name `onError` the handlers and the tests that lift them read, and takes the
  // same writes the banner's setter did: a message, null, or a function of the message shown now.
  // It is not cleared at rest: Lines has no bulk grid, and a Not saved box keeps
  // its own mark and the "Lines" registration whatever this slot says. It is declared after
  // `repickLineId`: tests/lines-section-repick-gate.test.tsx seeds the first null `useState`.
  const [linesMessage, onError] = useState<string | null>(null);

  // The stored value of every box, as text. Built once per render and read by the views, by
  // `commit` and by the registration below, so the three cannot disagree about what is stored.
  // A Restore that saves sends the same value: `String(line[field])`, which is how this is built.
  const server = serverValues(lines);
  function stored(key: string): string {
    return server.get(key) ?? "";
  }

  // A new `lines` payload, from this section's saves or anyone else's. The leaf drops what the
  // payload settles: the draft of a Saved box the server now shows, a Not saved box whose text is
  // what the order now holds (compared as text, so a box being retyped is never swapped under the
  // cursor), every entry of a line that is gone. It settles nothing for a box that records a save
  // the server did not answer: the payload may be older than that write. That intersection is the
  // only pruning there is, so `removeLine` needs no call of its own. It returns the same Map when
  // nothing changes. The offered lines are intersected the same way: a line that is gone is
  // offered nothing. So are the unconfirmed removals, and this is the one thing that ends one: a
  // payload that no longer lists the line, whichever save or read brought it (another section's
  // save, or a Re-split confirmed through its ask, as well as a Remove's own answer or the read
  // after one). A payload that still lists the line ends nothing (R18, the owner's ruling): it may
  // have been read or answered before the lost DELETE was committed.
  useEffect(() => {
    setSaves((cur) => reconciled(cur, serverValues(lines)));
    setOfferLines((cur) => retained(cur, lines.map((l) => l.id)));
    setRemovals((cur) => removalsListed(cur, lines.map((l) => l.id)));
  }, [lines]);

  // A Not saved value is unsaved work: the box shows something the server does not hold, or is not
  // known to hold. Leaving the page asks first and the traveler print waits, until the value is
  // restored, saved, or shown by the order (the last only where no save of the box went
  // unanswered). Text still being typed, a save in flight and a Saved mark do not count. A box
  // that records a save the server did not answer counts for as long as that record stands, which
  // is until a later save of it lands or its line leaves the order: through a Restore that has to
  // save, through a refusal of that save, through every order payload, and through the moments
  // the box shows no mark while a save of it is out (a key typed then, or an older save lost
  // while a newer one is still out). A line whose Remove got no answer counts too, for as long as
  // the order on the page lists it (#475): the page may be showing a line the server no longer
  // holds. Leaving asks first and the traveler print waits until a payload no longer lists the
  // line, as for a Not saved value.
  useUnsavedSection(anyNotSaved(saves, server) || anyRemovalUnconfirmed(removals, lines), "Lines");

  function noteFocus(key: string, e: React.FocusEvent<HTMLInputElement>) {
    focusedKey.current = key;
    focusedValue.current = e.target.value;
  }

  function onTyped(key: string, text: string) {
    setSaves((cur) => typed(cur, key, text));
  }

  // A blur (`atFocus` is the text the box held at focus), or an Enter or an accepted offer
  // (`atFocus` is null). The intent is read from THIS render's `saves`: each blur, each Enter and
  // each click is its own browser event, and React has rendered the previous event's update before
  // the next handler runs. A response is not an event: its update can be a render behind for an
  // instant, and the intent is then read without it. Mostly that means the request is still seen
  // as in flight, which costs one request at most (one sent that was not needed, or a retry to
  // press again). An older save's lost answer can also set the box's record in that instant
  // (`failed` in the leaf), and the intent then says settle, or `restore`'s says clear, where it
  // would have said send: the leaf's `settled` and `cleared` never drop an entry that carries the
  // record, so that costs one more Enter or Restore. In that instant the box's message can also
  // come off the section's message while the row under the line still shows it (`clearOwnBanner` runs on
  // the intent that was read). Neither costs a value, because every write
  // here and in `checkAndSend` is a functional update: nothing is built from this closure, so
  // nothing a response queued can be overwritten.
  async function commit(line: OrderLine, field: LineField, text: string, atFocus: string | null) {
    const key = fieldKey(line.id, field);
    const intent = saveIntent({ save: saves.get(key), server: stored(key), text, atFocus });
    if (intent === "skip") return;
    if (intent === "settle") {
      // Only a box that read Not saved takes anything off the section's message, and then only its own
      // message (`clearOwnBanner`). A clean box typed into and typed back has said nothing.
      const wasNotSaved = saves.get(key)?.outcome?.kind === "failed";
      setSaves((cur) => settled(cur, key));
      if (wasNotSaved) clearOwnBanner(key);
      return;
    }
    await checkAndSend(line, field, text);
  }

  // The box at `key` has stopped reading Not saved with no request: the stored value was typed
  // back and left (`commit`), or Restore cleared it (`restore`). Its message comes off the
  // section's message only when the words there are its own. The slot is one for the whole
  // section: Remove, Add rider and the quote re-pick write it, and so do both boxes of every line.
  // So two things must hold. This box is the one that last wrote a failure there from a Qty or Weight box
  // (`bannerOwner`): after the quantity is refused and then the weight, putting the quantity back
  // leaves the weight's message where it is. And the slot still shows the words this box wrote:
  // whatever was written there since, by Remove, Add rider or the quote re-pick, stays. That
  // second question is asked of the slot's own value, through its state setter, and the function handed to it reads nothing but the words captured here. Two
  // boxes refused in the same words are told apart by the first test. The same words written
  // from elsewhere cannot be told from this box's own, and go.
  function clearOwnBanner(key: string) {
    const owner = bannerOwner.current;
    if (owner === null || owner.key !== key) return;
    bannerOwner.current = null;
    onError((cur) => (cur === owner.message ? null : cur));
  }

  // The one place a Qty or Weight request is made, for `commit` and for a Restore that has to save
  // (`restore`, below). It asks the leaf nothing about whether to send: its caller has decided.
  // It refuses `text` on the client, or sends it as one PATCH and as the next attempt of its box,
  // and records how that attempt ended.
  async function checkAndSend(line: OrderLine, field: LineField, text: string) {
    const key = fieldKey(line.id, field);
    const refusal = checkLineField(field, text, lineLabel(line));
    if (refusal !== null) {
      // No request, but it is the newest thing said about this box: a save still in flight for an
      // older value must not clear or replace this message in the message when it ends.
      newest.current.set(key, ++attempts.current);
      setSaves((cur) => refused(cur, key, text, refusal));
      bannerOwner.current = { key, message: refusal };
      onError(refusal);
      return;
    }
    const trimmed = text.trim();
    const body = field === "qty" ? { qty: Number(trimmed) } : { weight: trimmed };
    // Exactly what the request carries, as text. It becomes the text in the box, so the box never
    // shows a spelling the server was not sent ("040" is sent, and shown, as 40).
    const sent = field === "qty" ? String(Number(trimmed)) : trimmed;
    const attempt = ++attempts.current;
    newest.current.set(key, attempt);
    setSaves((cur) => dispatched(cur, key, sent, attempt));
    try {
      await applyMutation(() => api<OrderMutationResult>(
        `/api/orders/${orderId}/lines/${line.id}`, { method: "PATCH", body: JSON.stringify(body) },
      ));
      setSaves((cur) => landed(cur, key, attempt));
      // Whether or not this attempt is still the newest for its box: the request landed, so the
      // stored quantity or weight did change.
      setOfferLines((cur) => offerLinesAfter(cur, line.id, field));
      // A save that lands clears the section's message whatever it says, as one that lands in
      // Containers, Serials, Charges or Loads clears theirs. No box's words are there after that,
      // so no box owns it.
      if (newest.current.get(key) === attempt) {
        bannerOwner.current = null;
        onError(null);
      }
    } catch (e) {
      // The box keeps its text, marked Not saved. Nothing is rolled back and nothing is
      // re-read: `order` was never changed, and the page's reads lock the bulk grids and the load
      // prints when they fail, which a dropped connection would then do on top of this.
      const message = (e as Error).message;
      // Whether the server answered (R13, `unansweredStatus`). An ApiError below 500 is its
      // refusal: nothing was written for THIS request. Anything else is no answer the page can
      // trust: an error that is not an ApiError, so there is no status, or a 5xx. An error that
      // is not an ApiError is fetch's rejection (no response arrived) or, since #547, a 2xx whose
      // body `api()` could not read (`UnreadableAnswerError`). After no response or a 5xx the
      // write may have been committed; after an unreadable 2xx it was, and the owner's ruling of
      // 2026-10-18 counts it with them. So the leaf records on the box that a save of it went
      // unanswered, and from then on Restore saves the stored value instead of clearing. An
      // answered refusal never takes that record away: it says nothing about an earlier request
      // that was lost.
      const status = e instanceof ApiError ? e.status : null;
      const unanswered = unansweredStatus(status);
      // The leaf is told of every failure, whichever attempt of the box this is. For the attempt
      // the box waits on, it writes the outcome. For one a newer attempt has replaced, a refusal
      // the server answered changes nothing, and a failure it did not answer still sets the
      // box's record (two saves of one box can be out at once, and the older may be the one the
      // server holds), with a Not saved mark where no save of the box is left out to bring one.
      setSaves((cur) => failed(cur, key, attempt, message, unanswered));
      // The message is the newest attempt's to write, and that does not change: a replaced
      // attempt writes nothing there, answered or not. Where the leaf marked the box for it, the
      // reason is in the row under the line.
      if (newest.current.get(key) === attempt) {
        bannerOwner.current = { key, message };
        onError(message);
      }
    }
  }

  function onBlurField(e: React.FocusEvent<HTMLInputElement>, line: OrderLine, field: LineField) {
    // Focus has left this box. `focusedValue` is left as it is: the next focus rewrites it.
    if (focusedKey.current === fieldKey(line.id, field)) focusedKey.current = null;
    void commit(line, field, e.target.value, focusedValue.current);
  }

  function onEnterField(e: React.KeyboardEvent<HTMLInputElement>, line: OrderLine, field: LineField) {
    if (e.key !== "Enter") return;
    const text = e.currentTarget.value;
    // Enter saves in place and focus stays, so this is now the text the box held "at focus". The
    // blur that follows is judged against it by value: on a box that reads Saved or Not saved it
    // sends nothing more unless the value changed, and the same value spelled another way ("020"
    // for the 20 the save left in the box) is no change. That comparison reads complete decimals
    // only, so a quantity typed as "20." and then refused is sent once more by that blur.
    focusedValue.current = text;
    void commit(line, field, text, null);
  }

  // The Restore control of the box at `key`. The leaf says which of two things it does, from THIS
  // render's `saves` (a click is its own event, as in `commit`).
  //
  // "clear", where no save of the box went unanswered: local only, no request (the grids'
  // Discard). The box goes back to the stored value, and its words come off the section's message
  // if the slot still shows them (`clearOwnBanner`): words a later box or anything else wrote stay.
  //
  // "send", while the box records a save the server did not answer: the stored value is saved, as
  // an attempt of this box like any other. Nothing is cleared here. The box shows the stored
  // value, still Not saved, while the request is out (which is also what disables the control),
  // and the message stays. The answer writes the box, and the message too while this is
  // still the box's newest attempt, as for every attempt. A refusal of that save leaves the record
  // standing, so the next Restore sends again.
  //
  // Either way the box now holds the stored value. The pointer's Restore leaves focus in the box
  // (FieldMark prevents the pointer-down), so no focus event says the text changed. The stored
  // value is therefore recorded here as the box's text at focus, when the box Restore acts on is
  // the one that has focus: the blur that follows then leaves the box holding what it held "at
  // focus" and sends nothing, whether Restore's save landed, was refused or got no answer.
  // Without it, after a restore-save that was refused or got no answer, that blur would find the
  // box changed since focus and send the stored value again, which nobody asked for. The ref is
  // shared by every box, hence the key: Restore on one box, clicked with focus in another, must
  // not rewrite the other's text at focus.
  function restore(key: string) {
    if (focusedKey.current === key) focusedValue.current = stored(key);
    if (restoreIntent(saves.get(key)) === "clear") {
      setSaves((cur) => cleared(cur, key));
      clearOwnBanner(key);
      return;
    }
    // The box's line and field, found from its key among the lines the rows are rendered from.
    for (const line of lines) {
      for (const field of ["qty", "weight"] as const) {
        if (fieldKey(line.id, field) === key) void checkAndSend(line, field, String(line[field]));
      }
    }
  }

  // The Use control of a line's offered weight. Accepting is the Weight box's own save: the
  // figure goes to `commit` as plain text with no text at focus, as Enter's text does.
  //
  // The box then holds the figure, and no focus event says so: the pointer's Use leaves focus
  // where it was (WeightOfferNote prevents the pointer-down). Where that is this line's Weight
  // box, the figure is recorded as the box's text at focus before it is sent, as `restore`
  // records the stored value. The blur that follows then leaves the box holding what it held
  // "at focus" and sends nothing, whether the save landed, was refused or got no answer.
  // Without it, after a figure that was refused or got no answer, that blur would find the box
  // changed since focus and send the figure again, and a Not saved value is not sent again by
  // leaving its box: Enter, or Use once more, is the retry. The ref is shared by every box,
  // hence the key: Use clicked with focus in any other box leaves that box's text at focus alone.
  function acceptOffer(line: OrderLine, pounds: number) {
    const text = String(pounds);
    if (focusedKey.current === fieldKey(line.id, "weight")) focusedValue.current = text;
    void commit(line, "weight", text, null);
  }

  async function removeLine(line: OrderLine) {
    // #293. This DELETE hard-deletes every OrderSerial of the line (`removeLine`, order-edit.ts),
    // which is exactly the rows this line's serials editor is holding — so it REPLACES server rows
    // an editor owns and CLAUDE.md's rule applies: refuse while they are dirty, before the request.
    // The old prompt named only the line and consulted the registry not at all, so typed serials
    // were destroyed silently.
    //
    // SCOPED, not page-wide, and that is the point of the scope existing. Only `OrderSerial` carries
    // a `lineId`; Containers, Charges and Loads cannot be touched by this write, and a bare
    // `useUnsavedPresent()` would refuse over all three — a refusal nobody can explain is the one
    // people learn to work around. Read live here rather than through the hook because the answer
    // wanted is the one at CLICK time, and the line is chosen by the click.
    //
    // #309 supplies the local route out: Save or Discard on this line's serial editor, including
    // its typed-but-unadded range. No page reload is needed and unrelated grid drafts survive.
    //
    // #475. This is also the retry of a Remove the server did not answer. A marked line takes this
    // refusal, the confirm and the edit gate as any other does, and nothing else in this section
    // sends a DELETE of a line. How each answer is read is at the catch below.
    const lineSerialsUnsaved = unsavedPresentInScope(serialsScope(line.id))
      || (getBrowserDraftSession()?.store.hasScope(`/orders/${orderId}`, serialsScope(line.id)) ?? false);
    if (lineSerialsUnsaved) {
      onError(`${lineLabel(line)} has unsaved serials. Removing the line deletes them, so save them ` +
        `first — or use Discard beside this line's Save serials button.`);
      return;
    }
    // The line as the confirm names it, and as the messages below name it.
    const naming = `${line.part.customer.code} · ${line.part.partNumber} (${lineLabel(line)})`;
    if (!await askConfirm({ title: `Remove ${naming} from this order?`, body: "", confirm: "Remove line", danger: true })) return;
    try {
      await applyMutation(() =>
        api<OrderMutationResult>(`/api/orders/${orderId}/lines/${line.id}`, { method: "DELETE" }));
      onError(null);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : null;
      const message = (e as Error).message;
      if (removalProvesGone(status, message)) {
        // The order no longer holds the line, so the section asks the page once to read it,
        // through the page's callback (which also tells History and Shipments, and whose `load`
        // reads once more when a hub write was out as its read was sent, #550), and says so when
        // that first read ends: the server's own sentence would read as a failure. The read's
        // payload, not this answer, ends a mark the line carries. A failed read leaves the mark: no
        // payload landed.
        try {
          await readAfterRemoval();
          onError(alreadyRemovedMessage(naming));
        } catch (readError) {
          onError(removedNotRefreshedMessage(naming, (readError as Error).message));
        }
        return;
      }
      // No answer the page can trust (R13, and since #547 a 2xx whose body could not be read,
      // which committed: line-removals.ts says why it is marked all the same): the DELETE may have
      // been committed, so the line is marked until a payload no longer lists it. An answered
      // refusal marks nothing and ends no mark: it says nothing about an earlier Remove that was
      // lost.
      if (unansweredStatus(status)) setRemovals((cur) => removalUnanswered(cur, line.id));
      onError(message);
    }
  }

  // ---- add rider ----
  const [addPartId, setAddPartId] = useState<string | null>(null);
  const [addQty, setAddQty] = useState("");
  const [addWeightOverride, setAddWeightOverride] = useState<string | null>(null);
  // The rider's three-way quote pick, exactly the entry form's LineDraft.quoteLineIdOverride:
  // undefined = untouched — the POST body OMITS `quoteLineId` and addLine auto-resolves; a
  // string/null is the explicit pick/unlink. The previewed auto-link's id is never copied in
  // (QuoteLinkPicker's contract), so an untouched control sends ABSENT by construction.
  const [addQuotePick, setAddQuotePick] = useState<QuoteLinkPick>(undefined);
  const [adding, setAdding] = useState(false);

  // Inactive parts cannot be added (resolveLineParts refuses them server-side) — riders are
  // otherwise unrestricted regardless of hasProcessSteps (spec §11: only the lead locks a
  // revision), so unlike the entry page's lead picker, no option here is ever disabled.
  const addOptions: ComboboxOption[] = partOptions(customerParts.filter((p) => p.active), { separator: " — " });
  const addPart = customerParts.find((p) => p.id === addPartId);
  const computedAddWeight = computeLineWeight(addPart, Number(addQty));
  const displayedAddWeight = addWeightOverride ?? (computedAddWeight !== null ? String(computedAddWeight) : "");

  // tests/lines-section-wiring.test.ts lifts `addRider` out of this file's source and runs it,
  // because vitest has no DOM to click Add rider in. It stays a function declaration of its name.
  // If it comes to read a new name from this component, that name joins the test's `strip()` in
  // the same change.
  async function addRider() {
    if (adding) return;
    if (!addPartId) { onError("Pick a part to add as a rider."); return; }
    const qty = Number(addQty);
    const weight = addWeightOverride !== null ? addWeightOverride.trim() : String(computedAddWeight ?? 0);
    // Both boxes are checked and every refusal listed, the quantity's first, one to a line.
    const refusals: string[] = [];
    if (!Number.isInteger(qty) || qty < 1) refusals.push("New line: enter a quantity of at least 1.");
    const weightRefusal = decimalRefusal(`New line, ${LINE_NET_WEIGHT.label}`, weight, LINE_NET_WEIGHT.box, { required: true });
    if (weightRefusal !== null) refusals.push(weightRefusal);
    if (refusals.length > 0) { onError(refusals.join("\n")); return; }
    setAdding(true);
    try {
      await applyMutation(() => api<OrderMutationResult>(`/api/orders/${orderId}/lines`, {
        method: "POST", body: JSON.stringify({
          partId: addPartId, qty, weight,
          // Three-way (spec §5.2): present only for an explicit pick/unlink; ABSENT while
          // untouched, so addLine's own auto-resolution stays authoritative.
          ...(addQuotePick !== undefined ? { quoteLineId: addQuotePick } : {}),
        }),
      }));
      onError(null);
      setAddPartId(null);
      setAddQty("");
      setAddWeightOverride(null);
      setAddQuotePick(undefined);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  const addTitle = !partsGate.allowed ? partsGate.title : editGate.title;

  return (
    <section id="lines" data-order-section tabIndex={-1} className={`${CARD} mb-6`}>
      <h2 className="mb-2 font-medium">Lines</h2>
      <table className="mb-3 w-full text-sm">
        <thead>
          <tr className="text-left">
            <th className="py-1">&nbsp;</th><th>Part</th><th>Qty</th><th>{NET_WEIGHT_LB}</th><th>Quote</th><th />
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const qtyKey = fieldKey(line.id, "qty");
            const weightKey = fieldKey(line.id, "weight");
            const qty = fieldView(saves.get(qtyKey), stored(qtyKey));
            const weight = fieldView(saves.get(weightKey), stored(weightKey));
            const qtyMessage = fieldMessage(line, "qty", qty);
            const weightMessage = fieldMessage(line, "weight", weight);
            const qtyMessageId = `line-${line.id}-qty-message`;
            const weightMessageId = `line-${line.id}-weight-message`;
            // Why the line is marked, while its Remove got no answer the page can trust; else null.
            const removalMessage = removalNotice(removals, line.id, lineLabel(line));
            const removalMessageId = `line-${line.id}-removal-message`;
            // Derived at every render from what the order holds now, and only for a line marked in
            // `offerLines`. Null when the stored weight already is quantity × each weight.
            const offer = offerLines.has(line.id)
              ? lineWeightOffer({
                  quantity: line.qty, eachWeight: line.part.eachWeight, storedWeight: line.weight,
                  shippedWeight: shippedWeightByLineId.get(line.id),
                })
              : null;
            // The offer's control waits while either of this line's boxes has a save out. A quantity
            // save that lands changes the stored quantity the figure was calculated from, and a
            // weight save is the very request the control would send.
            const offerWaits = qty.saving || weight.saving;
            // Why the offer's control is disabled, when it is: the edit gate's own reason first.
            const offerTitle = editGate.title ?? (offerWaits ? "Wait for this save to finish before using this weight" : undefined);
            // The Fragment is unconditional. A row that became a Fragment only when it had a
            // detail row would change element type at a stable key: React would remount the row
            // and the box being typed into would lose focus mid-keystroke.
            return (
              <Fragment key={line.id}>
                <tr className="border-t">
                  <td className="py-1">
                    {line.position === 1 ? (
                      <span className="rounded bg-ink-900 px-1.5 py-0.5 text-xs text-white">
                        Lead · Rev {line.revisionNumber ?? "?"} locked
                      </span>
                    ) : (
                      <span className="text-xs text-ink-500">Line {line.position}</span>
                    )}
                  </td>
                  <td className="font-mono">{line.part.customer.code} · {line.part.partNumber} <span className="font-sans text-ink-500">— {line.part.name}</span></td>
                  <td>
                    <input value={qty.text} inputMode="numeric" onFocus={(e) => noteFocus(qtyKey, e)}
                           disabled={editGate.disabled} title={editGate.title}
                           onChange={(e) => onTyped(qtyKey, e.target.value)}
                           onBlur={(e) => onBlurField(e, line, "qty")}
                           onKeyDown={(e) => onEnterField(e, line, "qty")}
                           aria-label={`${lineLabel(line)} quantity`}
                           aria-invalid={qty.mark === "not-saved" ? true : undefined}
                           aria-describedby={qtyMessage !== null ? qtyMessageId : undefined}
                           className={`${INPUT_COMPACT} w-20 disabled:bg-surface-50 aria-invalid:border-red-600`} />
                    <FieldMark fieldLabel={`${lineLabel(line)} quantity`} view={qty} server={stored(qtyKey)}
                               onRestore={() => restore(qtyKey)} />
                  </td>
                  <td>
                    <input value={weight.text} inputMode="decimal" onFocus={(e) => noteFocus(weightKey, e)}
                           disabled={editGate.disabled} title={editGate.title}
                           onChange={(e) => onTyped(weightKey, e.target.value)}
                           onBlur={(e) => onBlurField(e, line, "weight")}
                           onKeyDown={(e) => onEnterField(e, line, "weight")}
                           aria-label={`${lineLabel(line)} weight`}
                           aria-invalid={weight.mark === "not-saved" ? true : undefined}
                           aria-describedby={weightMessage !== null ? weightMessageId : undefined}
                           className={`${INPUT_COMPACT} w-24 disabled:bg-surface-50 aria-invalid:border-red-600`} />
                    <FieldMark fieldLabel={`${lineLabel(line)} weight`} view={weight} server={stored(weightKey)}
                               onRestore={() => restore(weightKey)} />
                  </td>
                  <td>
                    {/* Spec §5.2 Display: the STORED link (judged at link time, ruling 6 — never
                        re-derived; a received-date edit refreshes nothing here). The re-pick, when
                        opened, fetches eligibility against the CURRENT received date and PATCHes
                        only on an explicit selection — an untouched (or closed) re-pick sends no
                        request at all, which IS updateLine's absent-key "keep" semantics. */}
                    {line.quoteId !== null && line.quoteNumber !== null ? (
                      <Link href={`/quotes/${line.quoteId}`} className={LINK}>
                        Quote #{line.quoteNumber}
                      </Link>
                    ) : (
                      <span className="text-ink-500">—</span>
                    )}
                    {/* The re-pick is mounted only while the edit gate is open. It takes no gate of
                        its own, so a gate that closes while it is open (the order voided, or an
                        invoice finalized elsewhere and since read by this page) puts the greyed,
                        titled "change" button back. A pick still out at that moment reports as before:
                        its answer is applied, or its refusal goes to the section's message. Which line
                        was opened is kept, so the re-pick shows again if the gate reopens. */}
                    {repickLineId === line.id && !editGate.disabled ? (
                      <LineQuoteRepick orderId={orderId} line={line} customerId={customerId}
                                       receivedDate={receivedDate} viewAllowed={ordersViewAllowed}
                                       applyMutation={applyMutation} onError={onError}
                                       onClose={() => setRepickLineId(null)} />
                    ) : (
                      <button onClick={() => setRepickLineId(line.id)}
                              disabled={editGate.disabled} title={editGate.title}
                              className={`${LINK} ml-2 text-xs`}>
                        change
                      </button>
                    )}
                  </td>
                  <td className="text-right">
                    {/* Remove is also the retry of a Remove the server did not answer: the same
                        handler, the same confirm and serials refusal, and the edit gate alone
                        closes it. The mark beside it closes nothing. */}
                    {line.position !== 1 && (
                      <button onClick={() => void removeLine(line)} disabled={editGate.disabled} title={editGate.title}
                              aria-describedby={removalMessage !== null ? removalMessageId : undefined}
                              className="text-xs text-red-600">
                        Remove
                      </button>
                    )}
                    {removalMessage !== null && (
                      <span role="alert" aria-label={`${lineLabel(line)} removal not confirmed`}
                            className="ml-2 text-xs font-medium text-red-700">{REMOVAL_NOT_CONFIRMED}</span>
                    )}
                  </td>
                </tr>
                {(removalMessage !== null || qtyMessage !== null || weightMessage !== null || offer !== null) && (
                  <tr>
                    <td />
                    <td colSpan={5} className="pb-2 text-xs">
                      {removalMessage !== null && <p id={removalMessageId} className="text-red-700">{removalMessage}</p>}
                      {qtyMessage !== null && <p id={qtyMessageId} className="text-red-700">{qtyMessage}</p>}
                      {weightMessage !== null && <p id={weightMessageId} className="text-red-700">{weightMessage}</p>}
                      {offer !== null && (
                        <p>
                          {/* Accepting is the weight box's own save (`acceptOffer`): the figure
                              goes to `commit` as text typed in that box and Enter does. While a
                              save of either of this line's boxes is out the control waits: one
                              click is one request, and a figure is not accepted while a quantity
                              save that would change it is still out. */}
                          <WeightOfferNote offer={offer} disabled={editGate.disabled || offerWaits} title={offerTitle}
                                           onUse={() => acceptOffer(line, offer.pounds)} />
                        </p>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <PanelMessage message={linesMessage} />

      {/* L2b (#239): `gap-2` between labelled controls whose labels sit directly above them read as
          one crowded strip, and the two numeric boxes held LESS text than the same two fields in the
          table above — identical `w-20`/`w-24` widths but `px-2` rather than `px-1`, so 8px more of
          each box went to padding. A wider column gap separates the labelled groups, a smaller row
          gap keeps a wrapped row tight, and one width step on each input (5rem → 6rem, 6rem →
          7rem) more than covers the 8px the padding takes. */}
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3 border-t pt-3 text-sm">
        <label className="block">
          Add rider — part
          {/* A part swap resets the quote pick to auto (spec §5.2) — a pick made for the old
              part must never ride onto the new one (the entry card's own rule). */}
          <Combobox value={addPartId} options={addOptions}
                     onSelect={(id) => { setAddPartId(id); setAddQuotePick(undefined); }}
                     disabled={editGate.disabled || !partsGate.allowed} title={addTitle}
                     placeholder="Part number or name" ariaLabel="Add rider part" />
        </label>
        <label className="block">
          Qty
          <input value={addQty} inputMode="numeric" onChange={(e) => setAddQty(e.target.value)}
                 disabled={editGate.disabled || !partsGate.allowed} title={addTitle}
                 aria-label="Add rider quantity" className={`${INPUT_COMPACT} mt-1 w-24 disabled:bg-surface-50`} />
        </label>
        <label className="block">
          {NET_WEIGHT_LB}
          <input value={displayedAddWeight} inputMode="decimal"
                 onChange={(e) => setAddWeightOverride(e.target.value)}
                 disabled={editGate.disabled || !partsGate.allowed} title={addTitle}
                 aria-label="Add rider weight" className={`${INPUT_COMPACT} mt-1 w-28 disabled:bg-surface-50`} />
        </label>
        {addWeightOverride !== null && (
          <button type="button" onClick={() => setAddWeightOverride(null)}
                  disabled={editGate.disabled || !partsGate.allowed} title={addTitle}
                  className={`${LINK} text-xs`}>
            Reset to computed
          </button>
        )}
        <button onClick={() => void addRider()} disabled={editGate.disabled || !partsGate.allowed || adding}
                title={addTitle}
                className={BUTTON_PRIMARY_COMPACT}>
          {adding ? "Adding…" : "Add rider"}
        </button>
        {/* The rider's quote-link preview + re-pick (spec §5.2 — addLine is a create path with
            the same three-way semantics as entry). Judged against the ORDER's stored received
            date (ruling 6), which is why the fetch pins `receivedDate` rather than omitting it.
            Full-width so the flex-wrap row breaks below the inputs. */}
        <div className="w-full">
          <QuoteLinkPicker customerId={customerId} partId={addPartId} receivedDate={receivedDate}
                           value={addQuotePick} onChange={setAddQuotePick}
                           pickGate={editGate} viewAllowed={ordersViewAllowed}
                           ariaLabel="Add rider quote link" />
        </div>
      </div>
    </section>
  );
}
