/**
 * The step suggestions an invoice's operation lines offer (#587, Amendment 22): what
 * `GET /api/invoices/[id]/step-suggestions` answers. Client-safe: the invoice page imports these
 * types, and the server's `invoice-step-suggestions.ts` builds them.
 *
 * `id` is the step code's own id, which a pick carries onto the line; `code` and `name` are the
 * words the list shows. Where the saved revision carries a numbered recipe (its names as captured at
 * its first lock), a lead line's name is the one its saved revision captured, which can differ from
 * the code's current name (else it is the current name), and a pick writes the name the list shows.
 */
export type StepSuggestion = { id: string; code: string; name: string };

/**
 * `byOrderLine` is keyed by order line id: the order's lead line lists its saved revision's steps,
 * every other line its part's latest revision's steps, and a part with no revision lists none; each
 * list names a step code once, in step order. `others` is every live, active step code, ordered by
 * code, the line's own steps included (the page leaves those out).
 */
export type InvoiceStepSuggestions = {
  byOrderLine: Record<string, StepSuggestion[]>;
  others: StepSuggestion[];
};
