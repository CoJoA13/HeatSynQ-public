import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  UserSignatureControl, signaturePreview, signatureSrc,
} from "@/components/UserSignatureControl";
import { applySignatureMutation } from "@/app/admin/users/signature-mutation";
import type { Gate } from "@/lib/permission-ui";

/**
 * #171 — a failed signature preview must retry once the STORED image changes, whoever changed it.
 *
 * The old `version` counter bumped only on THIS browser's upload, so a corrupt image that failed to
 * render stayed suppressed forever after another admin cleared-and-replaced it (the flag round-trips
 * false→true while the URL never moved). The structural fix puts a SERVER revision (`signatureRev`,
 * User.signatureUpdatedAt via listUsers) in the URL, so the URL — and therefore the render-failure
 * key `brokenSrc` — moves on ANY change. This pins the decision function that expresses that; the
 * `<img> onError` click itself is Playwright's (no DOM env — the ReverseShipmentButton precedent).
 */

const ENABLED: Gate = { allowed: true, disabled: false, title: undefined };
const noop = () => {};

describe("signatureSrc — the preview URL carries the server revision", () => {
  it("embeds signatureRev as the ?v cache-bust token", () => {
    expect(signatureSrc("u1", 5)).toBe("/api/admin/users/u1/signature?v=5");
  });
  it("falls back to 0 for a null revision (never-stamped row)", () => {
    expect(signatureSrc("u1", null)).toBe("/api/admin/users/u1/signature?v=0");
  });
  it("a different revision yields a different URL", () => {
    expect(signatureSrc("u1", 5)).not.toBe(signatureSrc("u1", 6));
  });
});

describe("signaturePreview — the render decision (#171)", () => {
  const base = { userId: "u1", hasSignature: true, signatureRev: 100, brokenSrc: null as string | null };

  it("no signature → 'none', regardless of any stale broken key", () => {
    expect(signaturePreview({ ...base, hasSignature: false }).kind).toBe("none");
    expect(signaturePreview({ ...base, hasSignature: false, brokenSrc: signatureSrc("u1", 100) }).kind)
      .toBe("none");
  });

  it("signature present, nothing broken → image at the revisioned URL", () => {
    const p = signaturePreview(base);
    expect(p).toEqual({ kind: "image", src: signatureSrc("u1", 100) });
  });

  it("the CURRENT url having failed → broken (honest: there IS an image, it just won't render)", () => {
    const p = signaturePreview({ ...base, brokenSrc: signatureSrc("u1", 100) });
    expect(p.kind).toBe("broken");
  });

  it("a failure recorded at revision A does NOT suppress the preview at revision B — the #171 fix", () => {
    // Another admin cleared-and-replaced (or this browser re-uploaded): the revision moved A→B.
    const failedAtA = signatureSrc("u1", 100);
    const p = signaturePreview({ ...base, signatureRev: 101, brokenSrc: failedAtA });
    expect(p).toEqual({ kind: "image", src: signatureSrc("u1", 101) });
  });

  it("a failure recorded for another USER never suppresses this user's preview", () => {
    const p = signaturePreview({ ...base, brokenSrc: signatureSrc("other", 100) });
    expect(p.kind).toBe("image");
  });
});

describe("UserSignatureControl — the helper is actually wired into the render", () => {
  function markup(over: { hasSignature: boolean; signatureRev: number | null }) {
    return renderToStaticMarkup(
      <UserSignatureControl
        userId="u1" hasSignature={over.hasSignature} signatureRev={over.signatureRev}
        gate={ENABLED} onSignatureChange={noop} />,
    );
  }

  it("renders 'No signature' with no image when the flag is false", () => {
    const html = markup({ hasSignature: false, signatureRev: null });
    expect(html).toContain("No signature");
    expect(html).not.toContain("<img");
  });

  it("renders the preview <img> at the server-revisioned URL when the flag is true", () => {
    const html = markup({ hasSignature: true, signatureRev: 42 });
    expect(html).toContain(`src="${signatureSrc("u1", 42)}"`);
  });

  /**
   * C3a (#239) — Clear is a control for a row that HAS a signature.
   *
   * It used to render on every row, disabled where there was nothing on file, which is most of a
   * shop's staff: a permanently dead red link beside the words "No signature". §5.16's
   * disabled-with-a-tooltip rule is about a permission the caller lacks and still governs the
   * rows where Clear is real — but "there is nothing to clear" is not a permission, and rendering
   * it that way made the two reasons indistinguishable.
   */
  describe("the Clear control's presence (C3a)", () => {
    it("is absent on a row with no signature", () => {
      expect(markup({ hasSignature: false, signatureRev: null })).not.toContain(">Clear<");
    });

    it("is present, and enabled, on a row that has one", () => {
      const html = markup({ hasSignature: true, signatureRev: 42 });
      expect(html).toContain(">Clear<");
      expect(html).not.toContain("disabled");
    });

    it("stays disabled-with-a-reason where the gate refuses — presence and permission are different questions", () => {
      const blocked: Gate = { allowed: false, disabled: true, title: "Requires manage_users" };
      const html = renderToStaticMarkup(
        <UserSignatureControl userId="u1" hasSignature signatureRev={42} gate={blocked}
          onSignatureChange={noop} />,
      );
      expect(html).toContain(">Clear<");
      expect(html).toContain("Requires manage_users");
      expect(html).toContain("disabled");
    });
  });

  /**
   * C3b (#239) — the raw file input is gone from this row, and the shared control is what replaced
   * it. The users table clipped the browser's own status text to "No f…sen" at `w-32`.
   */
  it("uploads through the shared styled control, not a raw input", () => {
    const html = markup({ hasSignature: false, signatureRev: null });
    expect(html).toContain("Choose file…");
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/png,image/jpeg"');
    expect(html).not.toContain("w-32 text-xs");
  });
});

describe("applySignatureMutation — the page's optimistic rev bump (#171 review fix)", () => {
  const row = { id: "u1", hasSignature: true, signatureRev: 100 };

  it("an UPLOAD flips the flag and advances signatureRev to now (past the old rev)", () => {
    const out = applySignatureMutation(row, true, 200);
    expect(out.hasSignature).toBe(true);
    expect(out.signatureRev).toBe(200);
    expect(out.signatureRev!).toBeGreaterThan(row.signatureRev);
  });

  it("an UPLOAD advances the rev even from a null (never-stamped) row", () => {
    const out = applySignatureMutation({ hasSignature: false, signatureRev: null }, true, 200);
    expect(out).toEqual({ hasSignature: true, signatureRev: 200 });
  });

  it("a CLEAR flips the flag false and leaves the rev untouched (no preview renders)", () => {
    const out = applySignatureMutation(row, false, 999);
    expect(out).toEqual({ id: "u1", hasSignature: false, signatureRev: 100 });
  });

  it("preserves other row fields", () => {
    const out = applySignatureMutation({ ...row, username: "alice" }, true, 200);
    expect(out.username).toBe("alice");
  });

  it("a local upload heals a previously-broken preview WITHOUT any reload — the confirmed regression", () => {
    // A corrupt image failed to render at rev 100: brokenSrc is pinned to that URL.
    const brokenSrc = signatureSrc("u1", 100);
    expect(signaturePreview({ userId: "u1", hasSignature: true, signatureRev: 100, brokenSrc }).kind)
      .toBe("broken");

    // The user uploads a replacement. The page bumps the rev optimistically (now=200) — no list
    // reload has landed yet. The preview must already show the image, not "Preview unavailable".
    const bumped = applySignatureMutation({ id: "u1", hasSignature: true, signatureRev: 100 }, true, 200);
    const p = signaturePreview({ userId: "u1", hasSignature: bumped.hasSignature, signatureRev: bumped.signatureRev, brokenSrc });
    expect(p).toEqual({ kind: "image", src: signatureSrc("u1", 200) });
  });
});
