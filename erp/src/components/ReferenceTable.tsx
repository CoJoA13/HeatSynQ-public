"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "@/lib/fetcher";
import { useLatest } from "@/lib/use-latest";
import { HistoryPanel, invalidateHistory } from "@/components/HistoryPanel";
import { invalidateSetupBanner } from "@/components/SetupBanner";
import { PasteGrid } from "@/components/PasteGrid";
import { InlineDecimalBox } from "@/components/InlineDecimalBox";
import { InlinePairBox } from "@/components/InlinePairBox";
import { InlineTextBox } from "@/components/InlineTextBox";
import { decimalRefusal } from "@/lib/decimal-entry";
import { readWholeNumber, wholeNumberRefusal, wholeNumberSentence } from "@/lib/whole-number-entry";
import { unansweredStatus } from "@/lib/line-field-saves";
import { inlineDecimalSave, inlineNameSave, inlineTextSave, rowsWithStoredFigure } from "@/lib/reference-inline-edit";
import { recordSaved, savedShows, type SavedRecord } from "@/lib/saved-mark";
import { discountPairSave, type DiscountTexts } from "@/lib/terms-discount-pair";
import { useUnsavedSection } from "@/lib/use-unsaved-section";
import { REFERENCE_LABELS, REFERENCE_EXTRA_FIELDS, type ReferenceKind } from "@/lib/reference-constants";
import { linksFrom, nameKey } from "@/lib/reference-links";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { BlockerPanel, type Blocker } from "@/components/BlockerPanel";
import { PanelMessage } from "@/components/PanelMessage";
import { PageHeader } from "@/components/PageHeader";
import { ActionMenu } from "@/components/ActionMenu";
import { askConfirm } from "@/lib/modal";
import { BUTTON_NEUTRAL, BUTTON_PRIMARY, BUTTON_PRIMARY_COMPACT, CARD_FLUSH, INPUT_COMPACT, NOTICE, TABLE_HEAD } from "@/lib/ui-classes";
import { oneShotHold } from "@/lib/single-flight";
import { Combobox } from "@/components/Combobox";
import { withBlank } from "@/lib/menu-options";
import { inMenuOrder } from "@/lib/menu-order";

type Row = { id: string; name: string; active: boolean } & Record<string, unknown>;

// The reference kinds the setup banner's readiness rollup counts: glAccount feeds the `chart`
// step (src/server/order-entry-readiness.ts), the other four feed `references`
// (src/server/install-readiness.ts). Hardcoded here rather than imported because a client
// component must not import from src/server/** (CLAUDE.md). A create or delete on any other kind
// moves no readiness signal, so it skips the invalidation — each refetch costs the server an
// argon2 verify (#110).
const READINESS_COUNTED_KINDS: ReadonlySet<string> = new Set([
  "glAccount", "terms", "carrier", "containerType", "material",
]);

// The Pick lists screen's body: this component's state feeds the page header's actions, so it draws
// the page around the selector the route hands it (the UX redesign PR 11, owner 2026-11-01 on #826).
export function ReferenceTable({ kind, selector }: { kind: ReferenceKind; selector?: ReactNode }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  // The Show inactive box as it is now, for `load` to read when a read starts. The box's handler
  // writes it beside the state, which the box and the Export link draw from.
  const showInactiveNow = useRef(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  // What was typed in Terms' two discount boxes, by row: they save together (#680,
  // src/lib/terms-discount-pair.ts), so a box's text outlives the box being left.
  const [pairText, setPairText] = useState<Record<string, DiscountTexts>>({});
  // The same text as of the last keystroke, for a save's answer and a blur during it, which must
  // not read a render's copy. `writePair` writes both.
  const pairNow = useRef(pairText);
  const [pairSaved, setPairSaved] = useState<SavedRecord>({});
  const pairsOut = useRef(new Set<string>());
  // A row's box left while that row's save was out: it is committed once the save has landed.
  const pairsAgain = useRef(new Map<string, keyof DiscountTexts>());
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [blocked, setBlocked] = useState<{ row: Row; list: Blocker[] } | null>(null);
  // The link columns' options read owns its line (P6): Add, a save or a delete that lands clears
  // `error`, which erased this failure while the dropdowns stayed empty. Declared after the slots
  // above so their order holds (the inline-edit suite's state seam counts them).
  const [optionsError, setOptionsError] = useState<string | null>(null);
  // A row's own message and the Add row's (owner ruling R1, P6 step 5d): an Active or flag change,
  // a decimal box's save and a delete report under their row, and Add under the Add row, through
  // the shared PanelMessage. `error` is the list read's alone, which it clears when it next lands.
  // One row message at a time: a newer row's refusal replaces it, and a row's success clears only
  // its own. Declared after `optionsError`, as the inline-edit suite's state seam counts them.
  const [rowMessage, setRowMessage] = useState<{ rowId: string; message: string } | null>(null);
  const [addMessage, setAddMessage] = useState<string | null>(null);
  // #720: Add's hold, so a second click while the POST is out sends nothing (it would be refused
  // as a duplicate name after the first landed). A boolean and a function initial, so the test seams
  // that count null- and object-initialised states are not moved.
  const [adding, setAdding] = useState(false);
  const [addHold] = useState(() => oneShotHold(setAdding));
  const { permissions: perms, error: permsError } = usePermissions();
  const labels = REFERENCE_LABELS[kind];
  const extras = REFERENCE_EXTRA_FIELDS[kind];
  const refLinks = linksFrom(kind);
  const [refOptions, setRefOptions] = useState<Record<string, { id: string; name: string }[]>>({});
  // Gated per the permission each route actually enforces, not one blanket key: add/paste hit
  // POST routes requiring admin.create, delete hits a DELETE route requiring admin.delete, and
  // the PUT behind the Active box, a flag column and a decimal column's edit box requires
  // admin.edit (src/app/api/admin/reference/[kind]/route.ts, .../paste/route.ts,
  // .../[id]/route.ts).
  const canCreate = gate(perms, "admin.create");
  const canDelete = gate(perms, "admin.delete");
  const canEdit = gate(perms, "admin.edit");
  // A discount box waiting on the other is typed work no blur has saved, so a departure is asked
  // about it. Only rows the table holds count, and text that reads as the stored figures does not.
  useUnsavedSection(rows.some((r) => pairText[r.id] && discountPairSave(r, pairText[r.id]).kind !== "none"), labels.plural);

  // Named `latest`, not `gate` — this file also imports `gate` from permission-ui for the
  // held-permission checks below, and shadowing that binding with the stale-response gate would
  // break every `gate(perms, ...)` call in this component (the customers/page.tsx hazard).
  const latest = useLatest();
  // F7 (customers/page.tsx precedent): ticket-gated on BOTH paths. The ticket orders the
  // responses: of two reads out at once, only the newer one's answer lands, so a rapid
  // Show-inactive toggle, or a handler's reload racing one, cannot paint inactive rows under an
  // unchecked box or visually revert a just-flipped flag, and a superseded read's rejection
  // cannot overwrite fresh rows with a stale failure either. The setting is read when a read
  // starts (`showInactiveNow`), not taken from the render that made the handler, so a save, an
  // Active change, a Default change (Ending statements' flag column), an Add, a Delete or a paste
  // that began under one setting and reloads after a click on the box reads the click's setting
  // (#495 item 1). The box's own read is started in its handler, and `load` does not change with
  // the setting, so the effect below is the read on mount: it runs again only for a new `kind`.
  // Cross-KIND safety is NOT this gate's job: it rests on the mount site remounting the component
  // per kind via `key={kind}` (admin/reference/page.tsx) — a standing requirement for any future
  // mount site.
  // How many reads have put their rows into the table: counted where they are put, past the ticket,
  // so a read that failed or was dropped for a newer one counts for nothing. `saveExtra` reads it
  // when it sends a save and again when the answer lands.
  const readsLanded = useRef(0);
  const load = useCallback(async () => {
    const t = latest.next();
    let data: Row[];
    try {
      data = await api<Row[]>(`/api/admin/reference/${kind}${showInactiveNow.current ? "?includeInactive=1" : ""}`);
    } catch (e) {
      if (latest.isCurrent(t)) setError((e as Error).message);
      return;
    }
    if (!latest.isCurrent(t)) return;
    readsLanded.current += 1;
    setRows(data);
    setError(null);
  }, [kind, latest]);
  useEffect(() => { void load(); }, [load]);

  // A stale blocker list from another kind's row must not linger on screen once the admin
  // switches tables.
  useEffect(() => { setBlocked(null); }, [kind]);

  useEffect(() => {
    if (!refLinks.length) return;
    Promise.all(refLinks.map(async (l) => {
      // /api/picklists/<kind> deliberately 404s for glAccount — it stays off the route every
      // signed-in user can reach, but paymentType.glAccountId IS a valid FK target here. This
      // grid is itself an admin.view-gated screen (its own row listing above already calls
      // /api/admin/reference/${kind}), so every ref-link's options are fetched from that same
      // admin endpoint rather than the narrower picklist route — one endpoint choice, no
      // per-link special-casing, and it sidesteps the 404 without widening PICKLIST_KINDS.
      // includeInactive so an already-assigned inactive target still renders by name.
      const opts = await api<{ id: string; name: string }[]>(
        `/api/admin/reference/${l.targetKind}?includeInactive=1`);
      return [l.column, opts] as const;
    }))
      .then((pairs) => setRefOptions(Object.fromEntries(pairs)))
      // No .catch(() => {}) here: a failed fetch that renders an empty dropdown is
      // indistinguishable from a shop that has configured nothing. Say so instead.
      .catch((e) => setOptionsError(`Could not load pick lists: ${(e as Error).message}`));
    // refLinks is recomputed every render (a fresh array from linksFrom), so it deliberately
    // isn't a dependency here — that would re-run this effect on every render instead of once
    // per kind change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  async function add() {
    // A decimal box with a rule is checked before anything is sent, by the label the column
    // shows (the Add row has no row name to lead with), and so is a whole-number column with its
    // box (ruling 19, G5-4: `1e2` was sent as 100, and a 0 came back as the server's zod path).
    // A blank box is no refusal: it sends what it always did (`buildPayload`). Every refusal is
    // told, one to a line, and the draft stays.
    const refused = extras.flatMap((f) => {
      const typed = draft[f.key];
      if (typed === undefined || typed.trim() === "") return [];
      if (f.box) return decimalRefusal(f.label, typed, f.box) ?? [];
      if (f.whole) return wholeNumberRefusal(typed, f.whole) ?? [];
      return [];
    });
    if (refused.length > 0) { setAddMessage(refused.join("\n")); return; }
    await addHold.run(async () => {
      try {
        await api(`/api/admin/reference/${kind}`, { method: "POST", body: JSON.stringify(buildPayload()) });
        // #110: a create on a counted kind can complete a readiness step — fired the instant the
        // POST resolves, before load() (the #124/!131 ordering).
        if (READINESS_COUNTED_KINDS.has(kind)) invalidateSetupBanner();
        // #158 — a CREATE can rewrite ANOTHER row's history. `normalizeEndingStatementDefaultOnCreate`
        // (reference.ts) demotes the current default through `auditedUpdate` when the new row is
        // flagged, so the demoted row's own open panel goes stale on a change it did not make. The
        // first pass wired only `toggleFlag`, whose demotion is the same write reached the other way
        // (Codex P2 on MR !187). Success path, before load (#124/!131); the signal is global, so the
        // demoted row's panel refreshes wherever it is mounted.
        invalidateHistory();
        setDraft({}); setAddMessage(null); await load();
      } catch (e) { setAddMessage((e as Error).message); }
    });
  }

  // `draft` is a plain string map (every input writes a string). Three extra-field kinds need
  // massaging before that map is a valid request body:
  //   - "number" (Terms' netDays/discountDays, Task 4): a real `z.number().int()` server-side,
  //     not string-accepting like decimalField — so it needs converting to an actual JS number,
  //     the requestDaysOverride precedent (customers/[id]/page.tsx).
  //   - "decimal" (Terms' discountPercent, Task 4 fix round 1): IS string-accepting
  //     (`decimalField`), so no numeric conversion — but it also isn't `""`-accepting: an empty
  //     string fails decimalField's digit-pattern regex with a cryptic 400 instead of being
  //     treated as "no value." A user who types a discount percent and then clears the box must
  //     get "no discount," not that regex error.
  //   - "boolean" (endingStatement.isDefault, Phase 6): the Add-row checkbox writes the strings
  //     "true"/"" into draft; "true" becomes a real `true` here, unchecked drops the key so the
  //     column default applies — a checkbox has no failed-parse case, so nothing is left behind
  //     for the server to name.
  // All three drop a blank input entirely rather than send `""`, so the field's own `.optional()`
  // applies (and, for netDays, so the column's `@default(30)` applies) instead of a 400. Plain
  // "text" fields (glAccount.description, commentSnippet/specification.text) are deliberately left
  // untouched here — `""` is a legitimate stored value for genuine free text, not "no value."
  // A "number" value is read by the whole-number rule with the column's box (ruling 19, G5-4);
  // `add()` has refused anything that does not fit before this runs, so what reaches here is a
  // figure. A column with no box, or text the rule refuses, is left as the original string so the
  // server's own "Expected number, received string" explains it, rather than silently becoming
  // `null` (an "abc" input's `Number()` is `NaN`, which `JSON.stringify` turns into `null`).
  function buildPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...draft };
    for (const f of extras) {
      if (f.kind !== "number" && f.kind !== "decimal" && f.kind !== "boolean") continue;
      const raw = draft[f.key];
      if (raw === undefined || raw.trim() === "") { delete payload[f.key]; continue; }
      if (f.kind === "number") {
        const reading = f.whole ? readWholeNumber(raw, f.whole) : { ok: false as const };
        payload[f.key] = reading.ok ? reading.value : raw;
      }
      if (f.kind === "boolean") payload[f.key] = raw === "true";
      // "decimal": decimalField accepts the raw string as-is once it isn't blank.
    }
    return payload;
  }

  // One PUT-a-flag helper for the Active column and every "boolean" extra column (Phase 6:
  // endingStatement.isDefault — flipping it ON is how an existing row is promoted to the default;
  // the service demotes the old one, and flipping it OFF leaves the kind defaultless).
  async function toggleFlag(row: Row, key: string) {
    try {
      await api(`/api/admin/reference/${kind}/${row.id}`, {
        method: "PUT", body: JSON.stringify({ [key]: !row[key] }),
      });
      // #158 — success path, before the follow-up load (#124/!131). The row stays on screen after
      // a toggle, so its open History panel (mounted per-row, right beside this checkbox) would
      // otherwise keep showing the pre-toggle history. Flipping `isDefault` ON also demotes
      // another row; the signal is global, so that row's panel refreshes too.
      invalidateHistory();
      // Retiring a row via the Active toggle is the sanctioned alternative to deleting it (§4.2)
      // — it must not leave a blocker panel from an earlier failed delete attempt on screen.
      clearRowMessage(row.id); setBlocked(null); await load();
    } catch (e) { setRowMessage({ rowId: row.id, message: (e as Error).message }); }
  }

  /** Clears the row message when it is this row's: a success elsewhere leaves another row's. */
  function clearRowMessage(rowId: string) {
    setRowMessage((current) => (current?.rowId === rowId ? null : current));
  }

  // An edit box of an existing row (a row's Name, a text, whole-number or decimal column). The box
  // decides what leaving it sends (src/lib/reference-inline-edit.ts). This checks it and answers the
  // box: true when the value was stored, false when the table's own check or the server refused it,
  // or the save got no answer. After false the box shows the row's stored value again.
  // A figure the rule refuses is told here, before anything is sent. A decimal box names the row,
  // then the column's label, then the rule's sentence (§9.9 point 17); a whole-number box has its one
  // sentence (ruling 19), under its row, and Net days must hold a figure. No request goes, so the
  // answer is false and the box shows the stored value again. A cleared decimal box (null) is no
  // refusal.
  async function saveExtra(row: Row, key: string, value: string | null): Promise<boolean> {
    const field = extras.find((f) => f.key === key);
    if (field?.box && value !== null) {
      const refused = decimalRefusal(`${row.name}, ${field.label}`, value, field.box);
      if (refused !== null) { setRowMessage({ rowId: row.id, message: refused }); return false; }
    }
    if (field?.whole) {
      const reading = readWholeNumber(value ?? "", field.whole);
      if (!reading.ok) { setRowMessage({ rowId: row.id, message: wholeNumberSentence(field.whole) }); return false; }
      return savePatch(row, { [key]: reading.value });
    }
    return savePatch(row, { [key]: value });
  }

  // Sends one row's patch, as the keys the PUT route's partial update takes.
  // History is told before the reload, as `toggleFlag` above does and for its reason: the row
  // stays on screen, and its open panel must show this change even when the reload fails.
  // A stored save puts the values it sent into its row before the reload (`rowsWithStoredFigure`,
  // #495 item 2), as an updater over whatever the table holds when the answer lands, not over this
  // render's rows, and only when no read has put rows into the table since the save was sent
  // (`readsLanded`, compared here and never inside the updater; Codex P2 on #559). A read that
  // landed while the save was out can have brought a value stored after this one, another
  // admin's, and the write would put the value sent back over it. The table cannot tell that read
  // from one the server answered before it stored this save, which brought the value from before
  // it: then the row shows that value until a read brings another, and leaving the box with the
  // value sent sends it again. With no read landed in between, a value stored after this one is
  // brought by the reload dispatched right after the write, when that reload lands. A save with no
  // answer writes nothing into the row: the reload decides what the box shows (§9.9 point 24).
  // Each reload below is awaited before the answer, so the value the box then shows is the one
  // the reload brought. A reload that failed, or that a newer read superseded, sets no rows, and
  // the box shows the value the table holds: after a stored save that wrote its value, the
  // value sent, until a read that lands brings another, so leaving the box after Enter, with the
  // text unchanged, sends nothing. After a stored save with
  // the cursor still in the box (Enter), the box keeps the typed text until the cursor leaves it
  // (src/lib/use-inline-box.ts).
  async function savePatch(row: Row, patch: Record<string, string | number | null>): Promise<boolean> {
    const readsAtSend = readsLanded.current;
    try {
      await api(`/api/admin/reference/${kind}/${row.id}`, {
        method: "PUT", body: JSON.stringify(patch),
      });
      invalidateHistory();
      clearRowMessage(row.id);
      if (readsLanded.current === readsAtSend) {
        setRows((current) => Object.entries(patch).reduce(
          (next, [key, value]) => rowsWithStoredFigure(next, row.id, key, value), current));
      }
      await load();
      return true;
    } catch (e) {
      setRowMessage({ rowId: row.id, message: (e as Error).message });
      // Whether the server answered, by the test the saved order's Lines make (R13,
      // `unansweredStatus` in src/lib/line-field-saves.ts). An ApiError below 500 is the server's
      // refusal: it wrote nothing, and its reason is the message just set. Anything else is no
      // answer the page can trust: the request threw before a response arrived, the server
      // answered 5xx, or, since #547, the server answered 2xx and its body could not be read
      // (`UnreadableAnswerError`, which carries no `status`), in which case the value was stored.
      // In each case the value may have been stored, so the table is read again and the box
      // shows what the server holds (owner ruling 2026-10-09). History is told first, for the
      // reason above. The row's message is set before the reload, and a reload that fails writes
      // its own to the page's line, so both are on screen.
      if (unansweredStatus(e instanceof ApiError ? e.status : null)) {
        invalidateHistory();
        await load();
      }
      return false;
    }
  }

  function writePair(next: Record<string, DiscountTexts>) {
    pairNow.current = next;
    setPairText(next);
  }

  /** Drops a row's typed discount text: one box's, or with no key, both. */
  function dropPairText(rowId: string, key?: keyof DiscountTexts) {
    const rest = { ...pairNow.current[rowId] };
    if (key) delete rest[key];
    const next = { ...pairNow.current };
    if (key && Object.keys(rest).length > 0) next[rowId] = rest;
    else delete next[rowId];
    writePair(next);
  }

  // A discount box left, or Enter pressed in it (owner ruling 2026-11-02, #680). A figure the rule
  // refuses is told as any other box's and goes back to the stored one, and its partner keeps what
  // was typed. Otherwise the leaf decides: hold the text, or send both boxes as one patch.
  // Both boxes stay open while that save is out, because the cursor is usually on its way to the
  // other one (Codex P2 on #864). So only the text the save carried goes when it lands, each box
  // then showing the row's stored figure, and a box left in the meantime is committed over what the
  // save stored. A save that was not stored commits nothing more: `row` may no longer be what the
  // server holds (a save with no answer can have landed), so the text stays in its box, as unsaved
  // work under the row's message, and the next commit reads the row the reload brought.
  async function commitPair(row: Row, key: keyof DiscountTexts, typed: string) {
    if (pairsOut.current.has(row.id)) { pairsAgain.current.set(row.id, key); return; }
    const field = extras.find((f) => f.key === key);
    const refused = typed.trim() === "" ? null : field?.box ? decimalRefusal(`${row.name}, ${field.label}`, typed, field.box)
      : field?.whole ? wholeNumberRefusal(typed, field.whole) : null;
    if (refused !== null) { setRowMessage({ rowId: row.id, message: refused }); dropPairText(row.id, key); return; }
    const texts = { ...pairNow.current[row.id], [key]: typed };
    const save = discountPairSave(row, texts);
    if (save.kind === "none") { dropPairText(row.id); return; }
    if (save.kind === "hold") { writePair({ ...pairNow.current, [row.id]: texts }); return; }
    const days = save.discountDays === null ? null : Number(save.discountDays);
    pairsOut.current.add(row.id);
    const stored = await savePatch(row, { discountPercent: save.discountPercent, discountDays: days });
    pairsOut.current.delete(row.id);
    for (const k of ["discountPercent", "discountDays"] as const) {
      if (pairNow.current[row.id]?.[k] === texts[k]) dropPairText(row.id, k);
    }
    if (stored) {
      setPairSaved((current) => recordSaved(recordSaved(current, `${row.id}:discountPercent`, save.discountPercent ?? "", true),
        `${row.id}:discountDays`, save.discountDays ?? "", true));
    }
    const again = pairsAgain.current.get(row.id);
    pairsAgain.current.delete(row.id);
    const text = again && pairNow.current[row.id]?.[again];
    if (stored && again && text !== undefined) {
      await commitPair({ ...row, discountPercent: save.discountPercent, discountDays: days }, again, text);
    }
  }

  // The header's Add row: the row's first box takes the cursor and nothing is sent.
  const addFirstRef = useRef<HTMLInputElement>(null);
  function focusNewRow() {
    addFirstRef.current?.scrollIntoView({ block: "center" });
    addFirstRef.current?.focus();
  }

  async function remove(row: Row) {
    if (!await askConfirm({ title: `Delete ${labels.singular.toLowerCase()} "${row.name}"?`, body: "", confirm: "Delete", danger: true })) return;
    try {
      await api(`/api/admin/reference/${kind}/${row.id}`, { method: "DELETE" });
      // #110: deleting the last row of a counted kind can UN-complete a readiness step.
      if (READINESS_COUNTED_KINDS.has(kind)) invalidateSetupBanner();
      // #158 — the soft-delete has COMMITTED, so the row's own delete entry exists and its open
      // panel is showing pre-delete history. `load()` below swallows a GET failure and returns, so
      // on a failed reload the deleted row and its stale panel both stay on screen (Codex P2 on
      // MR !187). Signalling here, before the load, means the panel is right even when the reload
      // is not. This is the THIRD mutation in this file; the previous round wired the two it was
      // asked about instead of sweeping all three.
      invalidateHistory();
      clearRowMessage(row.id); setBlocked(null); await load();
    } catch (e) {
      // A refusal is not a dead end here: say what is blocking, and make the list exportable.
      // Only the delete guard's own 400 means there IS a blocker list to fetch — a 500 or a
      // network failure is a genuine error, not a refusal, and fetching (and likely finding no)
      // blockers for it would misreport a real failure as "N records use it".
      if (e instanceof ApiError && e.status === 400) {
        try {
          const list = await api<Blocker[]>(`/api/admin/reference/${kind}/${row.id}/blockers`);
          if (list.length) { setBlocked({ row, list }); clearRowMessage(row.id); return; }
        } catch (listErr) {
          // The delete WAS correctly refused, but the follow-up fetch for WHAT is blocking it
          // failed too (network, 500). A silently empty list here is indistinguishable from
          // "nothing blocks it" and recreates the undiscoverable dead end this feature exists to
          // remove — say plainly that the list is missing, not empty, so the user can retry.
          setRowMessage({ rowId: row.id, message: `${(e as Error).message} — the list of what's using it could not be loaded ` +
            `(${(listErr as Error).message}). Try again.` });
          return;
        }
      }
      setRowMessage({ rowId: row.id, message: (e as Error).message });
    }
  }

  function pairBox(r: Row, key: keyof DiscountTexts, label: string, hint: string | undefined, numeric: boolean) {
    const typed = pairText[r.id] ?? {};
    const stored = r[key];
    const text = typed[key] ?? (stored === null || stored === undefined ? "" : String(stored));
    const waits = discountPairSave(r, typed).kind === "hold" && text.trim() !== "";
    return (
      <InlinePairBox label={`${label} for ${r.name}`} text={text} numeric={numeric}
                     hint={waits ? hint : undefined} disabled={canEdit.disabled} title={canEdit.title}
                     saved={savedShows(pairSaved, `${r.id}:${key}`, text)}
                     onType={(value) => writePair({ ...pairNow.current, [r.id]: { ...pairNow.current[r.id], [key]: value } })}
                     onCommit={(value) => void commitPair(r, key, value)} />
    );
  }

  const exportHref = `/api/admin/reference/${kind}/export${showInactive ? "?includeInactive=1" : ""}`;

  return (
    <div className="min-w-0 p-3 sm:p-6">
      <PageHeader title="Pick lists" subtitle="Select a list, edit a row, keep the rest out of the way."
        actions={<>
          <button type="button" onClick={focusNewRow} disabled={canCreate.disabled} title={canCreate.title}
                  className={BUTTON_PRIMARY}>
            Add row
          </button>
          <button type="button" onClick={() => setPasting((p) => !p)} disabled={canCreate.disabled} title={canCreate.title}
                  className={BUTTON_NEUTRAL}>
            {pasting ? "Hide paste entry" : "Paste from spreadsheet"}
          </button>
          <ActionMenu items={[
            { label: "Export to Excel", href: exportHref },
          ]} />
        </>} />
      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3 whitespace-pre-line`}>{error ?? permsError}</p>
      )}
      {optionsError && <p className={`${NOTICE.warning} mb-3`}>{optionsError}</p>}
      <div className="flex gap-6">
      {selector}
      <div className="min-w-0 flex-1">
      <div className="mb-2 flex items-center gap-3">
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={showInactive}
                 onChange={(e) => { showInactiveNow.current = e.target.checked; setShowInactive(e.target.checked); void load(); }} />
          Show inactive
        </label>
      </div>
      <div className={`${CARD_FLUSH} overflow-x-auto`}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className={`${TABLE_HEAD} p-2`}>{labels.nameLabel}</th>
            {extras.map((f) => <th key={f.key} className={`${TABLE_HEAD} p-2`}>{f.label}</th>)}
            <th className={`${TABLE_HEAD} p-2`}>Active</th><th className={TABLE_HEAD} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t">
              <td className="min-w-48 p-2">
                <InlineTextBox label={`${labels.nameLabel} for ${r.name}`} stored={r.name} decide={inlineNameSave}
                               disabled={canEdit.disabled} title={canEdit.title}
                               onSave={(value) => saveExtra(r, "name", value)} />
                <PanelMessage message={rowMessage?.rowId === r.id ? rowMessage.message : null} />
              </td>
              {extras.map((f) => (
                <td key={f.key} className="p-2">
                  {f.kind === "boolean" ? (
                    // Interactive like the Active checkbox one cell over — same PUT, same gate.
                    <input type="checkbox" checked={Boolean(r[f.key])} disabled={canEdit.disabled}
                           title={canEdit.title} onChange={() => toggleFlag(r, f.key)} />
                  ) : f.paired ? (
                    pairBox(r, f.key as keyof DiscountTexts, f.label, f.hint, f.kind === "number")
                  ) : f.kind === "decimal" && f.editable ? (
                    // A decimal column marked editable (container types' Tare each) is a box on an
                    // existing row: the same PUT route and the same gate as the Active box. It is
                    // named for its row, because the table holds one box per row.
                    <InlineDecimalBox label={`${f.label} for ${r.name}`} stored={r[f.key]}
                                      disabled={canEdit.disabled} title={canEdit.title}
                                      onSave={(value) => saveExtra(r, f.key, value)} />
                  ) : f.editable ? (
                    <InlineTextBox label={`${f.label} for ${r.name}`} stored={r[f.key]}
                                   decide={f.kind === "number" ? inlineDecimalSave : inlineTextSave}
                                   numeric={f.kind === "number"} multiline={f.multiline}
                                   disabled={canEdit.disabled} title={canEdit.title}
                                   onSave={(value) => saveExtra(r, f.key, value)} />
                  ) : (
                    String(r[f.kind === "ref" ? nameKey(f.key) : f.key] ?? "")
                  )}
                </td>
              ))}
              <td className="p-2">
                <input type="checkbox" checked={r.active} disabled={canEdit.disabled} title={canEdit.title}
                       onChange={() => toggleFlag(r, "active")} />
              </td>
              <td className="p-2 text-right">
                <button onClick={() => setOpenHistory(openHistory === r.id ? null : r.id)}
                        className="mr-3 text-xs text-ink-500">history</button>
                <button onClick={() => remove(r)} disabled={canDelete.disabled} title={canDelete.title}
                        className="text-xs text-red-600">
                  delete
                </button>
                {openHistory === r.id && <HistoryPanel entity={kind} entityId={r.id} perms={perms} permsError={permsError} />}
              </td>
            </tr>
          ))}
          <tr className="border-t bg-surface-50">
            <td className="p-2">
              <input ref={addFirstRef} value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                     disabled={canCreate.disabled} title={canCreate.title}
                     placeholder={labels.nameLabel} className={`${INPUT_COMPACT} w-full disabled:bg-surface-50`} />
            </td>
            {extras.map((f) => (
              <td key={f.key} className="p-2">
                {f.kind === "ref" && f.key === "glAccountId" ? (
                  // A GL account is a growing record list, so it takes the typeahead picker, its
                  // accounts by number, each segment by value (#1056 rulings 1, 2 and 4). The
                  // Default scale beside it is a short pick list and stays a native select.
                  <Combobox value={draft[nameKey(f.key)] ?? ""}
                            options={withBlank("—", inMenuOrder(refOptions[f.key] ?? [], (o) => o.name).map((o) => ({ value: o.name, label: o.name })))}
                            onSelect={(v) => setDraft({ ...draft, [nameKey(f.key)]: v })}
                            disabled={canCreate.disabled} title={canCreate.title}
                            ariaLabel={f.label} className="w-full" />
                ) : f.kind === "ref" ? (
                  <select value={draft[nameKey(f.key)] ?? ""}
                          onChange={(e) => setDraft({ ...draft, [nameKey(f.key)]: e.target.value })}
                          disabled={canCreate.disabled} title={canCreate.title}
                          className={`${INPUT_COMPACT} w-full disabled:bg-surface-50`}>
                    <option value="">—</option>
                    {inMenuOrder(refOptions[f.key] ?? [], (o) => o.name).map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}
                  </select>
                ) : f.kind === "boolean" ? (
                  <>
                    {/* draft is a string map — the checkbox round-trips through "true"/"" and
                        buildPayload() turns "true" into a real boolean (unchecked drops the key). */}
                    <input type="checkbox" checked={draft[f.key] === "true"}
                           disabled={canCreate.disabled} title={canCreate.title}
                           onChange={(e) => setDraft({ ...draft, [f.key]: e.target.checked ? "true" : "" })} />
                    {f.hint && <span className="mt-0.5 block text-xs text-ink-500">{f.hint}</span>}
                  </>
                ) : (
                  <>
                    <input value={draft[f.key] ?? ""}
                           inputMode={f.kind === "number" ? "numeric" : f.kind === "decimal" ? "decimal" : undefined}
                           onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                           disabled={canCreate.disabled} title={canCreate.title}
                           placeholder={f.label} className={`${INPUT_COMPACT} w-full disabled:bg-surface-50`} />
                    {f.hint && <span className="mt-0.5 block text-xs text-ink-500">{f.hint}</span>}
                  </>
                )}
              </td>
            ))}
            <td />
            <td className="p-2 text-right">
              <button onClick={add} disabled={canCreate.disabled || adding} title={canCreate.title}
                      className={BUTTON_PRIMARY_COMPACT}>
                Add
              </button>
              <PanelMessage message={addMessage} />
            </td>
          </tr>
        </tbody>
      </table>
      </div>
      {blocked && (
        <BlockerPanel
          label={labels.singular.toLowerCase()}
          rowName={blocked.row.name}
          list={blocked.list}
          exportHref={`/api/admin/reference/${kind}/${blocked.row.id}/blockers/export`}
          onDismiss={() => setBlocked(null)}
        />
      )}
      {pasting && (
        <PasteGrid
          endpoint={`/api/admin/reference/${kind}/paste`}
          columns={[REFERENCE_LABELS[kind].nameLabel, ...REFERENCE_EXTRA_FIELDS[kind].map((f) => f.label)]}
          onDone={() => {
            // #110: PasteGrid fires onDone only after a successful POST, a 2xx whose answer could
            // not be read included (#547), where add() runs its success path only on an answer it read.
            if (READINESS_COUNTED_KINDS.has(kind)) invalidateSetupBanner();
            // #158: and a pasted batch creates rows the same way `add()` does, so it can demote an
            // existing default just as invisibly.
            invalidateHistory();
            void load();
          }}
        />
      )}
      </div>
      </div>
    </div>
  );
}
