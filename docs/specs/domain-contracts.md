# Current domain contracts

[Documentation index](../README.md) · [Codebase map](../codebase-map.md)

This is a public reading guide to the implemented contracts. It summarizes the
approved domain model and current service boundaries; it does not introduce new
requirements or reproduce the private planning and reference documents. The
linked source and regression tests retain the detailed behavior.

## Scope and records

HeatSynQ supports a single plant's office workflow: customers and parts, quotes,
orders and loads, travelers, certificates, shipping, invoicing, receivables,
month-end reconciliation and summary GL export. Scheduling, inventory, equipment
integration, shop-floor tracking and automatic migration from another ERP are
outside this scope. Production acceptance is an operator decision requiring a
parallel-run month closed with receivables and bookkeeping totals reconciled.
This publication does not assert that acceptance has occurred.

A part belongs to one customer; its part number is unique within that customer.
Its process steps and parameter values belong to that part. Shared process step
codes provide the vocabulary and billing account; templates supply blank step
structure. Editing another part cannot change this recipe. See the
[Process Steps model](../2026-07-30-process-steps-model.md) and
[part-process service](../../erp/src/server/part-process-steps.ts).

Orders require quantity and weight and hold their process revision/snapshot.
Loads represent processing subdivisions; containers represent customer packaging.
Shipped quantities are not constrained to load boundaries. Shipment completion is
an explicit business decision, not a deduction from quantity equality. Order
duplication is deliberately absent. See [orders](../../erp/src/server/orders.ts),
[creation](../../erp/src/server/order-create.ts), [shipping](../../erp/src/server/shippers.ts)
and the [shipping ledger](../../erp/src/server/ship-ledger.ts).

## Permissions, transactions and accounting

The server validates identity and permissions for each protected operation.
UI visibility alone does not authorize a write. Transactions, row claims and
period locks protect the affected records; business mutations retain audit
history. Soft deletion preserves business history where supported; explicit
training resets are destructive administrative operations.

Invoices freeze their financial snapshots at finalization. Shipping corrections,
credits, payment applications and period reopen/close must preserve the existing
financial and audit rules. Payment applications use the payment's received date;
closed-period cash allocation requires reopening that period. Credit allocation
uses its allocation date. See [invoices](../../erp/src/server/invoices.ts),
[applications](../../erp/src/server/applications.ts),
[period locks](../../erp/src/server/period-locks.ts) and
[close periods](../../erp/src/server/close-periods.ts).

## Documents and templates

The eight template types are traveler, shipper, multi-order shipper, bill of
lading, certificate, invoice/credit, statement and quote. Configuration changes
presentation within each type's existing data contract; it does not create new
business fields or alter the saved record's facts.

Drafts do not print. Publishing creates an immutable version; later edits use a
new draft. Customer assignments resolve through the customer/division ancestry
and then the default for that type. Archived printed documents retain their bytes
and the version that produced them. The traveler barcode and typed process fields
remain protected by the document contract. See the
[template service](../../erp/src/server/templates.ts),
[assignment service](../../erp/src/server/template-assignments.ts),
[renderer](../../erp/src/server/pdf/render.ts) and
[operator guide](../manual/13-templates.md).

The public installation starts with nine neutral Standard v1 templates, one per document
type: traveler, shipping ticket, multi-order shipping ticket, bill of lading, certification,
invoice, statement, quote and container tag. That
public initialization replaces the private installation history; it does not
rewrite an already published template. See [public database contract](../public-baseline.md).

## Draft recovery and integrations

Explicit-save editor recovery retains unsaved input in the current browser
document's memory. Restoration is an explicit user choice; it does not autosave
or silently merge conflicting server data. A reload, document exit or new tab
starts without those retained drafts. The order-entry server draft workflow is
a separate feature. See [getting around](../manual/01-getting-around.md).

Current traveler barcode search opens an order. Additional recipe capabilities,
expanded barcode workflows and an external integration endpoint remain future
work. Their historical internal issue numbers are not public issue identifiers.
