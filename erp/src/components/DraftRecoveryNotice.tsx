"use client";
import type { EditorView } from "@/lib/draft-store";
import { CHECK_AGAIN, DRAFT_RECOVERY_MESSAGES } from "@/lib/draft-recovery-words";
import { NOTICE } from "@/lib/ui-classes";
export type DraftPreview = readonly Readonly<{ label: string; value: string }>[];
type Props = {
  submissionPhase?: "transport" | "rollback";
  mode: EditorView<unknown, unknown, unknown>["mode"]; canRestore: boolean;
  // Copy presence comes from authorized stamps, independently of preview validity.
  hasCurrent: boolean; hasReference: boolean;
  currentPreview?: DraftPreview; referencePreview?: DraftPreview; submittedPreview?: DraftPreview;
  restore: () => void; discard: () => void; discardReference?: () => void;
  startFresh?: () => void; retryRead: () => void; retrySubmission?: () => void;
};
function Preview({ title, values }: { title: string; values?: DraftPreview }) {
  if (!values?.length) return null;
  return <section className="mt-2 select-text"><h3 className="font-medium">{title}</h3>
    <dl>{values.map((field, index) => <div key={index}><dt className="text-xs text-ink-500">{field.label}</dt><dd className="whitespace-pre-wrap break-words">{field.value || "(blank)"}</dd></div>)}</dl>
  </section>;
}
export function DraftRecoveryNotice(props: Props) {
  const { mode, canRestore } = props;
  const rollback = props.submissionPhase === "rollback" && (mode === "pending" || mode === "editing");
  if (mode === "editing" && !props.hasReference && !rollback) return null;
  if (mode === "conflict" && !props.hasCurrent && !props.hasReference && !props.submittedPreview?.length && !props.submissionPhase) return null;
  if (mode === "completed") return null; // The owning editor renders all domain receipt details.
  const hidden = mode === "loading" || mode === "unavailable" || mode === "error";
  return <aside aria-label="Draft recovery" className={`${NOTICE.warning} my-3`}>
    <p role="status">{rollback ? "Save rejected; refreshing draft." : DRAFT_RECOVERY_MESSAGES[mode]}</p>
    {!hidden && <>
      <Preview title="Retained changes" values={props.currentPreview} />
      <Preview title="Earlier copy" values={props.referencePreview} />
      <Preview title="Originally submitted" values={props.submittedPreview} />
    </>}
    {(!hidden || mode === "error") && <div className="mt-2 flex flex-wrap gap-3">
        {!hidden && canRestore && <button type="button" onClick={props.restore}>Restore</button>}
        {props.hasCurrent && <button type="button" onClick={props.discard}>Discard retained changes</button>}
        {props.hasReference && props.discardReference && <button type="button" onClick={props.discardReference}>Dismiss earlier copy</button>}
        {props.startFresh && mode === "conflict" && <button type="button" onClick={props.startFresh}>Start fresh</button>}
        {props.retrySubmission && mode === "unknown" && <button type="button" onClick={props.retrySubmission}>Retry original submission</button>}
    </div>}
    {(hidden || mode === "unknown" || mode === "conflict" || mode === "blocked-two-copies") && <button type="button" className="mt-2 underline" onClick={props.retryRead}>{CHECK_AGAIN}</button>}
  </aside>;
}
