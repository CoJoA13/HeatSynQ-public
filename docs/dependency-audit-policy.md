# Public dependency audit policy

The `security-audit` CI job runs `npm audit --omit=dev --audit-level=high --json`
through [the audit runner](../erp/scripts/audit-dependencies.mjs). It runs independently
of the test, build, container and browser jobs, so a security finding does not suppress
their results. A passing audit is not a claim that all dependency advisories have been
eliminated.

## No exception is approved

[audit-exception.json](../erp/security/audit-exception.json) must be `null`. Every high or
critical advisory in the production report blocks the job; moderate, low and info findings
stay in the raw report and do not block it. `next` and `eslint-config-next` are exact pins in
[package.json](../erp/package.json), moved together, and an advisory against Next is cleared by
moving to a patched release, never by an exception.

A non-null exception file is **refused, never ignored**. The evaluator
(`erp/scripts/lib/dependency-audit-policy.mjs`) refuses any value other than `null` before it
reads the report, so a clean report cannot hide a stale file. The file must still exist and
parse: a missing file fails the job, and so does text that is not JSON, with an error naming
`security/audit-exception.json`. The evaluator has no exception path, so a new exception would
be a code change as well as a reviewed decision.

## Development-only advisories are outside the gate

The job passes `--omit=dev` and runs in `erp/`, so its report leaves out a package that only a
devDependency brings in. An advisory against such a package cannot block the job at any severity,
and it needs no exception. A plain `npm audit` reads the whole tree and can show findings the job
does not.

## Decoder enforcement

The [libheif advisory](https://github.com/strukturag/libheif/security/advisories/GHSA-g89c-p67h-r497)
lists 1.23.2 as patched. `erp/scripts/lib/image-decoder-policy.mjs` resolves sharp from Next's
image-optimizer module, loads its native binary and inspects `sharp.versions.heif`. It rejects a
missing, malformed, prerelease or older version. Resolving relative to Next also catches a
vulnerable nested copy when a different, patched sharp exists at the application root.

The container CI job streams that self-contained verifier into the newly built image, after the
image build. A failed load or check fails that job. It is a CI check, not a production startup
hook. The audit runner records the decoder it finds in `scope.json` as evidence only; the audit
decision does not consult it.

## Decision and evidence

The audit matches individual advisory leaves, including indirect dependency references, so a
parent row cannot hide a severe leaf. Unknown or malformed reports, inconsistent metadata,
unresolved references, npm execution failures and signals fail closed.

Run `node scripts/audit-dependencies.mjs` from an installed `erp` checkout. It writes under
`erp/audit-artifacts/`:

- `npm-audit.json`: unmodified npm stdout.
- `npm-audit.stderr.log` and `execution.json`: stderr, exact argv, exit/signal/error and timestamps.
- `scope.json`: Next manifest/lock/installed versions, the loaded decoder or its load error, and
  the committed policy value.
- `decision.json`: the remaining blockers, or the validation error.

There is no clock, version or exception override environment variable. Never treat a prior
source or private deployment's passing gate as validation of this public candidate.
