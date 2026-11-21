import { HttpError } from "./errors";
import { PROCESS_DOCUMENT_MAX_BYTES } from "@/lib/process-document";

export async function readProcessDocumentRequest(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > PROCESS_DOCUMENT_MAX_BYTES) {
          await reader.cancel();
          throw new HttpError(413, "Request exceeds the 1 MiB UTF-8 limit");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, "Request body must be valid UTF-8 JSON"); }
  return input;
}
