-- The listing of an install's invoices whose computed surcharge differs from their lines (#586). It
-- only reads: one SELECT that answers one row of one text column, printed straight to the screen.
-- Its first line counts the surcharge lines that differ; then one line for each, by order number
-- and line position, naming the invoice, its state, whether an operation price was typed on it,
-- whether money is applied to it, and the surcharge's stored figure beside the one Save lines would
-- now make it. It re-figures against each surcharge's scope and minimum as Admin holds them today,
-- not as they were when the line was figured, and its first line says so.
--
-- A computed surcharge line is a SURCHARGE line not typed on the invoice (its price source is not
-- MANUAL) that names a surcharge not deleted, switched off or not; it is read on a live invoice,
-- draft or finalized, never on a credit. It is re-figured as Save lines does
-- (src/server/pricing.ts's surchargeOnLines, called by replaceInvoiceLines): over the invoice's
-- stored OPERATION lines in its scope, each judged by its own step code, the rate the line's own.
-- A line whose scope holds no operation line is removed; a percent line (its rate not null) is that
-- rate of their summed cents, rounded half away from zero, floored at the minimum and at zero
-- without one; a flat line keeps its own figure. tests/surcharge-differs-listing.test.ts runs it.
-- The paste block carries a copy, held equal.
WITH prefix AS (
  SELECT nullif(s."value" #>> '{}', '') AS number_prefix
  FROM "Setting" s
  WHERE s."key" = 'invoice_number_prefix'
),
candidates AS (
  SELECT i."id" AS invoice_id, o."orderNumber" AS order_number, i."status", i."finalizedAt",
    l."position", l."description", l."amount" AS stored, l."rate",
    su."id" AS surcharge_id, su."scope", su."minimumAmount"
  FROM "InvoiceLine" l
  JOIN "Invoice" i ON i."id" = l."invoiceId"
  JOIN "Order" o ON o."id" = i."orderId"
  JOIN "Surcharge" su ON su."id" = l."surchargeId" AND su."deletedAt" IS NULL
  WHERE l."kind" = 'SURCHARGE'
    AND l."priceSource" IS DISTINCT FROM 'MANUAL'
    AND i."kind" = 'INVOICE'
    AND i."deletedAt" IS NULL
    AND i."status" IN ('DRAFT', 'FINALIZED')
),
refigured AS (
  SELECT c.*,
    CASE WHEN NOT b.in_scope THEN NULL
         WHEN c."rate" IS NOT NULL
           THEN (greatest(round(b.base_cents * c."rate"), coalesce(c."minimumAmount", 0) * 100) / 100)::numeric(12, 2)
         ELSE c.stored END AS figure
  FROM candidates c
  CROSS JOIN LATERAL (
    SELECT count(*) > 0 AS in_scope, coalesce(sum(op."amount"), 0) * 100 AS base_cents
    FROM "InvoiceLine" op
    WHERE op."invoiceId" = c.invoice_id
      AND op."kind" = 'OPERATION'
      AND (c."scope" = 'ALL'
        OR (c."scope" = 'INCLUDE' AND op."processStepCodeId" IN (
          SELECT ssc."processStepCodeId" FROM "SurchargeStepCode" ssc WHERE ssc."surchargeId" = c.surcharge_id))
        -- An operation line with no step code is never listed, so it is always in an EXCLUDE scope:
        -- NOT IN answers NULL for it, which this first branch overrules.
        OR (c."scope" = 'EXCLUDE' AND (op."processStepCodeId" IS NULL OR op."processStepCodeId" NOT IN (
          SELECT ssc."processStepCodeId" FROM "SurchargeStepCode" ssc WHERE ssc."surchargeId" = c.surcharge_id))))
  ) b
),
lines AS (
  SELECT r.order_number, r."position",
    concat_ws(' | ',
      concat_ws(' - ', (SELECT p.number_prefix FROM prefix p), r.order_number),
      CASE r."status" WHEN 'DRAFT' THEN 'draft'
                      ELSE 'finalized ' || to_char(r."finalizedAt", 'YYYY-MM') END,
      CASE WHEN EXISTS (
          SELECT 1 FROM "InvoiceLine" op
          WHERE op."invoiceId" = r.invoice_id AND op."kind" = 'OPERATION' AND op."priceSource" = 'MANUAL')
        THEN 'typed price' ELSE 'no typed price' END,
      CASE WHEN EXISTS (
          SELECT 1 FROM "Application" a
          WHERE a."deletedAt" IS NULL AND (a."invoiceId" = r.invoice_id OR a."creditInvoiceId" = r.invoice_id))
        THEN 'money applied' ELSE 'no money applied' END,
      r."description",
      'stored ' || r.stored::text,
      CASE WHEN r.figure IS NULL THEN 're-figured: removed' ELSE 're-figured ' || r.figure::text END) AS line
  FROM refigured r
  WHERE r.figure IS NULL OR r.figure <> r.stored
)
SELECT concat(count(*),
  ' computed surcharge(s) differ from the invoice''s lines (scope and minimum as Admin holds them today)',
  chr(10) || string_agg(line, chr(10) ORDER BY order_number, "position")) AS listing
FROM lines;
