import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createRef } from "react";
import ts from "typescript";
import { FileChooser } from "@/components/FileChooser";
import { DismissChecklistView } from "@/app/setup/SetupChecklist";
import { gate, type Gate } from "@/lib/permission-ui";
import { moveGate } from "@/lib/reorder";
import { addSuggestionRefusal } from "@/lib/suggestion-names";

/**
 * #239 MR D — the administration screens. Eight rules that nothing else in the gate set can see:
 * `tsc` and `eslint` read neither class strings nor rendered words, and every one of these
 * defects renders as a perfectly valid page.
 *
 * Two are proved by RENDER and the rest by a source pin, and the split is forced rather than
 * chosen (the `row-controls.test.tsx` precedent from MR C). `FileChooser` and
 * `DismissChecklistView` are hook-free and props-in/markup-out, so vitest's `environment: "node"`
 * renders them with `renderToStaticMarkup` — the `SetupBannerView` recipe. The list rows on the
 * five master-detail screens arrive from a landed fetch inside a `"use client"` page component
 * that SSR never resolves, so it renders zero rows and those rules cannot be reached that way at
 * all; they are pinned at the source, the `rail-fit` precedent, and mutation-checked exactly as a
 * rendered assertion is.
 */
const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), "utf8");

// ------------------------------------------------------------------------------------------------
// C3b — the one shared file-input control
// ------------------------------------------------------------------------------------------------

describe("FileChooser — the shared styled file input (C3b)", () => {
  function markup(over: Partial<Parameters<typeof FileChooser>[0]> = {}) {
    return renderToStaticMarkup(
      <FileChooser inputRef={createRef<HTMLInputElement>()} disabled={false} onChange={() => {}}
        {...over} />,
    );
  }

  /**
   * The hidden-input contract, and why each half of it is load-bearing.
   * `e2e/flows/attachment-filenames.mjs` uploads a real file through
   * `section.locator('input[type="file"]').setInputFiles(...)`, and
   * `e2e/flows/templates-admin.mjs` through `getByLabel("Upload logo image")`. Both drive the
   * INPUT; both keep working only while the input still exists, still answers those selectors and
   * is merely hidden rather than removed or `display:none`.
   */
  it("keeps a real <input type=\"file\"> in the DOM — the selector both e2e flows use", () => {
    expect(markup()).toContain('type="file"');
  });

  it("hides it VISUALLY, never with display:none and never by dropping it", () => {
    const html = markup();
    // sr-only clips to a 1px box while leaving the element rendered, focusable and settable.
    expect(html).toMatch(/<input[^>]*class="sr-only"/);
    expect(html).not.toContain("display:none");
    expect(html).not.toContain("hidden=");
  });

  it("wraps the input in the label, so a click on the button opens the picker with no handler", () => {
    // A <label> with a nested control forwards activation itself. The alternative — a <button>
    // calling input.click() — is a second activation path that can silently stop matching the
    // first.
    expect(markup()).toMatch(/<label[^>]*>[\s\S]*<input[^>]*type="file"[\s\S]*<\/label>/);
  });

  it("makes keyboard focus visible on the label, which a 1px-clipped input's own ring is not", () => {
    expect(markup()).toContain("focus-within:ring-2");
  });

  it("carries each caller's accept and aria-label through unchanged", () => {
    const html = markup({ accept: "image/png,image/jpeg", ariaLabel: "Upload logo image" });
    expect(html).toContain('accept="image/png,image/jpeg"');
    expect(html).toContain('aria-label="Upload logo image"');
  });

  it("omits aria-label entirely where the caller had none, rather than inventing one", () => {
    // aria-label wins the accessible-name computation outright, so a default here would have
    // silently renamed the logo input that templates-admin.mjs finds by name.
    expect(markup()).not.toContain("aria-label");
  });

  it("replaces the native status text, which the browser drew and our width clipped", () => {
    expect(markup()).toContain("No file chosen");
  });

  it("keeps the §5.16 disabled-with-a-reason tooltip and disables the input itself", () => {
    const html = markup({ disabled: true, title: "Requires manage_users" });
    expect(html).toContain('title="Requires manage_users"');
    expect(html).toMatch(/<input[^>]*disabled/);
    // globals.css's muting rule is `button:disabled`, and this control is a label — so the
    // disabled appearance has to be stated here or it simply does not exist.
    expect(html).toContain("cursor-not-allowed");
  });

  it("offers hover feedback only while it is actually clickable", () => {
    expect(markup()).toContain("hover:bg-surface-50");
    expect(markup({ disabled: true })).not.toContain("hover:bg-surface-50");
  });
});

describe("the three upload sites all render the shared control (C3b)", () => {
  const sites = {
    "components/AttachmentsSection.tsx": read("components/AttachmentsSection.tsx"),
    "components/UserSignatureControl.tsx": read("components/UserSignatureControl.tsx"),
    "app/admin/templates/[id]/edit/LogoPanel.tsx": read("app/admin/templates/[id]/edit/LogoPanel.tsx"),
  };

  it("leaves no raw type=\"file\" input anywhere in src/", () => {
    for (const [name, src] of Object.entries(sites)) {
      expect(`${name}: ${src.includes('type="file"')}`).toBe(`${name}: false`);
    }
  });

  it("each one mounts FileChooser and still owns its own input ref for the post-upload reset", () => {
    for (const [name, src] of Object.entries(sites)) {
      expect(`${name}: ${src.includes("<FileChooser")}`).toBe(`${name}: true`);
      expect(`${name}: ${/inputRef=\{file(Input)?Ref\}/.test(src)}`).toBe(`${name}: true`);
    }
  });
});

// ------------------------------------------------------------------------------------------------
// C7b — a dismissed checklist is a status, not a disabled action
// ------------------------------------------------------------------------------------------------

describe("the setup checklist's footer (C7b)", () => {
  type EditGate = { allowed: boolean; title: string | undefined };
  const ALLOWED: EditGate = { allowed: true, title: undefined };
  const REFUSED: EditGate = { allowed: false, title: "Requires admin.edit" };
  const render = (dismissed: boolean, editGate = ALLOWED, busy = false) =>
    renderToStaticMarkup(
      <DismissChecklistView dismissed={dismissed} busy={busy} editGate={editGate}
        onDismiss={() => {}} />,
    );

  it("renders the dismissal as status text, with no button at all", () => {
    const html = render(true);
    expect(html).toContain("Checklist dismissed");
    expect(html).not.toContain("<button");
  });

  it("renders the ACTION while the checklist has not been dismissed", () => {
    const html = render(false);
    expect(html).toContain("<button");
    expect(html).toContain("Dismiss checklist");
    expect(html).not.toContain("Checklist dismissed");
  });

  /**
   * The reason the two states had to become two elements. `disabled` is also how §5.16 renders a
   * missing `admin.edit`, so while both states shared one button the screen said exactly the same
   * thing about "this installation is already set up" and "you may not do this" — and a read-only
   * admin could not tell which they were looking at.
   */
  it("no longer renders a dismissed checklist the same way as a refused permission", () => {
    expect(render(true)).not.toContain("disabled");
    expect(render(false, REFUSED)).toContain("disabled");
    expect(render(false, REFUSED)).toContain("Requires admin.edit");
  });

  it("still disables the action while a write is in flight", () => {
    expect(render(false, ALLOWED, true)).toContain("disabled");
  });
});

// ------------------------------------------------------------------------------------------------
// C10 — the surcharge list rows carry the facts the form beside them asks for
// ------------------------------------------------------------------------------------------------

describe("the surcharge list rows (C10)", () => {
  const src = read("app/admin/surcharges/page.tsx");

  it("shows the kind and its value, formatted per kind", () => {
    expect(src).toContain("{SURCHARGE_KIND_LABELS[r.kind]}");
    expect(src).toContain("{surchargeRateText(r)}");
  });

  it("keeps the needs-GL marker it already carried; Active says the rest (PR 11)", () => {
    expect(src).toContain(">needs GL</span>");
  });
});

// ------------------------------------------------------------------------------------------------
// P3a — "bills at the plant rate", branched by kind at all three sites
// ------------------------------------------------------------------------------------------------

describe("the plant-default sentences (P3a)", () => {
  const sites = {
    "app/customers/[id]/SurchargeOverridesSection.tsx": read("app/customers/[id]/SurchargeOverridesSection.tsx"),
    "app/admin/surcharges/page.tsx": read("app/admin/surcharges/page.tsx"),
  };

  /** Only the SENTENCES. The percent branch's own `placeholder="plant rate"` is correct and stays
   *  — it renders on a PERCENT row and nowhere else, which is the whole point of the item. */
  it("no sentence states a plant RATE unconditionally any more", () => {
    for (const [name, src] of Object.entries(sites)) {
      expect(`${name}: ${src.includes("bills at the plant rate")}`).toBe(`${name}: false`);
      expect(`${name}: ${src.includes("the plant rate instead")}`).toBe(`${name}: false`);
    }
  });

  it("all three compose the noun through the shared branch", () => {
    // Two on the customer page (the no-override line and the Clear confirm), one in the admin
    // page's own Clear-override confirm. Counted so a second site cannot be left behind.
    expect(sites["app/customers/[id]/SurchargeOverridesSection.tsx"]
      .split("plantDefaultNoun(").length - 1).toBe(2);
    expect(sites["app/admin/surcharges/page.tsx"]
      .split("plantDefaultNoun(").length - 1).toBe(1);
  });

  it("each call is given the KIND of the surcharge it is talking about, not a constant", () => {
    expect(sites["app/customers/[id]/SurchargeOverridesSection.tsx"])
      .toContain("plantDefaultNoun(row.kind)");
    expect(sites["app/admin/surcharges/page.tsx"]).toContain("plantDefaultNoun(kind)");
    expect(sites["app/admin/surcharges/page.tsx"]).toContain("blocked.row.kind");
  });
});

// ------------------------------------------------------------------------------------------------
// P3b — the users help text says what the screen does
// ------------------------------------------------------------------------------------------------

describe("the users screen's help text (P3b)", () => {
  const src = read("app/admin/users/page.tsx");

  it("drops the roadmap sentence", () => {
    expect(src).not.toContain("in a later phase");
    expect(src).not.toContain("the API already supports them");
  });

  it("keeps the fact that is about this screen, and describes it", () => {
    expect(src).toContain("Users are never deleted — deactivate instead");
    expect(src).toContain("This screen assigns each user a role");
  });
});

// ------------------------------------------------------------------------------------------------
// L4c / S2a / S2b / S2c — the five master-detail list columns
// ------------------------------------------------------------------------------------------------

const LISTS = {
  roles: "app/admin/roles/page.tsx",
  surcharges: "app/admin/surcharges/page.tsx",
  "step codes": "app/admin/step-codes/page.tsx",
  "pick lists": "app/admin/reference/page.tsx",
  templates: "app/admin/templates/page.tsx",
} as const;

describe("the master-detail list columns (S2a, S2b, S2c, L4c)", () => {
  const sources = Object.fromEntries(
    Object.entries(LISTS).map(([screen, file]) => [screen, read(file)]),
  ) as Record<keyof typeof LISTS, string>;

  // Step codes left this family in PR 9 (owner 2026-11-01 on #824): its list is the Codes tab's
  // table, so the list column's width and <ul> no longer apply; its hover rules still do. Roles
  // left it in PR 12 (owner 2026-11-02 on #827), the same way.
  it("S2c — all four columns are the same width", () => {
    for (const [screen, src] of Object.entries(sources)) {
      if (screen === "step codes" || screen === "surcharges" || screen === "roles") continue;
      expect(`${screen}: ${/className="w-72 shrink-0/.test(src)}`).toBe(`${screen}: true`);
    }
  });

  /** The exact strings the three drifted columns shipped with — named per screen rather than as a
   *  bare token sweep, because `w-64` is also a perfectly good width for a text input inside a
   *  detail pane and this rule is about the LIST column only. */
  it("S2c — none of the three drifted columns survives", () => {
    const stale = {
      roles: 'className="w-64"',
      "pick lists": 'className="w-56 shrink-0',
      templates: 'className="w-80 shrink-0',
    } as const;
    for (const [screen, old] of Object.entries(stale)) {
      expect(`${screen}: ${sources[screen as keyof typeof LISTS].includes(old)}`)
        .toBe(`${screen}: false`);
    }
  });

  /**
   * S2a names the five admin lists whose rows are the same kind of clickable row `BoardTable.tsx`
   * already gives hover feedback to. It is applied ONLY while the row is
   * not the selected one: the selected `<li>` is `bg-link-50` (the redesign's light blue; commit
   * 1d5e9be9 had folded `bg-slate-100` and `bg-slate-50` into one `bg-surface-50`, which left the
   * selected row and a hovered one the same grey), and a hover fill painted over it by the button
   * on top would make the selection read as changing under the pointer.
   */
  it("S2a — the five named selectors offer hover feedback", () => {
    for (const screen of ["roles", "surcharges", "step codes", "pick lists", "templates"] as const) {
      expect(`${screen}: ${sources[screen].includes("hover:bg-surface-50")}`).toBe(`${screen}: true`);
    }
  });

  it("S2a — the hover never fights the selected row's own background", () => {
    for (const screen of ["roles", "surcharges", "step codes", "pick lists", "templates"] as const) {
      expect(`${screen}: ${/\? (?:""|"bg-link-50") : "hover:bg-surface-50"/.test(sources[screen])}`)
        .toBe(`${screen}: true`);
    }
  });

  it("S2b — the roles list reads at the same size as its four siblings", () => {
    for (const [screen, src] of Object.entries(sources)) {
      if (screen === "templates" || screen === "step codes" || screen === "surcharges" || screen === "roles") continue; // the first's <ul>s are labelled per document type, the others are tables
      expect(`${screen}: ${/<ul (?:ref=\{listRef\} )?className="[^"]*\btext-sm\b/.test(src)}`).toBe(`${screen}: true`);
    }
    expect(/<ul aria-label=\{docTypeName\(docType\)\} className="[^"]*\btext-sm\b/
      .test(sources.templates)).toBe(true);
  });

  it("L4c — the pick-list column stops stretching to the detail's height", () => {
    // A flex row's default `align-items: stretch` made this <ul> as tall as the selected pick
    // list's table, so its border ran on below the last kind around empty white.
    //
    // Asserted against the WHOLE className, not the bare utility: the first version of this case
    // checked for the token anywhere in the file, and the file's own comment contained it — so
    // the rule stayed green with the class deleted from the markup. Found by mutation, which is
    // the only thing that could have found it.
    expect(sources["pick lists"])
      .toContain('<ul ref={listRef} className="w-72 shrink-0 self-start divide-y rounded border bg-surface-0 text-sm">');
  });
});

// ------------------------------------------------------------------------------------------------
// Process step codes — suggested parameters (spec 2026-09-26 §3.2–§3.3)
// ------------------------------------------------------------------------------------------------

/**
 * A saved suggestion's type and unit never change in place: a part row copied from it carries its
 * ID as the key, so the server refuses the change (`syncStepFields`). The rows arrive from a fetch
 * SSR never resolves, so these are source pins like the list-column rules above, each asserted
 * against the whole element rather than a token a comment could also hold.
 */
describe("step codes — suggested parameters (spec 2026-09-26 §3.2)", () => {
  const src = read("app/admin/step-codes/page.tsx");
  const prose = src.replace(/\s+/g, " ");

  it("names the section and says what a suggestion is and how its type or unit changes", () => {
    expect(src).toContain('<h3 className="mb-2 font-medium">Suggested parameters</h3>');
    expect(src).not.toContain("Fields a step of this kind asks for");
    expect(prose).toContain("Copied onto a new step of this code, in this order and with empty values. "
      + "Editing a suggestion never changes a part&apos;s saved steps. To change a suggestion&apos;s type "
      + "or unit, remove it and add a new one.");
  });

  // #650: the queued transforms find their row by id; an index captured at click is stale by
  // the time the op runs (after the previous op's reload). Drafts and focus notes share the
  // rendered rows' key space (#288): the code and the suggestion's id.
  it("every suggestion control passes the row's id, never its render index, and label drafts are keyed by that id", () => {
    expect(src).toContain('<tr key={f.id} className="border-t">');
    expect(src).toContain("draftValue(fieldLabelDraftKey(current.id, f.id), f.label)");
    expect(src).toContain("noteFocus(focus.current, fieldLabelDraftKey(current.id, f.id), e.target.value)");
    expect(src).toContain("[fieldLabelDraftKey(current.id, f.id)]: e.target.value");
    expect(src).toContain("leaveSave(fieldLabelDraftKey(current.id, f.id), e.target.value, (value) => commitLabel(current.id, f.id, value), trimmedText)");
    expect(src).toContain("enterSave(e, fieldLabelDraftKey(current.id, f.id), (value) => commitLabel(current.id, f.id, value), trimmedText)");
    expect(src).toContain("moveField(current.id, f.id, -1)");
    expect(src).toContain("moveField(current.id, f.id, 1)");
    expect(src).toContain("removeField(current.id, f.id)");
    expect(src).not.toContain("${current.id}.${i}");
    expect(src).not.toContain("key={f.id ?? i}");
  });

  it("a saved suggestion's type and unit are always disabled, and say why (§5.16)", () => {
    expect(src).toContain('const FIXED_TYPE_AND_UNIT = "Remove and re-add to change the type or unit";');
    expect(prose).toContain("<select value={f.type} disabled title={FIXED_TYPE_AND_UNIT} className=");
    expect(prose).toContain('<input value={f.unit ?? ""} disabled title={FIXED_TYPE_AND_UNIT} className=');
  });

  // The controls under the heading use its words — a parameter's name, a suggestion — as the part
  // editor and the manual do, not the "field" wording the screen had before (Task 4 review).
  it("names a suggestion's controls as parameters and suggestions, never as fields", () => {
    expect(src).toContain('<thead><tr className="text-left"><th>Name</th><th>Type</th><th>Unit</th><th /></tr></thead>');
    expect(src).toContain('setError("Parameter name is required");');
    expect(src).toContain('aria-label="Move suggestion up"');
    expect(src).toContain('aria-label="Move suggestion down"');
    expect(prose).toContain('placeholder="Parameter name"');
    expect(prose).toContain("> Add parameter suggestion </button>");
    expect(prose).toContain("Select a process step code to view its settings and suggested parameters.");
    expect(src).not.toMatch(/Field label|Move field|Add field|settings and fields/);
  });

  /**
   * #363, §5.16: an ↑/↓ disabled because its suggestion is already at that end of the list says
   * so, and the permission reason still wins for a user who cannot edit at all — the order the part
   * editor's ⋮ menu uses (`ProcessStepTable.tsx`). Each button's own `disabled` and `title`, the
   * `moveGate` spread, are found by its aria-label and EXECUTED for a row (the `task-8-callbacks`
   * technique) rather than matched as text, which would only restate what the expression says, not
   * what it yields on the first, a middle and the last row.
   */
  describe("the ↑/↓ controls say why they are disabled (#363)", () => {
    const file = ts.createSourceFile("page.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function control(label: string) {
      const found: ts.JsxAttributes[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isJsxAttributes(node) && node.properties.some((p) => ts.isJsxAttribute(p)
          && p.name.getText(file) === "aria-label" && p.initializer?.getText(file) === `"${label}"`)) {
          found.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      expect(found, label).toHaveLength(1);
      // Since #395 the pair comes from `moveGate`, spread onto the button; a `disabled` or `title`
      // written beside the spread would override it, or be overridden by it.
      const named = found[0].properties.filter(ts.isJsxAttribute).map((p) => p.name.getText(file));
      expect(named, label).not.toContain("disabled");
      expect(named, label).not.toContain("title");
      const spreads = found[0].properties.filter(ts.isJsxSpreadAttribute);
      expect(spreads, label).toHaveLength(1);
      const code = ts.transpileModule(`return (${spreads[0].expression.getText(file)});`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
      }).outputText;
      const spread = new Function("moveGate", "canEdit", "i", "current", code) as
        (helper: typeof moveGate, canEdit: Gate, i: number, current: object) => unknown;
      return (canEdit: Gate, i: number, count: number) => {
        const current = { fields: Array.from({ length: count }, (_, n) => ({ label: `P${n}` })) };
        return spread(moveGate, canEdit, i, current);
      };
    }
    const up = control("Move suggestion up");
    const down = control("Move suggestion down");
    const editor = gate(["admin.edit"], "admin.edit");
    const viewer = gate(["admin.view"], "admin.edit");

    it("the first suggestion's ↑ reads \"Already first\" and the last one's ↓ \"Already last\"", () => {
      expect(up(editor, 0, 3)).toEqual({ disabled: true, title: "Already first" });
      expect(down(editor, 2, 3)).toEqual({ disabled: true, title: "Already last" });
      // A lone suggestion is at both ends.
      expect(up(editor, 0, 1)).toEqual({ disabled: true, title: "Already first" });
      expect(down(editor, 0, 1)).toEqual({ disabled: true, title: "Already last" });
    });

    it("an enabled ↑ or ↓ carries no title", () => {
      for (const [move, i] of [[down, 0], [up, 1], [down, 1], [up, 2]] as const) {
        expect(move(editor, i, 3)).toEqual({ disabled: false, title: undefined });
      }
    });

    it("without admin.edit every ↑ and ↓ names the permission, the end rows included", () => {
      for (let i = 0; i < 3; i++) {
        expect(up(viewer, i, 3)).toEqual({ disabled: true, title: "Requires admin.edit" });
        expect(down(viewer, i, 3)).toEqual({ disabled: true, title: "Requires admin.edit" });
      }
    });
  });

  /**
   * #396, §5.16: Add parameter suggestion did nothing for an empty name and said nothing. It is disabled
   * until the name holds more than whitespace (owner ruling 2026-10-01) and says what it needs; the
   * permission reason still wins, as for the ↑/↓ above. The button's own `disabled`, `title` and
   * `onClick` expressions are EXECUTED for a typed name, the #363 technique.
   */
  describe("Add parameter suggestion says why it is disabled, and never adds a blank name (#396)", () => {
    const file = ts.createSourceFile("page.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const buttons: ts.JsxElement[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === "button"
        && node.children.map((c) => c.getText(file)).join("").trim() === "Add parameter suggestion") buttons.push(node);
      ts.forEachChild(node, visit);
    };
    visit(file);
    // The page's one <AddField>: its `disabled` and `title` props are what the button receives.
    const mounts: ts.JsxSelfClosingElement[] = [];
    const visitMounts = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === "AddField") mounts.push(node);
      ts.forEachChild(node, visitMounts);
    };
    visitMounts(file);
    /** What is typed in the Add row, and the names the selected code's suggestions already have. */
    type Typed = { label: string; unit?: string; type?: string; existing?: string[] };
    function evaluate<T>(attributes: ts.JsxAttributes, name: string, bindings: Record<string, unknown>): T {
      const attribute = attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(file) === name);
      const expression = attribute && ts.isJsxAttribute(attribute) && attribute.initializer
        && ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : undefined;
      expect(expression, name).toBeDefined();
      const code = ts.transpileModule(`return (${expression!.getText(file)});`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
      }).outputText;
      return new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as T;
    }
    // The Add row's own button: since PR 9 the page header has one of the same name, which only
    // opens that row, and `AddField` is the row.
    const addRow = src.indexOf("function AddField(");
    function button() {
      const own = buttons.filter((b) => b.getStart(file) > addRow);
      expect(own).toHaveLength(1);
      return own[0].openingElement.attributes;
    }
    /** The code's saved names as the page's own `<AddField names=…>` passes them (#406). */
    const namesProp = (typed: Typed) => {
      expect(mounts).toHaveLength(1);
      const current = { fields: (typed.existing ?? []).map((label, n) => ({ id: `f${n}`, label })) };
      return evaluate<string[]>(mounts[0].attributes, "names", { current });
    };
    /** The button's `disabled` and `title` for a gate and a typed name, through the page's own
     *  `<AddField disabled=… title=…>`, so the gate reaches the button the way the page passes it. */
    const state = (canEdit: Gate, typed: Typed) => {
      expect(mounts).toHaveLength(1);
      const props = { disabled: evaluate(mounts[0].attributes, "disabled", { canEdit }), title: evaluate(mounts[0].attributes, "title", { canEdit }) };
      const bindings = { ...props, label: typed.label, names: namesProp(typed), addSuggestionRefusal };
      return { disabled: evaluate(button(), "disabled", bindings), title: evaluate(button(), "title", bindings) };
    };
    function click(typed: Typed) {
      const env = { label: typed.label, unit: typed.unit ?? "", type: typed.type ?? "NUMBER", names: namesProp(typed), addSuggestionRefusal,
        onAdd: vi.fn(), setLabel: vi.fn(), setUnit: vi.fn() };
      evaluate<() => void>(button(), "onClick", env)();
      return env;
    }
    const editor = gate(["admin.edit"], "admin.edit");
    const viewer = gate(["admin.view"], "admin.edit");

    it("is disabled with \"Enter a parameter name\" while the name is empty or only whitespace", () => {
      for (const label of ["", " ", "  \t "]) {
        expect(state(editor, { label }), JSON.stringify(label)).toEqual({ disabled: true, title: "Enter a parameter name" });
      }
    });

    it("is enabled, with no title, once the name holds a character", () => {
      for (const label of ["x", " x ", "Soak", " Soak "]) {
        expect(state(editor, { label }), JSON.stringify(label)).toEqual({ disabled: false, title: undefined });
      }
      // No gate hands an enabled control a title; bound here so the expression itself is what drops it.
      expect(state({ allowed: true, disabled: false, title: "not shown" }, { label: "Soak" }).title).toBeUndefined();
    });

    it("without admin.edit it names the permission, whether or not a name is typed", () => {
      for (const label of ["", " ", "Soak"]) {
        expect(state(viewer, { label }), JSON.stringify(label)).toEqual({ disabled: true, title: "Requires admin.edit" });
      }
    });

    it("a click adds nothing for a blank name, and adds a typed one trimmed, as a rename saves it", () => {
      // With and without a unit: the click's guard reads the name, not the unit.
      for (const label of ["", "   "]) for (const unit of ["", "min"]) {
        const blank = click({ label, unit });
        expect(blank.onAdd, JSON.stringify([label, unit])).not.toHaveBeenCalled();
        expect(blank.setLabel).not.toHaveBeenCalled();
      }
      const added = click({ label: "  Soak time ", unit: "min" });
      expect(added.onAdd.mock.calls).toEqual([[{ label: "Soak time", type: "NUMBER", unit: "min", sort: 0 }]]);
      expect(added.setLabel).toHaveBeenCalledWith(""); expect(added.setUnit).toHaveBeenCalledWith("");
      // A one-character name with no unit and another type is added too.
      expect(click({ label: "x", type: "TEXT" }).onAdd.mock.calls).toEqual([[{ label: "x", type: "TEXT", unit: null, sort: 0 }]]);
    });

    // #406: the server refuses a second suggestion of the same name. For a name the page is showing,
    // the row says so first, so that name is not sent, refused and cleared.
    it("is disabled, naming the suggestion, while the code already has one of that name (#406)", () => {
      const existing = ["Soak time", "Hold"];
      for (const label of ["Hold", "hold", " HOLD "]) {
        expect(state(editor, { label, existing }), JSON.stringify(label))
          .toEqual({ disabled: true, title: 'A suggested parameter named "Hold" already exists' });
      }
      // Inner spacing tells two names apart, and a name no suggestion has is free.
      for (const label of ["Soak  time", "Quench"]) {
        expect(state(editor, { label, existing }), JSON.stringify(label)).toEqual({ disabled: false, title: undefined });
      }
      // The permission's reason still wins.
      expect(state(viewer, { label: "Hold", existing })).toEqual({ disabled: true, title: "Requires admin.edit" });
    });

    // The tests above bind `names`, `disabled` and `title` by name. This is what ties those names
    // to the props: AddField takes each straight from its parameter and declares none again.
    it("AddField's button reads the props it is given: names, disabled, title and onAdd, none shadowed (#406)", () => {
      const components: ts.FunctionDeclaration[] = [];
      const find = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === "AddField") components.push(node);
        ts.forEachChild(node, find);
      };
      find(file);
      expect(components).toHaveLength(1);
      const [component] = components;
      expect(buttons).toHaveLength(2); // the header's, which only opens the row, and the row's
      expect(buttons[1].pos >= component.pos && buttons[1].end <= component.end, "the last is AddField's").toBe(true);
      expect(component.parameters).toHaveLength(1);
      const binding = component.parameters[0].name;
      expect(ts.isObjectBindingPattern(binding)).toBe(true);
      const taken = (binding as ts.ObjectBindingPattern).elements
        .filter((e) => !e.propertyName && !e.initializer && !e.dotDotDotToken).map((e) => e.name.getText(file));
      const declared: string[] = [];
      const scan = (node: ts.Node): void => {
        if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node))
          && node.name && ts.isIdentifier(node.name)) declared.push(node.name.text);
        ts.forEachChild(node, scan);
      };
      if (component.body) scan(component.body);
      for (const prop of ["names", "disabled", "title", "onAdd"]) {
        expect(taken, prop).toContain(prop);
        expect(declared, prop).not.toContain(prop);
      }
    });

    it("a click adds nothing for a name the code already has, and keeps what was typed (#406)", () => {
      const taken = click({ label: "hold", unit: "min", existing: ["Hold"] });
      expect(taken.onAdd).not.toHaveBeenCalled();
      expect(taken.setLabel).not.toHaveBeenCalled(); expect(taken.setUnit).not.toHaveBeenCalled();
      // The same name on a code without it is added.
      expect(click({ label: "hold", existing: ["Soak"] }).onAdd.mock.calls).toEqual([[{ label: "hold", type: "NUMBER", unit: null, sort: 0 }]]);
    });
  });
});

// ------------------------------------------------------------------------------------------------
// #636 — reset password, the roles delete reason, the Add rows under no permission
// ------------------------------------------------------------------------------------------------

/** The page's source parsed, with every JSX element it holds and every call it makes. */
function parsed(relative: string) {
  const sf = ts.createSourceFile(relative, read(relative), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const elements: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  const calls: ts.CallExpression[] = [];
  const functions = new Map<string, ts.FunctionDeclaration>();
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) elements.push(node);
    if (ts.isCallExpression(node)) calls.push(node);
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const attr = (el: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string): string | null => {
    const a = el.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === name);
    if (!a || !ts.isJsxAttribute(a) || !a.initializer) return null;
    return ts.isStringLiteral(a.initializer) ? a.initializer.text : a.initializer.getText(sf);
  };
  return { sf, elements, calls, functions, attr };
}

describe("Set password asks through the modal (#636, #827)", () => {
  const { calls } = parsed("app/admin/users/page.tsx");

  it("raises no prompt, so the new password is never shown in clear text", () => {
    expect(calls.filter((c) => c.expression.getText() === "prompt")).toEqual([]);
  });

  it("asks through the modal's password box", () => {
    const [ask] = calls.filter((c) => c.expression.getText() === "askPassword");
    expect(ask.getText()).toContain('label: "New password", confirm: "Set password"');
  });

  it("still invalidates the setup banner on the password write (#110)", () => {
    const [ask] = calls.filter((c) => c.expression.getText() === "askPassword");
    expect(ask.getText()).toContain("invalidatesSetup: true");
  });
});

describe("a role delete with a blank reason is refused before it is sent (#636)", () => {
  const { functions, sf } = parsed("app/admin/roles/page.tsx");

  it("holds the dialog in the service's own sentence, ahead of the request", () => {
    const body = functions.get("remove")!.body!.getText(sf);
    const ask = body.indexOf("blankRefusal: ROLE_DELETE_REASON_REQUIRED");
    expect(ask, "the blank sentence").toBeGreaterThan(-1);
    expect(ask).toBeLessThan(body.indexOf("api("));
  });
});

describe("an Add row's boxes close with its button under no permission (#636)", () => {
  // Every box an Add row types into writes its draft through one setter: each must carry the gate
  // the row's Add button takes, as step codes', surcharges', templates' and users' already do.
  it.each([
    ["components/ReferenceTable.tsx", "setDraft", "canCreate", 4],
    ["app/admin/part-fields/page.tsx", "setDraft", "canCreate", 3],
    ["app/admin/roles/page.tsx", "setNewName", "canEdit", 1],
  ])("%s", (file, setter, gateName, count) => {
    const { elements, attr } = parsed(file);
    const boxes = elements.filter((el) => ["input", "select", "textarea"].includes(el.tagName.getText())
      && (attr(el, "onChange") ?? "").includes(`${setter}(`));
    expect(boxes).toHaveLength(count);
    for (const box of boxes) {
      expect(attr(box, "disabled"), box.getText()).toBe(`{${gateName}.disabled}`);
      expect(attr(box, "title"), box.getText()).toBe(`{${gateName}.title}`);
    }
  });
});
