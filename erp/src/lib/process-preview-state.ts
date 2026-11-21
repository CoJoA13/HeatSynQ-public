export type PreviewIdentity = { generation: number; contextKey: string; authorizationRevision: number };
export function acceptPreview(expected: PreviewIdentity, received: PreviewIdentity): boolean {
  return expected.generation === received.generation && expected.contextKey === received.contextKey && expected.authorizationRevision === received.authorizationRevision;
}
export type PreviewState = { status: "unavailable" } | { status: "updating"; identity: PreviewIdentity } | { status: "error"; identity: PreviewIdentity; message: string } | { status: "ready"; identity: PreviewIdentity; url: string; pages: number; templateName: string; renderedAt: number };
type Action = { type: "unavailable" } | { type: "change"; identity: PreviewIdentity } | { type: "error"; identity: PreviewIdentity; message: string } | { type: "ready"; identity: PreviewIdentity; url: string; pages: number; templateName: string; renderedAt: number };
export function previewReducer(state: PreviewState, action: Action): PreviewState {
  if (action.type === "unavailable") return { status: "unavailable" };
  if (action.type === "change") return { status: "updating", identity: action.identity };
  if (!("identity" in state) || !acceptPreview(state.identity, action.identity)) return state;
  if (action.type === "error") return { status: "error", identity: action.identity, message: action.message };
  return { status: "ready", identity: action.identity, url: action.url, pages: action.pages, templateName: action.templateName, renderedAt: action.renderedAt };
}
