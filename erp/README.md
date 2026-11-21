# HeatSynQ public development and operations

[Project overview](../README.md) · [Documentation index](../docs/README.md) ·
[Public database contract](../docs/public-baseline.md)

This source distribution uses the `heatsynq-public-v2` database lineage, beginning
with `20261120000000_public_baseline_v2`. A database installed from the earlier
`heatsynq-public-v1` baseline has no upgrade path: admission refuses it, and this
version installs only into an empty database. Use Node from the repository's `.nvmrc`,
PostgreSQL 18, and the committed npm lockfile. Run commands below from `erp/`.

## Fresh installation

Copy `.env.example` to `.env`, configure the database endpoint, and start the
database with `docker compose up -d db`. Keep application services stopped during
bootstrap and upgrades. Then run:

```sh
npm ci
npx prisma generate
npm run public:prepare
npm run db:bootstrap
npm run db:seed
npm run dev
```

Bootstrap requires a completely empty database. It installs nine neutral Standard
templates, each at published v1, and required singleton configuration, then records completion in
`PublicInstallation`. It creates no business data or administrator. The explicit
seed creates the initial `admin` account; change its initial password at first login.
The public dev/start wrappers do not accept extra hostname flags and Next may listen
on all interfaces. Use an isolated host/network or host firewall during development
and credential provisioning; do not assume the server binds only to loopback.
Configure your own certification and shipping text in Admin > Templates.

Do not point public commands at a private installation. Public commands refuse
private, unknown, incomplete or damaged migration history. Private releases and
their images are unsupported for public databases; older private releases do not
have this admission guard. No automatic conversion is provided. A failed bootstrap
needs operator inspection and a newly created empty database, never a fabricated
completion row or an edited migration ledger.

The `pg_trgm` extension that search's indexes use is created by the baseline migration.
Never create it in `db-init/` or by hand: it installs into `public`, and bootstrap then
refuses the database as not empty.

## Production (single box on the shop network)

The included Compose file builds from source. Its database password and the
`.env.example` session secret are development examples. Set a strong random
`SESSION_SECRET`, change the database credentials in Compose and the matching
URLs together, and create the `backups` directory before deployment. On an
existing PostgreSQL volume, editing the Compose environment does not change the
stored role password; manage that password explicitly.

Start only `db`, then use the fresh installation commands above from a checkout
with dependencies installed. While access is restricted to the provisioning
operator, start the development server, sign in as the initial administrator and
change its password. Stop that development server before continuing:

```sh
mkdir -p backups
docker compose --profile prod up -d --build
```

This starts the source-built app and backup worker. The app publishes port 80 on
all interfaces by default; configure the intended host bind/network and TLS
termination for your installation. Startup checks public admission and deploys
known compatible migrations before serving. It does not bootstrap an empty
database or create the administrator automatically.

## Practice copy (training)

Practice uses its own `erp_practice` database and `practice` Compose profile on
port 8080, with a distinct session cookie and watermarked documents. The database
identity is authoritative; `PRACTICE_MODE` cannot turn a production database into
practice. First create the database if it does not exist: initialization scripts
run only when the PostgreSQL volume is first created.

With `DATABASE_URL` set to that practice database and other writers stopped, run
`npm run db:bootstrap`, `npm run db:seed`, then `npm run db:seed:demo` from the
prepared checkout. For an existing public practice database use `db:deploy`
instead of bootstrap. Then run `docker compose --profile practice up -d --build`.
The practice screen's reset retains its completed public history and recreates
the demonstration data; it cannot initialize or repair a missing completion record.
Practice has no production backup folder or backup responsibility.

## Backups

The production backup worker and application share `./backups` on the host,
mounted as `/backups`. Local commands use the configured `BACKUP_DIR`. Both
writers maintain archive status; the indicator requires a recent verified
archive, a successful last run and readable status. Missing status is a failure.
The Admin > Backups page requires backup-management permission and can create an
on-demand archive. Keep off-host copies and rehearse recovery. Archives inside
the managed folder are subject to 30-day retention; move long-term copies outside it.

The nightly backup runs daily at 23:10 America/Chicago (`BACKUP_TIME` and `BACKUP_TZ` in
the `backup` service of `docker-compose.yml`), following daylight saving time; archive
names stay in UTC. When the container starts it backs up at once only if no intact
nightly archive completed after the most recent scheduled time, and a run that produces
no verified archive retries every five minutes. An on-demand backup does not count as the
nightly run. To change the time, edit those two values and recreate the service
(`docker compose --profile prod up -d --force-recreate --no-deps backup`); `start` and
`restart` keep the old values. The scheduler refuses 01:00–02:59, which a daylight-saving
change skips or repeats.

### Restoring

Restore is an explicit operator action. Select and verify a compatible **public**
backup; never restore private installation history into this distribution. Record
the public source version and migration state that match it. Stop the app, backup
worker and other writers, and take a new verified safety backup before replacing
any database. Do not continue if the safety backup fails.

Rehearse first on a separately owned empty PostgreSQL target. Do **not** run
bootstrap on a restore target: the archive must restore its own application data,
`PublicInstallation` completion marker and `_prisma_migrations` ledger. Restore
using `psql -v ON_ERROR_STOP=1`; for compressed SQL, verify it with `gzip -t` first
and use a shell with `set -euo pipefail` so decompression or restore failure stops
the procedure. A partial restore must not be admitted by editing its history.

With services still stopped, point the matching prepared public checkout at the
restored endpoint and run `npm run db:deploy`. Inspect any refusal before changing
the database. Start the matching public app, verify expected orders, stored
prints, template versions and receivable balances, then resume backups. A rollback
must use the corresponding earlier source **and** compatible database backup;
restarting older code does not undo a migration. Keep the safety backup until the
restored installation is verified. Then use **Back up now** and confirm the indicator is
green: until you do, the newest archive is the state you rolled back from, and the nightly
backup does not replace it before its scheduled time.

## Customer folders

A print of a finalized invoice or credit can also be copied into the customer's own
folder on an office file share. It is off unless both deploy values are set for the
`app` service only, never `app-practice`: `OFFICE_SHARE_DIR`, the share's mount path
inside the container, and `OFFICE_SHARE_ROOT`, the same folder as the office's PCs show
it (a mapped drive root such as `Z:\` or a UNC path). `.env.example` describes both. Put
them in an untracked `docker-compose.override.yml`, and bind the share's parent directory
with `rslave` propagation so a share that is down at start cannot stop `app` starting.
The share must hold a marker file, `HeatSynQ - do not delete.txt`, at its top.

Each customer's **Invoice folder** box takes a folder inside the share; saving it checks
that the folder exists, and no folder is ever created. Only a finalized print is filed,
as `Invoice-<order number>.pdf` or `Credit-<credit number>.pdf`, and a reprint replaces
the file. A copy that does not land never fails the print: a line by **Print** names the
cause and the server log gets one `[customer-folders]` line.

## LoadSynQ recipe integration

The optional read-only order/load API uses a dedicated `LOADSYNQ_API_TOKEN` and returns the
lead part's saved numbered recipe revision. See the [LoadSynQ integration contract](../docs/integrations/loadsynq-recipes.md)
for credential setup and rotation, JSON types, statuses, current load identity and throttling.
HeatSynQ supplies recipe data; LoadSynQ owns equipment delivery.

## Disposable test, E2E and manual fixtures

`DATABASE_URL_TEST` must identify an owned disposable `erp_test` database on
localhost. Initialize that database explicitly before the first test run:

```sh
DATABASE_URL="$DATABASE_URL_TEST" npm run db:bootstrap
npm test
npx next typegen
npx tsc --noEmit
npm run lint
npm run build
```

Export `DATABASE_URL_TEST` in the shell before the first command; `.env` is read
by the Node commands, but shell variable expansion does not read it automatically.
Unit tests truncate application tables and restore factory singleton/template rows;
they preserve `PublicInstallation` and `_prisma_migrations`. Bootstrap integration
tests create unique disposable databases and join their subprocesses before cleanup.
Their database user needs permission to create and drop those owned fixtures.

E2E and manual tools retain the localhost `erp` identity guard. Use a separate
disposable PostgreSQL instance containing an `erp` database for these tools.
Initialize it with the fresh installation steps, keeping it free of demo business
rows for E2E. Install a PostgreSQL 18 client and Chromium before running:

```sh
npx playwright install --with-deps chromium
npm run test:e2e
```

For manual capture, follow the complete [fictional dataset workflow](../docs/manual/dataset.md).
It initializes its own `erp` fixture, adds the demo slice and manual data, then runs
a full capture with a neutral backup directory and rebuilds all HTML. Review every
captured page, link and retained asset before publishing a manual.
Avoid starting or stopping containers while browser checks run.

## Builds and source upgrades

`npm run build` bundles the public commands with the directly declared esbuild
development dependency before building Next. It needs no running database.
The container builds these commands before pruning development dependencies and
starts through the public admission/deployment command. To initialize its empty
database, run the image once with `node scripts/public-runtime/public-bootstrap.mjs`
as its command, then start the application container normally.

Back up the database and stop application services before upgrades. Install the
next reviewed public source release, run `npm ci`, `npx prisma generate`,
`npm run public:prepare`, and `npm run db:deploy`, then build and restart. Public
upgrades append migrations; never edit or regenerate the frozen baseline.
Known pending additive migrations are allowed only before deployment; successful
deployment requires the complete compatible ledger. App admission is cached per
client, so database replacement while services run is unsupported.

`npm run db:reset -- --yes` is the destructive training/development reset. It
retains the existing identity/confirmation rules and requires a completed public
installation. It preserves the completion marker and migration ledger. Seed,
reset and migration commands perform fresh admission checks.

## Public source CI

The GitHub workflow (`.github/workflows/ci.yml`) runs four checks on GitHub's hosted
runners with a read-only token: `ci` (tests, types, lint, manual rebuild, source build
and its trace check), `e2e` (the browser flows; a retried flow fails the job while
retaining its evidence), `docker` (container build and boot, native decoder
validation) and `security-audit`. It uses no repository secret, no self-hosted runner
and no maintained database. No artifact publishing job is included.
Build images from this source; this distribution does not promise private release
downloads. No dependency-audit exception is approved: `security/audit-exception.json`
must be `null`, and every high or critical production advisory fails the gate. The
container check also requires a patched decoder loaded by Next. See the
[public audit policy](../docs/dependency-audit-policy.md).
