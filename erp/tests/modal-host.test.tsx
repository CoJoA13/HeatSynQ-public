import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ModalHost } from "@/components/ModalHost";
import { answerModal, askConfirm, askPassword, askReason, currentModal, sendPassword, _resetModalsForTests } from "@/lib/modal";
import { BUTTON_DANGER_FILL, BUTTON_NEUTRAL, BUTTON_PRIMARY, NOTICE } from "@/lib/ui-classes";

/**
 * ModalHost's markup (spec 2026-10-30 §4.3), rendered statically: `useSyncExternalStore` gives the
 * server snapshot under `renderToStaticMarkup`, and the host hands it the live request too, so the
 * markup test sees what the browser would. The `showModal()`/`close()` effect is browser-only.
 */
beforeEach(() => _resetModalsForTests());

describe("ModalHost", () => {
  it("renders an empty dialog while nothing is asked", () => {
    expect(renderToStaticMarkup(<ModalHost />)).toMatch(/^<dialog [^>]*><\/dialog>$/);
  });

  it("a confirm request: title, body, Cancel and the confirm button in the primary or danger fill", () => {
    void askConfirm({ title: "Re-split the loads?", body: "Containers has unsaved changes.", confirm: "Re-split" });
    const html = renderToStaticMarkup(<ModalHost />);
    expect(html).toContain("<h2");
    expect(html).toContain("Re-split the loads?");
    expect(html).toContain("Containers has unsaved changes.");
    expect(html).toContain(`class="${BUTTON_NEUTRAL}">Cancel</button>`);
    expect(html).toContain(`class="${BUTTON_PRIMARY}">Re-split</button>`);
    answerModal(currentModal()!.id, false);
    void askConfirm({ title: "Discard?", body: "", confirm: "Discard", danger: true });
    expect(renderToStaticMarkup(<ModalHost />)).toContain(`class="${BUTTON_DANGER_FILL}">Discard</button>`);
  });

  it("a reason request: the leaf's title, the box labelled with its body, and the refusal only after a blank answer", () => {
    void askReason({ question: "Void order #1001?", verb: "voiding", blankRefusal: "A reason is required to void an order." });
    const fresh = renderToStaticMarkup(<ModalHost />);
    expect(fresh).toContain("Void order #1001?");
    expect(fresh).toContain("Reason for voiding (recorded in the audit history):");
    expect(fresh).toContain('aria-invalid="false"');
    expect(fresh).not.toContain("A reason is required");
    expect(fresh).toContain(`class="${BUTTON_PRIMARY}">Continue</button>`);
    answerModal(currentModal()!.id, "  ");
    const blank = renderToStaticMarkup(<ModalHost />);
    expect(blank).toContain('aria-invalid="true"');
    expect(blank).toContain(`<div role="alert" class="${NOTICE.refusal} mt-2">A reason is required to void an order.</div>`);
  });

  it("a password request: a password box, the caller's button, and the refusal under the box", async () => {
    void askPassword({ title: "Set password for pat", label: "New password", confirm: "Set password", submit: async () => "Too short" });
    const fresh = renderToStaticMarkup(<ModalHost />);
    expect(fresh).toContain("Set password for pat");
    expect(fresh).toContain("New password");
    expect(fresh).toContain('type="password"');
    expect(fresh).toContain('autoComplete="new-password"');
    expect(fresh).toContain(`class="${BUTTON_PRIMARY}">Set password</button>`);
    expect(fresh).not.toContain("Too short");
    await sendPassword(currentModal()!.id, "x");
    expect(renderToStaticMarkup(<ModalHost />)).toContain(`<div role="alert" class="${NOTICE.refusal} mt-2">Too short</div>`);
  });

  it("a confirm's and a reason's box stay as they were: no password box", () => {
    void askReason({ question: "Void?", verb: "voiding", blankRefusal: "No." });
    expect(renderToStaticMarkup(<ModalHost />)).toContain('type="text"');
  });
});
