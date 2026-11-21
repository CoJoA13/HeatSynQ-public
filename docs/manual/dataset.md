# The fictional manual dataset

[Manual contents](README.md) · [Installation guide](../../erp/README.md)

The manual uses fictional data produced by
[`demo-seed.ts`](../../erp/prisma/demo-seed.ts) and
[`manual-seed.ts`](../../erp/prisma/manual-seed.ts). The latter calls the application's
services to create the richer order-to-payment examples, stored documents and
template variants. It is additive and is not idempotent: running it twice on the
same populated database is not a supported rebuild.

The fixture login is `admin` / `heatsynq-demo`. The manual seed changes the initial
administrator password and dismisses its setup checklist. Those are fictional
fixture credentials, not the credentials for a real installation.

## Build a new fixture

Use a separately owned disposable PostgreSQL 18 service with an empty database
named `erp` on localhost. Confirm ownership, host and port before setting
`DATABASE_URL`. A database name and loopback address alone do not make a maintained
installation disposable. The E2E suite also expects `erp` and must have a separate
clean fixture; do not share it with a manual dataset.

From `erp/`, configure `.env` and export the fixture `DATABASE_URL`. Install the
Node version in `.nvmrc`, dependencies and PostgreSQL 18 client tools. Use a
neutral backup path containing no username, private checkout or company name:

```sh
npm ci
npx prisma generate
npm run public:prepare
export BACKUP_DIR=/tmp/heatsynq-manual-backups
mkdir -p "$BACKUP_DIR"
npm run db:bootstrap
npm run db:seed
npx tsx -e "import('./prisma/demo-seed.ts').then(m => m.seedDemoSlice()).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); })"
npx tsx prisma/manual-seed.ts
```

Keep other database writers stopped during initialization. Bootstrap requires an
empty database and establishes `PublicInstallation` plus the valid public migration
ledger. It initializes nine Standard templates, the container tag among them, each with neutral
published v1.
The demo/manual seeds subsequently create their own fictional data and template
variants. There is no private historical template lineage in this fixture.

The direct `seedDemoSlice` call admits the public database; `db:seed:demo` instead
uses the practice-specific entry point and intentionally refuses this non-practice
`erp` fixture. The manual script additionally verifies localhost and database
identity. These checks supplement, and do not replace, confirming disposability.

To rebuild an already completed disposable public fixture, first stop other
writers, run `npm run db:deploy`, then `npm run db:reset -- --yes`. Reset restores
factory configuration and the administrator while preserving `PublicInstallation`
and `_prisma_migrations`. Then run the demo-slice and manual-seed commands above.
Do not use reset to repair an incomplete bootstrap or bypass history checks.

## Capture and rebuild

Install Chromium (`npx playwright install --with-deps chromium`). Keep the same
fixture configuration and neutral `BACKUP_DIR` exported for the entire capture:

```sh
npm run manual:capture
npm run manual:build
```

Capture the full set of figures, then rebuild all HTML. The capture creates
screenshots and a local sweep report; the report is private verification evidence
and is not part of this public source selection. The HTML builder embeds the
images and records a digest of its source inputs. Do not edit generated HTML or
manipulate images to conceal data. Review every screenshot and generated page,
including backup paths, labels, document content and metadata, before publication.
The capture shows the Backups screen's folder as `[installation-specific folder]` in its
figure only; the application still displays the configured directory.

## Data behavior and limits

The seed creates representative customers, parts, orders and loads, quotes,
shipments, certificates, invoices, credits, payments, statements, template drafts
and published variants. It also takes a real backup using `pg_dump` and verifies
the resulting archive. Use a compatible PostgreSQL client major. Backup archives
and status files stay outside the published source and must not be committed.

Dates are derived from the seed date. Screenshots show one run's examples; exact
month labels, counts and balances are not a promise for every future rebuild.
Invoice finalization stamps the current date, so a newly generated fixture cannot
show invoices finalized across several months. Its prior closed month carries
on-account cash; allocating that cash later requires reopening the period because
payment applications inherit the payment date. Reclosing a period updates its
state, with the reopen retained in audit history.

These limits are deliberate fixture and business-rule boundaries. For real
workflows, use the [receivables](07-receivables.md) and [month-end](08-month-end.md)
chapters. Additional recipe capabilities, expanded barcode workflows and an
external integration endpoint are future work, not fixture features.
