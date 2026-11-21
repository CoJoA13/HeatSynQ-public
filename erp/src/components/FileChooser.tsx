"use client";
import { useState, type ChangeEvent, type RefObject } from "react";

/**
 * The app's one styled file picker (#239 C3b). Three screens upload a file — part/order
 * attachments (`AttachmentsSection`), a user's signature (`UserSignatureControl`) and a document
 * template's logo (`LogoPanel`) — and all three rendered the browser's RAW `<input type="file">`.
 * A raw file input draws its own button and its own status text at a width the BROWSER picks and
 * ours then clips: at the users table's `w-32` the status read "No f…sen", and none of the three
 * matched any other control on the screen it sat on.
 *
 * **The shape is a `<label>` styled like the app's secondary button, wrapping the SAME
 * `<input type="file">`, visually hidden — `sr-only`, never `display:none` and never removed.**
 * That is the whole point, and each half of it is load-bearing:
 *
 *   - `e2e/flows/attachment-filenames.mjs` does a REAL upload through
 *     `section.locator('input[type="file"]').setInputFiles(...)`, and `templates-admin.mjs`
 *     through `getByLabel("Upload logo image")`. Playwright's `setInputFiles` performs no
 *     actionability checks, so it drives a visually hidden input exactly as it drove a visible
 *     one — but only while the input still EXISTS and still answers that selector. A picker
 *     rebuilt as a `<button>` that calls `input.click()` on a `display:none` input would satisfy
 *     neither, and the failure would arrive in CI as a locator timeout rather than as a design
 *     decision.
 *   - The input keeps its place in the tab order and its native keyboard activation. `sr-only`
 *     clips it to a 1px box, so its OWN focus ring is invisible; the label therefore carries
 *     `focus-within:` styling, which is what actually shows a keyboard user where they are.
 *   - Clicking the label opens the picker through the label's own control association. No click
 *     handler forwards anything, so there is no second activation path to keep in step.
 *
 * **The filename beside it is the native status text, replaced rather than merely hidden.** A
 * native file input says "No file chosen" until it holds a file and its name afterwards, and all
 * three callers clear `input.value` once the upload settles — which is what puts the native
 * control back to "No file chosen". So this reads the name off the input on change AND again once
 * the caller's handler has settled, which is exactly when that reset has happened (an async
 * handler's own `finally` runs before its promise does). No caller had to give up its ref or
 * change when it resets.
 *
 * Every caller keeps its own `accept`, its own `aria-label` where it had one, its own `title`
 * (the §5.16 disabled-with-a-reason tooltip) and its own change handler unchanged. `aria-label`
 * wins the accessible-name computation over a wrapping label's text, so `LogoPanel`'s name is
 * still "Upload logo image"; the two that had none gain this label's own words, which is an
 * improvement rather than a break.
 */
export function FileChooser({
  inputRef, accept, ariaLabel, disabled, title, onChange, label = "Choose file…",
}: {
  /** The caller's own ref — every one of the three resets `value` through it so that choosing the
   *  SAME file again still fires `change` (the DOM only fires it on a value transition). */
  inputRef: RefObject<HTMLInputElement | null>;
  accept?: string;
  /** Only where the caller already had one; an absent name falls back to this label's text. */
  ariaLabel?: string;
  disabled: boolean;
  /** §5.16: a blocked control is disabled WITH the reason, never hidden. */
  title?: string;
  /** The caller's existing handler, unchanged. Awaited only to re-read the input afterwards; a
   *  rejection propagates exactly as it did when React held this handler directly. */
  onChange: (event: ChangeEvent<HTMLInputElement>) => void | Promise<void>;
  label?: string;
}) {
  const [chosen, setChosen] = useState<string | null>(null);

  async function handleChange(event: ChangeEvent<HTMLInputElement>) {
    // `event.target`, not `event.currentTarget`: React nulls `currentTarget` once the handler
    // returns, and this one reads the element again after an await.
    const input = event.target;
    setChosen(input.files?.[0]?.name ?? null);
    try {
      await onChange(event);
    } finally {
      setChosen(input.files?.[0]?.name ?? null);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <label
        className={`inline-flex shrink-0 items-center rounded border px-3 py-1.5 text-sm ${
          disabled
            ? "cursor-not-allowed border-line bg-surface-50 text-ink-500"
            : "cursor-pointer bg-surface-0 hover:bg-surface-50 focus-within:ring-2 focus-within:ring-ink-500"
        }`}
        title={title}
      >
        {label}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          aria-label={ariaLabel}
          disabled={disabled}
          onChange={handleChange}
          className="sr-only"
        />
      </label>
      {/* Outside the label on purpose: inside, it would join the input's accessible name and
          change it every time a file is picked. */}
      <span className="min-w-0 break-all text-xs text-ink-500">{chosen ?? "No file chosen"}</span>
    </span>
  );
}
