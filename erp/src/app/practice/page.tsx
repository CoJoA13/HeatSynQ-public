import { practiceMode } from "@/server/practice-mode";
import { PageHeader } from "@/components/PageHeader";
import { PracticeResetControl } from "./PracticeResetControl";

// Server component: resolves the practice flag SERVER-side (§8 — never read in a client component)
// and shows the reset control ONLY on the practice copy; production sees a plain notice. The control
// reads no user data, so the "pages that fetch must requireUser" rule does not bite — the reset
// route itself enforces admin + the db-identity guard.
export default async function PracticePage() {
  const isPractice = await practiceMode();
  return (
    <div className="p-6">
      <PageHeader title="Practice data" subtitle="A separate installation and database, never a live-mode toggle." />
      {isPractice ? (
        <PracticeResetControl />
      ) : (
        <p className="max-w-xl rounded bg-surface-50 p-3 text-sm text-ink-500">
          This is the production system. Resetting practice data is only available on the practice copy.
        </p>
      )}
    </div>
  );
}
