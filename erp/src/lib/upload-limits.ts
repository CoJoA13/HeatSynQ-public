// Client-safe leaf (#38, #687, #688): the caps, the allowed types and the refusal sentences of the
// three upload screens (attachments on a part or order, a user's signature, a template's logo). A
// client component must not import src/server/** (CLAUDE.md "Constraints that will bite you"), so
// the screens read this file, and the SERVER (`attachments.ts`, `users.ts`, `templates.ts`) reads
// the same file for its own checks, so the two halves cannot drift: tests/upload-limits.test.ts
// pins that each server module reads it rather than carrying a copy. Each screen checks before it
// builds the FormData, so a file that can only be refused is never uploaded, and shows the server's
// own words. The server's checks stay the enforcement; `accept` is only a hint.

/** The byte-length cap on any one attachment (src/server/attachments.ts's `MAX_SIZE`). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** The server's refusal for an oversized attachment, verbatim, or null when the size is acceptable. */
export function attachmentSizeError(bytes: number): string | null {
  return bytes > MAX_ATTACHMENT_BYTES ? "Attachments cannot exceed 20 MB" : null;
}

/** The attachment kinds, in the order the refusal names them: images and PDF render in a browser
 *  tab, the rest download. Widening this set takes a ruling (tests/attachments.test.ts pins it). */
export const ATTACHMENT_TYPES: readonly string[] = [
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf",
  "text/plain", "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
];

/** The attachment refusal (ruling R21, #687): the old words first, then the allowed kinds. */
export const ATTACHMENT_TYPE_REFUSAL =
  "That file type is not allowed. Attachments must be one of: PNG, JPEG, GIF, WebP, PDF, text, CSV, Word (.docx), Excel (.xlsx)";

/** The picker's `accept`: each MIME type and the extensions a dialog filters on. A hint only. */
export const ATTACHMENT_ACCEPT = [...ATTACHMENT_TYPES, ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".txt", ".csv", ".docx", ".xlsx"].join(",");

/** The server's refusal for a type outside the set, verbatim, or null when the type is allowed. */
export function attachmentTypeError(mimeType: string): string | null {
  return ATTACHMENT_TYPES.includes(mimeType) ? null : ATTACHMENT_TYPE_REFUSAL;
}

/** The signature and logo image types: png and jpeg, the ones pdfkit embeds (users.ts's history). */
export const IMAGE_UPLOAD_MIME = ["image/png", "image/jpeg"] as const;

/** 2 MB: small enough that an audit snapshot never carries it, large enough for a scanned signature. */
export const SIGNATURE_MAX_BYTES = 2 * 1024 * 1024;
/** 512 KB (spec §4.1): a header logo, not an archive. */
export const LOGO_MAX_BYTES = 512 * 1024;

const isImageUpload = (mimeType: string) => (IMAGE_UPLOAD_MIME as readonly string[]).includes(mimeType);

/** The server's size refusal for a signature image, verbatim, or null when the size fits or the
 *  type is not png or jpeg: the server checks the type first, so a screen's pre-check leaves that
 *  refusal to it rather than naming the size of a file the type would have refused. */
export function signatureSizeError(bytes: number, mimeType: string): string | null {
  if (!isImageUpload(mimeType) || bytes <= SIGNATURE_MAX_BYTES) return null;
  return `Signature images cannot exceed ${SIGNATURE_MAX_BYTES / (1024 * 1024)} MB`;
}

/** The same for a template logo. */
export function logoSizeError(bytes: number, mimeType: string): string | null {
  if (!isImageUpload(mimeType) || bytes <= LOGO_MAX_BYTES) return null;
  return `Logo images cannot exceed ${LOGO_MAX_BYTES / 1024} KB`;
}
