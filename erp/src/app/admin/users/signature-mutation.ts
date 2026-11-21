// The Users page's optimistic signature-row update (#171). It lives outside page.tsx because a page
// may export only what Next allows: Next's generated dev route types reject any other value export,
// which fails `npx tsc --noEmit` after a `next dev` run (#209).

/**
 * The optimistic row update the signature control drives on a successful mutation (#171). Flip the
 * existence flag AND — on an UPLOAD — advance `signatureRev` to `now`, so the preview URL cache-busts
 * IMMEDIATELY, independent of whether the trailing list reload lands: a PUT that commits while its
 * follow-up list GET fails must not strand a just-replaced preview as "Preview unavailable" (the
 * review's one confirmed finding). The reload then reconciles `signatureRev` to the server's true
 * stamp. A CLEAR leaves the rev untouched — no preview renders while the flag is false. The PAGE is
 * the single owner of both fields (the control keeps neither), so this is NOT the per-session counter
 * #171 retired; it is the same optimistic-apply-then-reload discipline the rest of this page uses.
 */
export function applySignatureMutation<T extends { hasSignature: boolean; signatureRev: number | null }>(
  row: T, next: boolean, now: number,
): T {
  return { ...row, hasSignature: next, signatureRev: next ? now : row.signatureRev };
}
