// The Setup checklist's State column (the UX redesign PR 12, owner 2026-11-02 on #827). The numbers
// step has its own word because it is the one step confirmed here rather than done elsewhere; a
// blocking step reads Required because it gates order entry. Client-safe.
export function setupStateWord(step: { key: string; complete: boolean; blocking: boolean }): string {
  if (step.complete) return "Complete";
  if (step.key === "numbers") return "Needs confirmation";
  return step.blocking ? "Required" : "Not done";
}
