-- The listing of an install's stored figures below zero (#517, pull request 5c). It only reads:
-- one SELECT that answers one row of one text column, printed straight to the screen. Its first
-- line counts the figures; then one line for each part inspection's Min or Max and each
-- certification reading stored below zero, each figure as stored. The coordinator runs it, and
-- the owner pastes it, on every install before 5c merges, because 5c's boxes refuse a figure below
-- zero. tests/stored-negatives-listing.test.ts runs it. The paste block carries a copy, held equal.
WITH lines AS (
  SELECT 1 AS kind,
    row_number() OVER (ORDER BY c."code", p."partNumber", p."id", pi."sort", pi."id", f.rank) AS seq,
    concat_ws(' | ', 'inspection', c."code", p."partNumber", ic."name", f.name, f.figure::text,
      CASE WHEN p."deletedAt" IS NOT NULL THEN 'part deleted'
           WHEN pi."deletedAt" IS NOT NULL THEN 'inspection deleted'
           ELSE 'live' END) AS line
  FROM "PartInspection" pi
  JOIN "Part" p ON p."id" = pi."partId"
  JOIN "Customer" c ON c."id" = p."customerId"
  JOIN "InspectionCode" ic ON ic."id" = pi."inspectionCodeId"
  CROSS JOIN LATERAL (VALUES (1, 'min', pi."min"), (2, 'max', pi."max")) AS f(rank, name, figure)
  WHERE f.figure < 0
  UNION ALL
  SELECT 2 AS kind,
    row_number() OVER (ORDER BY o."orderNumber", ce."scope", ce."loadNumber", s."shipperNumber", ce."id",
      r."position", rd."position") AS seq,
    concat_ws(' | ', 'reading',
      concat('#', o."orderNumber",
        CASE ce."scope" WHEN 'LOAD' THEN ', load ' || ce."loadNumber"
                        WHEN 'SHIPMENT' THEN ', packing list ' || s."shipperNumber" END),
      r."position" || '. ' || ic."name", 'reading ' || rd."position", rd."value"::text,
      CASE WHEN ce."deletedAt" IS NOT NULL THEN 'cert voided'
           WHEN ce."printedAt" IS NOT NULL THEN 'live, printed'
           ELSE 'live' END) AS line
  FROM "CertReading" rd
  JOIN "CertRequirement" r ON r."id" = rd."requirementId"
  JOIN "Cert" ce ON ce."id" = r."certId"
  JOIN "Order" o ON o."id" = ce."orderId"
  JOIN "InspectionCode" ic ON ic."id" = r."inspectionCodeId"
  LEFT JOIN "Shipper" s ON s."id" = ce."shipperId"
  WHERE rd."value" < 0
)
SELECT concat(count(*), ' stored figure(s) below zero',
  chr(10) || string_agg(line, chr(10) ORDER BY kind, seq)) AS listing
FROM lines;
