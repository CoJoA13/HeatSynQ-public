# HeatSynQ design rationale

HeatSynQ supports the office workflow of a commercial heat-treating shop. Its
[current domain contracts](specs/domain-contracts.md) define a connected flow from
quotes and customer-specific parts through orders, loads, certifications,
shipping, invoices, payments and month-end reconciliation.

Recipes belong to individual parts. Shared process step codes supply a common
billable vocabulary; process templates provide blank structure. The document
editor changes presentation within defined data contracts, while published
versions and stored prints preserve the paper's history.

A self-hosted application and PostgreSQL database keep the deployment compact.
Server-enforced permissions, transactional business rules and audit history
support the office's work. Scheduling, equipment integration, inventory and
shop-floor tracking remain outside scope. A shop must make its own acceptance
and cutover decision after reconciling a parallel run.

Private vendor research, business forms and execution history are excluded from
this source snapshot; no redistribution permission is inferred for them. The
newly authored [fictional forms](samples/INDEX.md) illustrate document fields and
do not reproduce operational business records or redefine historical requirements.
