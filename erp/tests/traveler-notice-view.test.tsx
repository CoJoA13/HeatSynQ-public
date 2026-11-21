import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildTravelerPrintRecord, serializeTravelerPrintRecord } from "@/lib/traveler-print-record";
import type { NoticeOrder, NoticePrint } from "@/lib/traveler-notice";
import { TravelerNoticeView } from "@/app/orders/[id]/TravelerNoticeView";
import { NOTICE } from "@/lib/ui-classes";

// The traveler notice's markup (design 2026-10-06, §10.3 "Shown"). WHEN it shows and what it says
// are the leaf's decisions (tests/traveler-notice.test.ts). That the summary mounts it, and that
// it is handed the print controller's own document list, is tests/order-summary-wiring.test.ts's.
// This file is the element alone. No DOM here (vitest runs in node). On the real page one flow
// reads the notice, e2e/flows/loads-after-print.mjs, and only as the sentence for an order of one
// load, found by its exact words inside the summary. There it shows after a saved load edit and
// again after a reload, stays when the load's quantity is put back while its weight still
// differs, and is gone after a reprint. No flow reads a sentence that names loads, or the
// element's role or colour: those are this file's and tests/traveler-notice.test.ts's.

const ENDING = "a quantity, a weight or the loads changed after it printed.";

function order(over: Partial<NoticeOrder> = {}): NoticeOrder {
  return {
    status: "OPEN", voided: false,
    lines: [{ position: 1, partId: "part-a", qty: 100, weight: 150 }],
    loads: [{ loadNumber: 1, qty: 100, weight: 150 }],
    ...over,
  };
}
/** An all-loads traveler print of `printed`, as the order's document list carries it. */
const print = (printed: NoticeOrder): NoticePrint => ({
  kind: "TRAVELER", loadNumber: null, travelerLoadNumbers: [],
  travelerPrintRecord: serializeTravelerPrintRecord(buildTravelerPrintRecord(printed, { mode: "all" })),
});
const render = (now: NoticeOrder, prints: NoticePrint[]) =>
  renderToStaticMarkup(<TravelerNoticeView order={now} prints={prints} />);

const asPrinted = order();
const reweighed = order({ loads: [{ loadNumber: 1, qty: 100, weight: 151 }] });

describe("the traveler notice's markup", () => {
  it("renders nothing while the order is as it printed", () => {
    expect(render(asPrinted, [print(asPrinted)])).toBe("");
  });

  it("renders nothing before the document list has arrived: an empty list is no print", () => {
    expect(render(reweighed, [])).toBe("");
  });

  it("is one amber status paragraph whose whole text is the sentence", () => {
    expect(render(reweighed, [print(asPrinted)])).toBe(
      `<p role="status" class="${NOTICE.warning}">`
      + `The printed traveler is out of date: ${ENDING}</p>`);
  });

  it("names the loads on an order of several", () => {
    const three = order({ loads: [
      { loadNumber: 1, qty: 50, weight: 75 }, { loadNumber: 2, qty: 30, weight: 45 }, { loadNumber: 3, qty: 20, weight: 30 },
    ] });
    const corrected = { ...three, lines: [{ position: 1, partId: "part-a", qty: 32, weight: 150 }] };
    expect(render(corrected, [print(three)]).replace(/<[^>]+>/g, ""))
      .toBe(`The printed travelers for Loads 1, 2 and 3 are out of date: ${ENDING}`);
  });

  it("holds no link, no button and no heading: the print action is the summary's own button", () => {
    const html = render(reweighed, [print(asPrinted)]);
    expect(html).not.toMatch(/<(a|button|h[1-6])\b/);
  });

  it("renders nothing on a shipped order, and nothing on a voided one", () => {
    expect(render({ ...reweighed, status: "SHIPPED" }, [print(asPrinted)])).toBe("");
    expect(render({ ...reweighed, voided: true }, [print(asPrinted)])).toBe("");
  });
});
