# Contributing to HeatSynQ

Start with an issue describing the problem and desired outcome, in the public home's
[issue tracker](https://github.com/CoJoA13/HeatSynQ-public/issues) (`CoJoA13/HeatSynQ-public` on GitHub). Read the
[current domain contracts](docs/specs/domain-contracts.md) and
[public database contract](docs/public-baseline.md) before proposing changes.
Report suspected vulnerabilities through [SECURITY.md](SECURITY.md).

## Development

Create a branch or fork and follow the [development guide](erp/README.md#fresh-installation).
Use the Node major in `.nvmrc` and `npm ci` to reproduce the lockfile. Generate Prisma
and prepare the public commands before using database commands. Test databases must
be explicitly owned disposable fixtures; a familiar name or loopback URL is not
proof. Manual fixtures and E2E must have separate clean database ownership.

Preserve permission checks, transaction boundaries, audit records, period locks
and published document/template contracts. Keep each change focused. Schema changes
need new additive public migrations and upgrade-preservation tests; never edit the
public baseline or an applied migration. Direct raw Prisma database administration
bypasses supported public command checks and is not the deployment workflow.

## Validation

From `erp/`, run focused checks during development and the applicable full gates:

```sh
npm test
npx next typegen
npx tsc --noEmit
npm run lint
npm run build
npm run test:e2e
```

Initialize the disposable fixtures described in the
[test guide](erp/README.md#disposable-test-e2e-and-manual-fixtures) first. Integration
tests share a database and must retain their configured sequential execution.
Bootstrap tests create unique databases and need CREATEDB. The suite must cancel
and join child processes before dropping their fixtures. Avoid container
startup/shutdown during browser checks.

Update documentation with behavior changes. For changed screens, use the
[full manual workflow](docs/manual/dataset.md#capture-and-rebuild) against a fictional
fixture. Rebuild generated HTML with `npm run manual:build`; do not edit it or
manipulate screenshots by hand. For prose-only changes, rebuild HTML and check
links. Review every retained image and document's content and metadata.

## Pull requests

Use a conventional commit subject, such as `fix: preserve invoice totals`.
Describe the problem, resulting behavior, tests and limitations, and link the
public issue. Record failures honestly. Put AI assistance attribution once in
the pull request body, without attribution trailers on individual commits.
Required CI checks and review must complete before merge. The source pipeline
builds and tests this repository; it does not publish release images.

Use fictional examples and submit only material you have the right to contribute
under [Apache-2.0](LICENSE). Do not commit business records, signatures, private
vendor material, database dumps, credentials or production logs. Preserve all
third-party notices. Dependency changes must include the lockfile and follow the
[dependency audit policy](docs/dependency-audit-policy.md): no audit exception is
approved, so a high or critical advisory is cleared by moving to a patched release.
