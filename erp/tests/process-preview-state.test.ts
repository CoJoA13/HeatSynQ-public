import { expect, it } from "vitest";
import { acceptPreview, previewReducer, type PreviewIdentity } from "@/lib/process-preview-state";
const current: PreviewIdentity = { generation: 7, contextKey: "order:load2:read3", authorizationRevision: 4 };
it("only accepts the current generation, context read and authorization revision", () => {
  expect(acceptPreview(current, { ...current, generation: 6 })).toBe(false);
  expect(acceptPreview(current, { ...current, contextKey: "order:load1:read3" })).toBe(false);
  expect(acceptPreview(current, { ...current, authorizationRevision: 3 })).toBe(false);
  expect(acceptPreview(current, current)).toBe(true);
});
it("immediately removes a current result on changes and ignores stale completions", () => {
  const updating = previewReducer({ status: "unavailable" }, { type: "change", identity: current });
  expect(updating.status).toBe("updating");
  const ready = previewReducer(updating, { type: "ready", identity: current, url: "blob:one", pages: 2, templateName: "Standard", renderedAt: 123 });
  expect(ready.status).toBe("ready");
  const changed = previewReducer(ready, { type: "change", identity: { ...current, generation: 8 } });
  expect(changed.status).toBe("updating"); expect("url" in changed).toBe(false);
  expect(previewReducer(changed, { type: "ready", identity: current, url: "blob:old", pages: 1, templateName: "Old", renderedAt: 124 })).toEqual(changed);
  expect(previewReducer(changed, { type: "unavailable" })).toEqual({ status: "unavailable" });
});
