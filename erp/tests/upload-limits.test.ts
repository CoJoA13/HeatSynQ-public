import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ATTACHMENT_ACCEPT, ATTACHMENT_TYPES, ATTACHMENT_TYPE_REFUSAL, IMAGE_UPLOAD_MIME, LOGO_MAX_BYTES, MAX_ATTACHMENT_BYTES,
  SIGNATURE_MAX_BYTES, attachmentSizeError, attachmentTypeError, logoSizeError, signatureSizeError,
} from "@/lib/upload-limits";
import { LOGO_MAX_BYTES as SERVER_LOGO_MAX, LOGO_MIME } from "@/server/templates";
import { SIGNATURE_MAX_BYTES as SERVER_SIGNATURE_MAX, SIGNATURE_MIME } from "@/server/users";

// #38, #687 (ruling R21), #688 — the client-side pre-check leaf for the three upload screens. A
// client component must not import src/server/** (CLAUDE.md), so the three screens read this leaf;
// the SERVER imports the same leaf for its caps, its type lists and its sentences, so the two
// halves cannot drift. This suite pins the leaf's behaviour at each boundary and that the server
// modules read it rather than carrying their own copies (the drift guard: a cap or sentence that
// moves in only one place fails here).
const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

describe("upload limits: attachments (#38, #687)", () => {
  it("accepts a file exactly at the 20 MB cap and refuses one byte over", () => {
    expect(attachmentSizeError(MAX_ATTACHMENT_BYTES)).toBeNull();
    expect(attachmentSizeError(MAX_ATTACHMENT_BYTES - 1)).toBeNull();
    expect(attachmentSizeError(0)).toBeNull();
    expect(attachmentSizeError(MAX_ATTACHMENT_BYTES + 1)).toBe("Attachments cannot exceed 20 MB");
  });

  it("the server reads this leaf's cap, size sentence, type list and type sentence", () => {
    const server = read("src/server/attachments.ts");
    expect(MAX_ATTACHMENT_BYTES).toBe(20 * 1024 * 1024);
    expect(server).toContain("const MAX_SIZE = MAX_ATTACHMENT_BYTES;");
    expect(server).toContain("const ALLOWED_TYPES = new Set<string>(ATTACHMENT_TYPES);");
    expect(server).toContain("throw new HttpError(400, ATTACHMENT_TYPE_REFUSAL);");
    expect(server).toContain('throw new HttpError(400, "Attachments cannot exceed 20 MB");');
  });

  it("names every allowed kind in the refusal, starting with the words the old refusal used", () => {
    expect(ATTACHMENT_TYPE_REFUSAL).toBe(
      "That file type is not allowed. Attachments must be one of: PNG, JPEG, GIF, WebP, PDF, text, CSV, Word (.docx), Excel (.xlsx)");
    expect(ATTACHMENT_TYPES).toEqual([
      "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/csv",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]);
    for (const type of ATTACHMENT_TYPES) expect(attachmentTypeError(type), type).toBeNull();
    expect(attachmentTypeError("application/zip")).toBe(ATTACHMENT_TYPE_REFUSAL);
    expect(attachmentTypeError("")).toBe(ATTACHMENT_TYPE_REFUSAL);
  });

  it("the picker's accept lists each MIME type and its extensions", () => {
    for (const type of ATTACHMENT_TYPES) expect(ATTACHMENT_ACCEPT, type).toContain(type);
    for (const ext of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".txt", ".csv", ".docx", ".xlsx"]) {
      expect(ATTACHMENT_ACCEPT, ext).toContain(ext);
    }
  });
});

describe("upload limits: signature and logo images (#688)", () => {
  it("the server's caps and type lists are this leaf's", () => {
    expect(SERVER_SIGNATURE_MAX).toBe(SIGNATURE_MAX_BYTES);
    expect(SIGNATURE_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(SERVER_LOGO_MAX).toBe(LOGO_MAX_BYTES);
    expect(LOGO_MAX_BYTES).toBe(512 * 1024);
    expect([...SIGNATURE_MIME]).toEqual([...IMAGE_UPLOAD_MIME]);
    expect([...LOGO_MIME]).toEqual([...IMAGE_UPLOAD_MIME]);
    expect(read("src/server/users.ts")).toContain("const sizeError = signatureSizeError(data.byteLength, mimeType);");
    expect(read("src/server/templates.ts")).toContain("const sizeError = logoSizeError(data.byteLength, mimeType);");
  });

  it("refuses an oversized png or jpeg with the server's sentence, and leaves any other type to the server's type refusal", () => {
    expect(signatureSizeError(SIGNATURE_MAX_BYTES, "image/png")).toBeNull();
    expect(signatureSizeError(SIGNATURE_MAX_BYTES + 1, "image/png")).toBe("Signature images cannot exceed 2 MB");
    expect(signatureSizeError(SIGNATURE_MAX_BYTES + 1, "image/jpeg")).toBe("Signature images cannot exceed 2 MB");
    expect(signatureSizeError(SIGNATURE_MAX_BYTES + 1, "image/gif")).toBeNull();
    expect(logoSizeError(LOGO_MAX_BYTES, "image/jpeg")).toBeNull();
    expect(logoSizeError(LOGO_MAX_BYTES + 1, "image/jpeg")).toBe("Logo images cannot exceed 512 KB");
    expect(logoSizeError(LOGO_MAX_BYTES + 1, "image/bmp")).toBeNull();
  });

  it("the two upload controls check the size before any bytes are sent", () => {
    expect(read("src/components/UserSignatureControl.tsx")).toContain("const sizeError = signatureSizeError(file.size, file.type);");
    expect(read("src/app/admin/templates/[id]/edit/LogoPanel.tsx")).toContain("const sizeError = logoSizeError(file.size, file.type);");
    expect(read("src/components/AttachmentsSection.tsx")).toContain("const typeError = attachmentTypeError(file.type);");
    expect(read("src/components/AttachmentsSection.tsx")).toContain("accept={ATTACHMENT_ACCEPT}");
  });
});
