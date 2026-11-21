// The Invoice folder box's words and the print's folder lines (#588), verbatim from the owner's
// rulings of 2026-10-20 (the plan's Amendments 8 and 9). Client-safe: no imports, so the customer
// page, the invoice page and the server can all read the one copy.
//
// PLAIN NODE LOADS THIS FILE: a browser flow imports it by its `.ts` name, and node strips the types
// and changes nothing else. So it imports nothing and keeps to syntax node can strip (annotations
// and type aliases: no enum, no namespace, no parameter property). One case of
// tests/invoice-folder-entry.test.ts holds that: it imports this file under plain node.

export const INVOICE_FOLDER_LABEL = "Invoice folder";
export const INVOICE_FOLDER_HELP =
  "Paste the folder's path from Windows Explorer's address bar. Leave it blank to file nothing.";

// Saving the box.
export const FOLDER_FOUND = "Folder found.";
export const SHARE_NOT_SET_UP =
  "This install has no invoice share set up, so an invoice folder cannot be saved.";
export function notInsideShare(root: string): string {
  return `That path is not inside the invoice share, ${root}. Paste a folder's path from Windows Explorer's address bar.`;
}
export const SHARE_ITSELF = "That is the share itself. Paste the customer's own folder inside it.";
export const BAD_PATH_NAME = "That path holds a name or character a Windows share does not allow.";
export const FOLDER_NOT_FOUND =
  "No folder was found at that path. Check it in Windows Explorer, then paste it again.";
export const SAVE_NOT_CONNECTED =
  "The invoice share is not connected, so the folder could not be checked. Save it again once it is reconnected.";
export const SAVE_BUSY =
  "The invoice share is busy with an earlier copy, so the folder could not be checked. Save it again in a few minutes.";

// How long a save's check or a print's copy waits on the share; the two sentences below state it.
export const COPY_WAIT_MS = 10_000;
export const SAVE_TIMED_OUT =
  "The invoice share did not answer within 10 seconds, so the folder could not be checked. Save it again.";
export const PRINT_TIMED_OUT =
  "Not filed in the customer folder — the shared folder did not finish the copy within 10 seconds. Print again to file it.";

// The line by Print.
export const PRINT_NO_FOLDER = "Not filed in a customer folder — no invoice folder is set for this customer.";
export const PRINT_FOLDER_NOT_FOUND =
  "Not filed in the customer folder — the customer's invoice folder was not found. Check it on the customer page.";
export const PRINT_NOT_CONNECTED =
  "Not filed in the customer folder — the shared folder is not connected. Print again once it is reconnected.";
export const PRINT_SKIPPED =
  "Not filed in the customer folder — an earlier copy is still waiting on the shared folder. Print again in a few minutes to file it.";
export const PRINT_REFUSED =
  "Not filed in the customer folder — the shared folder refused the copy. Print again; if it fails again, check the share.";
export const PRINT_WARNING_UNREADABLE =
  "The print reported a folder problem that could not be read — check the customer folder.";
