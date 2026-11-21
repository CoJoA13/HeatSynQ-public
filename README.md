<img src="erp/src/assets/brand/heatsynq-icon-128.png" alt="HeatSynQ" width="64" height="64">

# HeatSynQ

HeatSynQ is a self-hosted ERP for commercial heat-treating shops. It connects quotes,
orders and process travelers with certifications, shipping, invoicing, receivables
and month-end reconciliation.

This is a **source-only distribution for fresh public installations**. Build from
this checkout. The public database history starts at
`20261120000000_public_baseline_v2` (lineage `heatsynq-public-v2`); existing private
installations and databases installed from the earlier `heatsynq-public-v1` baseline
cannot use it as an upgrade. Read the [installation and compatibility contract](docs/public-baseline.md).
A completed build or test run is not a shop's production acceptance decision.

## What it covers

- Customers, parts, part-specific process steps, quotes, orders and load splitting.
- Travelers, certificates, shippers, bills of lading and versioned document templates.
- Invoices, credits, payments, aging, month-end close and summary GL export.
- Permissions, business-record audit history, reports, backups and a separate practice copy.

Scheduling, equipment integration, inventory and shop-floor tracking are outside
scope. Additional recipe capabilities, broader barcode workflows and an external
integration endpoint are **future work**; they are not included features. Current
process templates load blank step structure, and traveler barcode search opens an order.
See the [current domain contracts](docs/specs/domain-contracts.md).

## Get started

Use Node.js from [`.nvmrc`](.nvmrc), npm and PostgreSQL 18. Follow the
[development setup](erp/README.md#fresh-installation) to bootstrap an empty database,
seed the administrator and start in an isolated development environment. For a shop server, follow the
[source deployment guide](erp/README.md#production-single-box-on-the-shop-network).
Change example database credentials, session secrets and the administrator password
before exposing the application.

## Documentation

| Guide | Purpose |
|---|---|
| [Documentation index](docs/README.md) | Find operator, developer and installation guides |
| [User manual](docs/manual/README.md) | Day-to-day workflows with fictional examples |
| [Standalone HTML manual](erp/public/manual.html) | Download and open locally; images are embedded |
| [Public database contract](docs/public-baseline.md) | Bootstrap, admission, upgrades and compatibility |
| [Codebase map](docs/codebase-map.md) | Source entry points and data flow |
| [Contributing](CONTRIBUTING.md) | Development workflow and pull requests |

HeatSynQ's public home is `CoJoA13/HeatSynQ-public` on GitHub; bugs and proposals go to its
[issue tracker](https://github.com/CoJoA13/HeatSynQ-public/issues).
Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

## License

Copyright 2026 Colton Jones. HeatSynQ's original code and documentation are licensed
under [Apache-2.0](LICENSE). Preserve [NOTICE](NOTICE) and the
[third-party notices](THIRD_PARTY_NOTICES.md), including bundled font licenses.
