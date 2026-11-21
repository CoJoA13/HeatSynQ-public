// PREPARATION ONLY: proposed opt-in API; no shared runtime is changed.
import { describe, expect, it, vi } from "vitest";
import { createDraftStore, type Adapter } from "../src/lib/draft-store";

function fixture(optIn: boolean) {
  const settle = vi.fn(({ current }: { current: { data: string; baseline: string } }) =>
    ({ kind: "keep" as const, data: current.data, baseline: current.baseline, needsRefresh: true }));
  const adapter: Adapter<string, string, string, string> & { allowRejectedFollowUp?: boolean } = {
    kind: "phase-proposal", schema: "1", valid: (data, baseline) => typeof data === "string" && typeof baseline === "string",
    dirty: (data, baseline) => data !== baseline, baselineEqual: (a, b) => a === b,
    preview: data => [{ label: "Raw", value: data }], reconcileRead: ({ current }) => ({ data: current.data, baseline: current.baseline }), settle,
    ...(optIn ? { allowRejectedFollowUp: true } : {}),
  };
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "owner")!;
  const binding = store.bind({ owner, record: { kind: "template-phase", id: "owned" }, editor: adapter.kind }, { label: "Template", href: "/owned" }, adapter);
  binding.attach("lease"); const readId = binding.beginRead();
  binding.acceptRead({ kind: "authorized", readId, baseline: "saved", editable: true }, "saved");
  binding.change(() => "attempt"); const submission = binding.capture("attempt", "request"); binding.dispatched(submission);
  const note = () => (binding as typeof binding & { noteRejectedSubmission?: (value: typeof submission) => boolean }).noteRejectedSubmission?.(submission) ?? false;
  return { binding, submission, note, settle };
}

describe("proposed rejected-follow-up final outcome guards", () => {
  for (const kind of ["persisted", "unknown"] as const) it(`a marked refusal cannot settle ${kind}, then permits exactly one rejected final`, () => {
    const h = fixture(true); expect(h.note()).toBe(true);
    const marked = h.binding.getSnapshot();
    expect(marked).toEqual(expect.objectContaining({ submissionPhase: "rollback" }));
    h.binding.settle(h.submission, kind === "persisted" ? { kind, response: "ack" } : { kind });
    expect(h.binding.getSnapshot()).toBe(marked);
    expect(h.binding.getSnapshot().submitted).toBe(marked.submitted);
    expect(h.binding.getSnapshot()).toEqual(expect.objectContaining({ submissionPhase: "rollback" }));
    expect(h.settle).not.toHaveBeenCalled();
    expect(h.binding.getSnapshot().submitted?.data).toBe("attempt");
    h.binding.settle(h.submission, { kind: "rejected" });
    expect(h.settle).toHaveBeenCalledTimes(1);
    expect(h.settle.mock.calls[0][0]).toEqual(expect.objectContaining({ outcome: { kind: "rejected" } }));
    expect(h.binding.getSnapshot().submitted).toBeUndefined();
    const finalized = h.binding.getSnapshot();
    h.binding.settle(h.submission, { kind: "rejected" });
    expect(h.binding.getSnapshot()).toBe(finalized);
    expect(h.settle).toHaveBeenCalledTimes(1);
  });
  it("an opt-out adapter refuses the marker and preserves its existing unresolved view and settlement", () => {
    const h = fixture(false); const before = h.binding.getSnapshot();
    expect(h.note()).toBe(false); expect(h.binding.getSnapshot()).toBe(before);
    expect(h.binding.getSnapshot()).not.toHaveProperty("submissionPhase");
    h.binding.settle(h.submission, { kind: "persisted", response: "ack" });
    expect(h.binding.getSnapshot().submitted).toBeUndefined();
    expect(h.settle.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ outcome: { kind: "persisted", response: "ack" } }));
    expect(h.settle).toHaveBeenCalledTimes(1);
  });
});
