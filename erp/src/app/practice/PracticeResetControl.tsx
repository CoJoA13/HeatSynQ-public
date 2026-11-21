"use client";
import { useState } from "react";
import { api } from "@/lib/fetcher";
import { askConfirm } from "@/lib/modal";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { BUTTON_DANGER_FILL, CARD, NOTICE } from "@/lib/ui-classes";

// The practice-only "Reset practice data" control (Phase 8B §5.3). Rendered only in practice mode
// (its parent server page decides that). The reset route is fully guarded (admin + practiceMode +
// the in-request db-identity re-check), so this control is UX only — a mis-click on production would
// be refused server-side regardless.
export function PracticeResetControl() {
  // The reset route requires admin.edit; the banner links every signed-in operator here, so disable
  // the control (rather than let it deterministically 403) for anyone lacking it (Codex).
  // Until that read has answered the button stays disabled with no title (#678): while it is out
  // nothing is refused yet, and a failed read is named beside the control, never read as no grants
  // (the hook's own contract).
  const { permissions, error: permsError } = usePermissions();
  const editGate = gate(permissions, "admin.edit");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reset() {
    if (!await askConfirm({
      title: "Reset all practice data?",
      body: "Everything entered in this practice copy will be permanently replaced with the sample baseline. "
        + "Practice installation only. This signs you out because the practice sessions and users are reset.",
      confirm: "Reset practice data", danger: true,
    })) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api<{ ok: boolean }>("/api/practice/reset", { method: "POST", body: "{}" });
      // The reset truncated the current session + user rows and recreated admin/admin, so the shell
      // now holds stale auth — the next request would 401. Send the user to sign in again with the
      // reset credentials (Codex). A full navigation, since the session no longer exists server-side.
      setMessage("Practice data was reset. Signing you out — sign back in with admin / admin.");
      setTimeout(() => {
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full navigation: the session no longer exists server-side (above)
        window.location.href = "/login";
      }, 1500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${CARD} max-w-xl`}>
      <p className="mb-3 text-sm text-ink-500">
        Reset the practice database to a fresh demo baseline. Everything entered here is permanently
        erased and replaced with the sample data. This has no effect on the production system.
      </p>
      {permsError && <p className={`${NOTICE.refusal} mb-2`}>{permsError}</p>}
      {error && <p className={`${NOTICE.refusal} mb-2`}>{error}</p>}
      {message && <p className="mb-2 rounded bg-success-50 p-2 text-sm text-success-700">{message}</p>}
      <button
        type="button"
        disabled={busy || !editGate.allowed}
        title={permissions === undefined ? undefined : editGate.title}
        onClick={() => void reset()}
        className={BUTTON_DANGER_FILL}
      >
        {busy ? "Resetting…" : "Reset practice data"}
      </button>
    </div>
  );
}
