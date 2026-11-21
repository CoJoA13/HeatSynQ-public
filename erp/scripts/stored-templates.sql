-- The listing of an install's stored templates (weights design, section 13.2). It only reads:
-- one SELECT that answers one row of one column, a JSON array with one object for each stored
-- template version. scripts/lib/stored-template-check.ts judges what it answers, and
-- tests/stored-templates-listing.test.ts runs it. The paste block carries a copy, held equal.
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'docType', t."docType",
    'templateId', t."id",
    'templateName', t."name",
    'isDefault', t."isDefault",
    'templateDeleted', t."deletedAt" IS NOT NULL,
    'versionId', v."id",
    'versionNumber', v."versionNumber",
    'status', v."status",
    'published', coalesce(t."publishedVersionId" = v."id", false),
    'customers', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('code', c."code", 'name', c."name") ORDER BY c."code", c."id"), '[]'::jsonb)
      FROM "CustomerTemplateAssignment" a
      JOIN "Customer" c ON c."id" = a."customerId"
      WHERE a."templateId" = t."id" AND a."deletedAt" IS NULL
    ),
    'config', v."config"
  ) ORDER BY t."docType", t."name", t."id", v."versionNumber"), '[]'::jsonb) AS versions
FROM "DocumentTemplateVersion" v
JOIN "DocumentTemplate" t ON t."id" = v."templateId";
