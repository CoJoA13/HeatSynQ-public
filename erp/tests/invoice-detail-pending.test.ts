import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { all } from "./helpers/source-lift";
import { jsxTags } from "./helpers/jsx-source";

// #651 (P11 step 1): Raise credit, Finalize and Recalculate had no pending state, so a double-click
// sent two POSTs: a second DRAFT credit with a credit number consumed for good, or a red refusal
// after a finalize or recalculate that had succeeded. Each now takes the page's one busy hold
// (`hold(kind)`, a ref checked first so a same-tick second click is refused, with state for the
// label), reads it in its `disabled=`, and reads its own label while held. Raise credit runs under
// the departure-attempt shape (tests/navigation-callers.test.ts). Mutation: drop `|| busy !== null`
// from a button, or `hold(` from an action, and its case reds. vitest renders no component, so these
// are source pins; the archival-gate sweep keeps `finalizeGate` and `recalcGate` in their `disabled=`.

const FILE = "src/app/invoicing/[id]/InvoiceDetail.tsx";
const file = fileURLToPath(new URL(`../${FILE}`, import.meta.url));
const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const action = (name: string) => {
  const found = all(source, ts.isFunctionDeclaration).filter((f) => f.name?.text === name);
  expect(found, name).toHaveLength(1);
  return found[0].getText(source);
};
const button = (label: string) => {
  const tags = jsxTags(FILE).filter((t) => t.name === "button" && (t.attr("onClick") ?? "").includes(label));
  expect(tags, label).toHaveLength(1);
  return tags[0];
};

describe("InvoiceDetail's one-shot writes hold the page busy (#651)", () => {
  // Since PR 6 Finalize is a header button and Recalculate and Create credit are ActionMenu items,
  // whose `disabled:` and label are object properties rather than attributes.
  it.each([["raiseCredit", "credit", "Creating…", "labels.credit", "creditGate"], ["recalculate", "recalc", "Recalculating…", "labels.recalculate", "recalcGate"]] as const)(
    "%s takes the hold before its request and its menu item reads busy", (name, kind, label, idle, gate) => {
      const text = action(name);
      expect(text).toContain(`hold("${kind}")`);
      expect(text.indexOf(`hold("${kind}")`)).toBeLessThan(text.indexOf("api<InvoiceMutationResult>"));
      expect(readFileSync(file, "utf8")).toContain(
        `{ label: busy === "${kind}" ? "${label}" : ${idle}, disabled: !${gate}.allowed || busy !== null, title: ${gate}.title, onSelect: () => void ${name}() }`,
      );
    },
  );

  it("finalize takes the hold before its request and its button reads busy", () => {
    const text = action("finalize");
    expect(text).toContain('hold("finalize")');
    expect(text.indexOf('hold("finalize")')).toBeLessThan(text.indexOf("api<InvoiceMutationResult>"));
    expect(button("finalize").attr("disabled")).toContain("|| busy !== null");
    expect(readFileSync(file, "utf8")).toContain('{busy === "finalize" ? "Finalizing…" : labels.finalize}');
  });

  it("the hold is a ref checked first, with state for the labels, and is released in finally by Finalize and Recalculate", () => {
    const text = readFileSync(file, "utf8");
    expect(text).toContain('const busyRef = useRef<InvoiceBusy>(null);');
    expect(text).toContain("function hold(kind: Exclude<InvoiceBusy, null>): boolean {");
    expect(text).toContain("if (busyRef.current !== null) return false;");
    for (const name of ["finalize", "recalculate"]) expect(action(name)).toContain("finally { release(); }");
    // Raise credit releases only when the push did not happen: a refusal, a cancelled departure's
    // re-read, or a push that threw.
    expect(action("raiseCredit")).not.toContain("finally");
  });
});
