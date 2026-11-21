// The statements screen's two confirms, in the modal's shape (spec 2026-10-30-ux-redesign-design.md
// §4.3, ruling 5; the UX redesign PR 7): today's two `confirm()` sentences split into a title (the
// question) and a body (the disclosure), and the confirm button's word. Import-free, client-safe.

/** Per-division printing (#85): one statement for the family head and each division, named. */
export function perDivisionConfirm(count: number, asOf: string, names: string): { title: string; body: string; confirm: string } {
  return {
    title: `Print ${count} statements as of ${asOf} — this customer plus its divisions (${names})?`,
    body: "The preview above shows this customer's statement only; each division's is archived and listed with a link once printed.",
    confirm: "Print statements",
  };
}

/** The run for everyone with a balance. */
export function runConfirm(asOf: string): { title: string; body: string; confirm: string } {
  return {
    title: `Print a statement for every customer with an open balance as of ${asOf}?`,
    body: "",
    confirm: "Run statements",
  };
}
