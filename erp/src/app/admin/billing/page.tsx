"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { invalidateSetupBanner } from "@/components/SetupBanner";
import { usePermissions } from "@/lib/use-permissions";
import { gate } from "@/lib/permission-ui";
import { decimalRefusal } from "@/lib/decimal-entry";
import { CERT_CHARGE_DEFAULT, PLANT_FINANCE_CHARGE, PLANT_SALES_TAX_RATE } from "@/lib/rate-boxes";
import { percentFromFraction, fractionFromPercent } from "@/lib/rate-display";
import { useEditGuard } from "@/lib/use-edit-guard";
import { useMutationGate } from "@/lib/use-latest";
import { PageHeader } from "@/components/PageHeader";
import { PageStatus } from "@/components/PageStatus";
import { RecordTabs } from "@/components/RecordTabs";
import { ACCOUNTING_TAB_LABEL, accountingTabs } from "@/lib/admin-tabs";
import { SavedMark } from "@/components/SavedMark";
import { useSavedMarks } from "@/lib/use-saved-marks";
import { CARD_FLUSH, INPUT_COMPACT, NOTICE } from "@/lib/ui-classes";

// number|null once loaded from the server, but also string mid-edit for the two decimal fields —
// the input is bound straight to these and the server's decimalField schema accepts a decimal
// string as-is (customers/[id]/page.tsx creditLimit precedent).
type Cfg = {
  salesTaxRate: number | string | null;
  salesTaxGlAccountId: string | null;
  freightGlAccountId: string | null;
  otherChargeGlAccountId: string | null;
  certChargeStepCodeId: string | null;
  certChargeDefault: number | string | null;
  billForCertDefault: boolean;
  // Task 4 (P5B §4.3, §7): plant default monthly finance-charge rate. Same string-mid-edit
  // convention as the two decimal fields above.
  financeChargeRate: number | string | null;
  // Phase 5C: the A/R close's three GL defaults.
  arGlAccountId: string | null;
  discountGlAccountId: string | null;
  writeOffGlAccountId: string | null;
};
type GlAccount = { id: string; name: string; description?: string | null };

// #227: the page displays PERCENT everywhere, but `salesTaxRate` is STORED as a fraction
// (0.07 = 7% — pricing.ts multiplies directly) while `financeChargeRate` is stored as the
// percent number itself (finance-charges.ts divides by 100). State holds the displayed text, so
// the one fraction field converts at every server→state landing through this map and back to the
// fraction in `blurDecimal` before the wire — the API and the database never change convention.
const displayCfg = (c: Cfg): Cfg => ({ ...c, salesTaxRate: percentFromFraction(c.salesTaxRate) });
type StepCodeOption = { id: string; name: string; active: boolean };

export default function BillingPage() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [glAccounts, setGlAccounts] = useState<GlAccount[]>([]);
  const [stepCodes, setStepCodes] = useState<StepCodeOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The one Saved mark (R7): a box reads Saved while it shows the value its newest landed save
  // carried (src/lib/saved-mark.ts), where a 1.5-second flash used to show.
  const savedMarks = useSavedMarks();
  const { permissions: perms, error: permsError } = usePermissions();
  // Every write here hits PUT /api/admin/billing, which requires admin.edit
  // (src/app/api/admin/billing/route.ts) — disabled with a tooltip, never hidden (§5.16).
  const canEdit = gate(perms, "admin.edit");

  // #222: every per-field save here answers with the ENTIRE fresh config, and the page used to
  // swap it into state at ARRIVAL order — two overlapping saves could revert a committed sibling
  // control, and a response landing mid-typing wiped the field under the cursor. The orders-hub
  // shape fixes both: ONE mutation gate orders every landing (loads and save responses take a
  // ticket at DISPATCH; an out-of-order straggler is dropped, an early finisher is not), and
  // every accepted payload merges through `editGuard.applyPayload`, which preserves the one
  // field the user is actively editing. The hub's known residual is accepted here too: a
  // dropped straggler whose commit postdates the accepted snapshot leaves that one field stale
  // until the next landing — rare at blur-save granularity, and the next interaction converges.
  const editGuard = useEditGuard();
  const gateSeq = useMutationGate();

  // GL accounts are deliberately not on the pick-list route (PICKLIST_KINDS excludes them,
  // §5.15) — this is an admin page, so the admin reference route is the right source. Neither
  // request asks for includeInactive: the step-codes page's GL-account select (the precedent for
  // this screen) doesn't either. ONE ticket covers all three fetches, so the reference lists can
  // never tear across two loads' snapshots (the admin/users load shape, on the mutation gate).
  const load = useCallback(async () => {
    const ticket = gateSeq.next();
    const [c, gl, sc] = await Promise.all([
      api<Cfg>("/api/admin/billing"),
      api<GlAccount[]>("/api/admin/reference/glAccount"),
      api<StepCodeOption[]>("/api/picklists/processStepCode"),
    ]);
    if (!gateSeq.accept(ticket)) return; // superseded by a newer landing — drop, don't revert
    setCfg(editGuard.applyPayload(displayCfg(c)));
    setGlAccounts(gl); setStepCodes(sc);
  }, [gateSeq, editGuard]);

  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  /** `shown` is the text the control showed when it saved (a box's typed percent, not the stored
   *  fraction it sends), which its Saved mark compares against. */
  async function save(patch: Partial<Cfg>, shown = String(Object.values(patch)[0] ?? ""), decimal = false) {
    const field = Object.keys(patch)[0] as keyof Cfg;
    const ticket = gateSeq.next(); // BEFORE dispatch — a ticket taken after the await orders by arrival, the bug
    try {
      const updated = await api<Cfg>("/api/admin/billing", { method: "PUT", body: JSON.stringify(patch) });
      // #110: assigning (or clearing) the A/R GL account moves the banner's `chart` readiness
      // step — fired the instant the PUT resolves, BEFORE the accept gate (the orders-hub #158
      // ordering): the server state has certainly changed even when this response is superseded
      // and its payload dropped. The Saved mark follows the same rule — the write committed.
      invalidateSetupBanner();
      setError(null);
      savedMarks.mark(field, shown, { decimal });
      if (!gateSeq.accept(ticket)) return;
      setCfg(editGuard.applyPayload(displayCfg(updated)));
    } catch (e) {
      // §5.13 rollback, through the SAME gate: the reload takes its own (newest) ticket inside
      // load(), so it cannot be beaten by this save's own dropped response, and its failure
      // stays silent — the save's error below is the message the operator needs.
      void load().catch(() => {});
      setError((e as Error).message);
    }
  }

  // A keystroke into a guarded detail object types through this pure updater, never an object
  // built from the render's copy, so a server payload landing beside the keystroke is kept (#574).
  function patchDraft(patch: Partial<Cfg>) {
    setCfg((cur) => (cur ? { ...cur, ...patch } : cur));
  }

  // Blur-save through the edit guard (#222): commits only a value the user actually typed — a
  // value matching any of the focus session's snapshots (at-entry, or a server value an apply
  // gave the box mid-session) is a no-op, so tabbing through an untouched field writes nothing.
  // This replaces the hand-rolled focused-value ref, whose single-snapshot comparison was the
  // documented pre-guard shape (use-edit-guard.ts header).
  // The blur commit (#517): a blank (after trim) saves null; anything else is read by the box's own rule
  // (`rate-boxes.ts`) BEFORE a request, and a refused figure is named and put back to what the box
  // held on entry (`atFocus`). Only salesTaxRate converts (#227) — the displayed percent becomes the
  // stored fraction — and only after the check.
  function commitBillingDecimal(key: "salesTaxRate" | "certChargeDefault" | "financeChargeRate", value: string, atFocus: string) {
    const rate = key === "salesTaxRate" ? PLANT_SALES_TAX_RATE : key === "certChargeDefault" ? CERT_CHARGE_DEFAULT : PLANT_FINANCE_CHARGE;
    const refused = decimalRefusal(rate.label, value, rate.box);
    if (refused) {
      setCfg((cur) => (cur ? { ...cur, [key]: atFocus } : cur));
      setError(refused);
      return false; // the box is back on a value it was given (the guard's Enter contract)
    }
    // Blank after trim saves null, as the customer page's commits do.
    const wire = value.trim() === "" ? null : key === "salesTaxRate" ? fractionFromPercent(value) : value;
    void save({ [key]: wire } as Partial<Cfg>, value, true);
  }
  function blurDecimal(key: "salesTaxRate" | "certChargeDefault" | "financeChargeRate") {
    return (e: React.FocusEvent<HTMLInputElement>) =>
      editGuard.onBlurSave(e, (value, atFocus) => commitBillingDecimal(key, value, atFocus));
  }
  // Enter commits the box as its blur does, the cursor kept in it (owner ruling R7): the same commit.
  function enterDecimal(key: "salesTaxRate" | "certChargeDefault" | "financeChargeRate") {
    return (e: React.KeyboardEvent<HTMLInputElement>) =>
      editGuard.onEnterCommit(e, (value, atFocus) => commitBillingDecimal(key, value, atFocus));
  }

  if (!cfg) return <PageStatus error={error ?? permsError} />;

  const savedMark = (key: keyof Cfg, label: string) =>
    <SavedMark label={label} show={savedMarks.shows(key, String(cfg[key] ?? ""))} />;

  return (
    <div className="min-w-0 p-3 sm:p-6">
      <PageHeader title="Accounting" subtitle="Mappings and defaults used by invoices and period export." />
      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{error ?? permsError}</p>
      )}
      {/* Three tabs over the mounted boxes (src/lib/admin-tabs.ts): each keeps its blur-save and Saved mark. */}
      <RecordTabs label={ACCOUNTING_TAB_LABEL} tabs={accountingTabs()} panels={{
        gl: (
          <section className="mb-6 max-w-2xl">
            <h2 className="mb-2 font-medium">Accounts</h2>
            <div className={CARD_FLUSH}>
            <label className="flex items-center justify-between border-b p-2 text-sm last:border-0">
              <span>A/R{savedMark("arGlAccountId", "A/R")}</span>
              <select
                value={cfg.arGlAccountId ?? ""}
                disabled={canEdit.disabled}
                title={canEdit.title}
                onChange={(e) => void save({ arGlAccountId: e.target.value || null })}
                className={`${INPUT_COMPACT} w-56 disabled:cursor-not-allowed disabled:bg-surface-50`}
              >
                <option value="">(none)</option>
                {glAccounts.map((g) => <option key={g.id} value={g.id}>{g.name} {g.description}</option>)}
              </select>
            </label>
            <label className="flex items-center justify-between border-b p-2 text-sm last:border-0">
              <span>Sales tax{savedMark("salesTaxGlAccountId", "Sales tax")}</span>
              <select
                value={cfg.salesTaxGlAccountId ?? ""}
                disabled={canEdit.disabled}
                title={canEdit.title}
                onChange={(e) => void save({ salesTaxGlAccountId: e.target.value || null })}
                className={`${INPUT_COMPACT} w-56 disabled:cursor-not-allowed disabled:bg-surface-50`}
              >
                <option value="">(none)</option>
                {glAccounts.map((g) => <option key={g.id} value={g.id}>{g.name} {g.description}</option>)}
              </select>
            </label>
            <label className="flex items-center justify-between border-b p-2 text-sm last:border-0">
              <span>Freight{savedMark("freightGlAccountId", "Freight")}</span>
              <select
                value={cfg.freightGlAccountId ?? ""}
                disabled={canEdit.disabled}
                title={canEdit.title}
                onChange={(e) => void save({ freightGlAccountId: e.target.value || null })}
                className={`${INPUT_COMPACT} w-56 disabled:cursor-not-allowed disabled:bg-surface-50`}
              >
                <option value="">(none)</option>
                {glAccounts.map((g) => <option key={g.id} value={g.id}>{g.name} {g.description}</option>)}
              </select>
            </label>
            <label className="flex items-center justify-between border-b p-2 text-sm last:border-0">
              <span>Other charges{savedMark("otherChargeGlAccountId", "Other charges")}</span>
              <select
                value={cfg.otherChargeGlAccountId ?? ""}
                disabled={canEdit.disabled}
                title={canEdit.title}
                onChange={(e) => void save({ otherChargeGlAccountId: e.target.value || null })}
                className={`${INPUT_COMPACT} w-56 disabled:cursor-not-allowed disabled:bg-surface-50`}
              >
                <option value="">(none)</option>
                {glAccounts.map((g) => <option key={g.id} value={g.id}>{g.name} {g.description}</option>)}
              </select>
            </label>
            <label className="flex items-center justify-between border-b p-2 text-sm last:border-0">
              <span>Discounts{savedMark("discountGlAccountId", "Discounts")}</span>
              <select
                value={cfg.discountGlAccountId ?? ""}
                disabled={canEdit.disabled}
                title={canEdit.title}
                onChange={(e) => void save({ discountGlAccountId: e.target.value || null })}
                className={`${INPUT_COMPACT} w-56 disabled:cursor-not-allowed disabled:bg-surface-50`}
              >
                <option value="">(none)</option>
                {glAccounts.map((g) => <option key={g.id} value={g.id}>{g.name} {g.description}</option>)}
              </select>
            </label>
            <label className="flex items-center justify-between border-b p-2 text-sm last:border-0">
              <span>Write-offs{savedMark("writeOffGlAccountId", "Write-offs")}</span>
              <select
                value={cfg.writeOffGlAccountId ?? ""}
                disabled={canEdit.disabled}
                title={canEdit.title}
                onChange={(e) => void save({ writeOffGlAccountId: e.target.value || null })}
                className={`${INPUT_COMPACT} w-56 disabled:cursor-not-allowed disabled:bg-surface-50`}
              >
                <option value="">(none)</option>
                {glAccounts.map((g) => <option key={g.id} value={g.id}>{g.name} {g.description}</option>)}
              </select>
            </label>
            </div>
          </section>
        ),
        tax: (
          <section className="mb-6 max-w-2xl">
            <h2 className="mb-2 font-medium">Defaults</h2>
            <div className={CARD_FLUSH}>
            <label className="flex items-center justify-between border-b p-2 text-sm last:border-0">
              <span>Plant sales tax rate (%){savedMark("salesTaxRate", "Plant sales tax rate (%)")}</span>
              <input aria-label="Plant sales tax rate (%)"
                value={cfg.salesTaxRate ?? ""}
                inputMode="decimal"
                placeholder="4.00"
                disabled={canEdit.disabled}
                title={canEdit.title}
                onFocus={editGuard.onFocusField("salesTaxRate")}
                onChange={(e) => patchDraft({ salesTaxRate: e.target.value })}
                onBlur={blurDecimal("salesTaxRate")}
                onKeyDown={enterDecimal("salesTaxRate")}
                className={`${INPUT_COMPACT} w-40 text-right disabled:cursor-not-allowed disabled:bg-surface-50`}
              />
            </label>
            <label className="flex items-center justify-between border-b p-2 text-sm last:border-0">
              <span>Bill for certification{savedMark("billForCertDefault", "Bill for certification")}</span>
              <input
                type="checkbox"
                checked={cfg.billForCertDefault}
                disabled={canEdit.disabled}
                title={canEdit.title}
                onChange={(e) => void save({ billForCertDefault: e.target.checked })}
              />
            </label>
            <label className="flex items-center justify-between border-b p-2 text-sm last:border-0">
              <span>Certification charge step code{savedMark("certChargeStepCodeId", "Certification charge step code")}</span>
              <select
                value={cfg.certChargeStepCodeId ?? ""}
                disabled={canEdit.disabled}
                title={canEdit.title}
                onChange={(e) => void save({ certChargeStepCodeId: e.target.value || null })}
                className={`${INPUT_COMPACT} w-56 disabled:cursor-not-allowed disabled:bg-surface-50`}
              >
                <option value="">(none)</option>
                {stepCodes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="flex items-center justify-between border-b p-2 text-sm last:border-0">
              <span>Certification charge ($){savedMark("certChargeDefault", "Certification charge ($)")}</span>
              <input aria-label="Certification charge ($)"
                value={cfg.certChargeDefault ?? ""}
                inputMode="decimal"
                placeholder="0.00"
                disabled={canEdit.disabled}
                title={canEdit.title}
                onFocus={editGuard.onFocusField("certChargeDefault")}
                onChange={(e) => patchDraft({ certChargeDefault: e.target.value })}
                onBlur={blurDecimal("certChargeDefault")}
                onKeyDown={enterDecimal("certChargeDefault")}
                className={`${INPUT_COMPACT} w-40 text-right disabled:cursor-not-allowed disabled:bg-surface-50`}
              />
            </label>
            </div>
          </section>
        ),
        statement: (
          <section className="mb-6 max-w-2xl">
            <h2 className="mb-2 font-medium">Statement finance charge</h2>
            <div className={CARD_FLUSH}>
            <label className="flex items-center justify-between border-b p-2 text-sm last:border-0">
              <span>Monthly rate (%){savedMark("financeChargeRate", "Monthly rate (%)")}</span>
              <input aria-label="Monthly rate (%)"
                value={cfg.financeChargeRate ?? ""}
                inputMode="decimal"
                placeholder="1.5000"
                disabled={canEdit.disabled}
                title={canEdit.title}
                onFocus={editGuard.onFocusField("financeChargeRate")}
                onChange={(e) => patchDraft({ financeChargeRate: e.target.value })}
                onBlur={blurDecimal("financeChargeRate")}
                onKeyDown={enterDecimal("financeChargeRate")}
                className={`${INPUT_COMPACT} w-40 text-right disabled:cursor-not-allowed disabled:bg-surface-50`}
              />
            </label>
            </div>
          </section>
        ),
      }} />
      <p className="mt-3 text-xs text-ink-500">
        Plant-wide billing defaults. Values save as soon as they change; an invalid value is
        rejected with a message and nothing is stored.
      </p>
    </div>
  );
}
