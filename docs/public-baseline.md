# Public database and installation contract

[Documentation index](README.md) · [Installation guide](../erp/README.md)

## Fresh public history

This source distribution starts with migration `20261120000000_public_baseline_v2`
and lineage `heatsynq-public-v2`. It contains the application schema, required
BillingConfig/SetupState/UpdateHold defaults and one Standard document template for
each document type, nine: TRAVELER, SHIPPER, MOS_SHIPPER, BOL, CERT, INVOICE,
STATEMENT, QUOTE and CONTAINER_TAG. Each starts with one published **v1**, using
current neutral defaults. Certification
and shipping clauses are blank where neutral defaults require them; configure
approved shop wording in Admin > Templates before printing operational documents.
Bootstrap creates no customer, order, invoice, audit history or administrator.
The separate seed command creates the administrator.

The private migration chain and historical template versions are absent. Existing
private databases must continue with their matching private distribution. Public
commands reject private or unknown history; private releases are unsupported for
public databases and older private releases do not have these admission checks.
There is no automatic conversion between the histories.

## No upgrade from heatsynq-public-v1

An earlier public candidate used lineage `heatsynq-public-v1`, beginning with
`20260915000000_public_baseline`. `heatsynq-public-v2` replaces that baseline and
there is no upgrade path from it. Admission refuses a database whose
`PublicInstallation` row names `heatsynq-public-v1`, with: "This database was
installed from the heatsynq-public-v1 baseline, and there is no upgrade path to
heatsynq-public-v2. Install into an empty database." It changes nothing in that
database. Install this version into a new empty database instead.

## Completion and admission

Keep all application and other database-writing services stopped for bootstrap,
deployment and restore. `npm run db:bootstrap` is the one supported empty-database
exception. The baseline creates an empty `PublicInstallation` table. Only successful
post-migration validation inserts its completion record with id `singleton`, the
public lineage, baseline identity and completion timestamp.

Admission requires **both** that completion marker and valid migration history:
known migration names, expected checksums and successful completion. A marker
alone is insufficient. A baseline ledger without its completion marker is an
incomplete installation, even if tables exist. Failed, private and unknown history
must not be repaired by fabricating a marker or editing the ledger. Inspect the
failure and provision a new empty disposable installation when appropriate.

Supported deploy, migrate, seed, demo, reset, development, start, container and
practice-reset entry points check admission. Known pending additive migrations
may be admitted for deployment; application startup requires the deployed history.
Normal reset and test cleanup preserve `PublicInstallation` and `_prisma_migrations`.
Raw database administration is an operator responsibility outside these wrappers.
Successful app admission is cached for a client lifetime: replacing a database or
its history while services run is unsupported.

## Upgrades and recovery

The baseline is frozen after publication. Later public versions append reviewed
migrations and must preserve existing business records and customized/published
templates. Never regenerate a baseline over an installed public history. Use
`npm run db:deploy` for an existing compatible public database, then rebuild and
restart as described in the [upgrade guide](../erp/README.md#builds-and-source-upgrades).

Backups must include the completion marker and migration ledger with the business
data. Restore only a compatible public backup into a separate empty target while
writers are stopped; do not bootstrap that target first. Use the matching public
source version to validate/admit it before bringing services online. Rehearse
[restore](../erp/README.md#restoring) and verify records and balances. A code rollback
alone does not reverse an applied database migration.
