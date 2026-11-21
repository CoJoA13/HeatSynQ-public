# HeatSynQ documentation

[Project overview](../README.md) · [Public issues](https://github.com/CoJoA13/HeatSynQ-public/issues) on GitHub (`CoJoA13/HeatSynQ-public`)

## Use HeatSynQ

The [user manual](manual/README.md) covers orders, quotes, shipping, certifications,
invoicing, receivables, month end, customers, parts, reports, administration,
document templates, practice training and a glossary. The [single-file HTML edition](../erp/public/manual.html)
can be downloaded and opened locally with its embedded screenshots.

## Install and maintain

| Task | Guide |
|---|---|
| Initialize an empty public database | [Fresh installation](../erp/README.md#fresh-installation) |
| Understand history and upgrade compatibility | [Public database contract](public-baseline.md) |
| Run on a shop network | [Source deployment](../erp/README.md#production-single-box-on-the-shop-network) |
| Train on a separate database | [Practice copy](../erp/README.md#practice-copy-training) |
| Back up and recover | [Backups and restore](../erp/README.md#backups) |
| Update a public source installation | [Builds and upgrades](../erp/README.md#builds-and-source-upgrades) |

## Develop and contribute

| Task | Guide |
|---|---|
| Make a change | [Contributing](../CONTRIBUTING.md) |
| Understand modules and source entry points | [Codebase map](codebase-map.md) |
| Understand scope and invariants | [Domain contracts](specs/domain-contracts.md), [design rationale](design-rationale.md) |
| Understand part recipes | [Process Steps model](2026-07-30-process-steps-model.md) |
| Rebuild fictional manual data and screenshots | [Dataset workflow](manual/dataset.md) |
| Review fictional reference forms | [Sample forms](samples/INDEX.md) |
| Understand dependency checks | [Dependency audit policy](dependency-audit-policy.md) |

Use [SECURITY.md](../SECURITY.md) for private vulnerability reporting. Original-work
licensing and third-party scope are in [LICENSE](../LICENSE), [NOTICE](../NOTICE)
and [third-party notices](../THIRD_PARTY_NOTICES.md).

This source snapshot does not include private issue history, execution records,
vendor research, private release artifacts or a mirrored wiki. Historical issue
numbers have not been mapped to new public issues; report current problems, with
reproduction steps, in the [public issue tracker](https://github.com/CoJoA13/HeatSynQ-public/issues).
