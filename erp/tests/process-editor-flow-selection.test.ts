import { expect, it } from "vitest";
import { selectProcessFlows } from "../e2e/lib/process-flow-selection.mjs";
const entryFlows = ["order-entry-workspace", "order-entry-workspace-races", "order-entry-workspace-recovery", "order-entry-workspace-print"];
const flows = ["typed-fields", "revision-cut", "permission-gating", "draft-recovery", "numbered-recipes", "backups", "process-traveler-editor", "order-entry-server-refusal", ...entryFlows, "insecure-origin", "weights-two-examples", "money-decimal-entry", "rates-decimal-entry", "pick-list-saves", "parts-certs-decimal-entry", "shipment-ship-to", "hub-invoice-reread", "shipment-reverse-reread", "invoice-step-pick"].map(name => ({ name }));
it("preserves the complete registered suite without a filter", () => {
  expect(selectProcessFlows(flows, undefined)).toBe(flows);
});
it("adds process dependencies once and preserves registered order", () => {
  expect(selectProcessFlows(flows, "process-traveler-editor,permission-gating").map((flow: { name: string }) => flow.name)).toEqual(["typed-fields", "revision-cut", "permission-gating", "process-traveler-editor"]);
});
it("refuses unknown, unsupported and empty subsets before starting a harness", () => {
  for (const selection of ["backups", "typo", "", ","]) expect(() => selectProcessFlows(flows, selection)).toThrow();
});
it("runs each owned entry acceptance group independently and preserves suite order", () => {
  for (const name of entryFlows) expect(selectProcessFlows(flows, name)).toEqual([{ name }]);
  expect(selectProcessFlows(flows, [...entryFlows].reverse().join(",")).map((flow: { name: string }) => flow.name)).toEqual(entryFlows);
});
it("runs the order-entry-server-refusal flow alone, since it keys its own parts and saves no order (#494, #546)", () => {
  expect(selectProcessFlows(flows, "order-entry-server-refusal")).toEqual([{ name: "order-entry-server-refusal" }]);
});
it("runs the insecure-origin flow alone, since it creates every record it touches (#348)", () => {
  expect(selectProcessFlows(flows, "insecure-origin")).toEqual([{ name: "insecure-origin" }]);
});
it("runs the weights-two-examples flow alone, since it reads nothing another flow leaves", () => {
  expect(selectProcessFlows(flows, "weights-two-examples")).toEqual([{ name: "weights-two-examples" }]);
});
it("runs the money-decimal-entry flow alone, since it creates every record it touches (#517)", () => {
  expect(selectProcessFlows(flows, "money-decimal-entry")).toEqual([{ name: "money-decimal-entry" }]);
});
it("runs the rates-decimal-entry flow alone, since it restores the one fixture figure it writes (#517)", () => {
  expect(selectProcessFlows(flows, "rates-decimal-entry")).toEqual([{ name: "rates-decimal-entry" }]);
});
it("runs the pick-list-saves flow alone, since it restores the one fixture figure it writes (#495)", () => {
  expect(selectProcessFlows(flows, "pick-list-saves")).toEqual([{ name: "pick-list-saves" }]);
});
it("runs the parts-certs-decimal-entry flow alone, since it keys its own order and writes no fixture figure (#517)", () => {
  expect(selectProcessFlows(flows, "parts-certs-decimal-entry")).toEqual([{ name: "parts-certs-decimal-entry" }]);
});
it("runs the shipment-ship-to flow alone, since it keys its own order and shipment and restores the role it narrows (#484)", () => {
  expect(selectProcessFlows(flows, "shipment-ship-to")).toEqual([{ name: "shipment-ship-to" }]);
});
it("runs the hub-invoice-reread flow alone, since it keys and ships its own order and writes no fixture figure (#568)", () => {
  expect(selectProcessFlows(flows, "hub-invoice-reread")).toEqual([{ name: "hub-invoice-reread" }]);
});
it("runs the shipment-reverse-reread flow alone, since it keys, ships and reverses its own shipment and writes no fixture figure (#581)", () => {
  expect(selectProcessFlows(flows, "shipment-reverse-reread")).toEqual([{ name: "shipment-reverse-reread" }]);
});
it("runs the invoice-step-pick flow alone, since it keys, ships and invoices its own order and writes no fixture figure (#587)", () => {
  expect(selectProcessFlows(flows, "invoice-step-pick")).toEqual([{ name: "invoice-step-pick" }]);
});
