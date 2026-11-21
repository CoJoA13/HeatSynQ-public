# HeatSynQ — User Manual

The operator's guide to HeatSynQ. Screenshots use the real application with a
fictional demonstration dataset. Example dates, balances and records are illustrative.

**Sign in:** your username and password, at the address the office gives you. The first
administrator account is `admin` / `admin` and **must** have its password changed — the app
says so on a banner until you do.

## How this manual is organised

It follows the way work actually moves through the shop — an order arrives, it runs, it ships,
it gets certified, it gets billed, the money comes in — rather than the order of the menu.

| # | Chapter | What it covers |
|---|---|---|
| 1 | [Getting around](01-getting-around.md) | Signing in, the screen layout, search and the traveler barcode, what "you don't have permission" means |
| 2 | [Orders](02-orders.md) | The board, saved views, entering an order, the order hub, loads, travelers |
| 3 | [Quotes](03-quotes.md) | Quoting work, follow-ups, winning a quote into an order |
| 4 | [Shipping](04-shipping.md) | Shippers, containers and serials, multi-order shipments, the BOL, voiding |
| 5 | [Certifications](05-certifications.md) | Cert requirements, entering results, printing the certificate |
| 6 | [Invoicing](06-invoicing.md) | Creating and finalizing invoices, manual lines, credit memos, unlocking |
| 7 | [Receivables](07-receivables.md) | Deposit batches, applying payments, discounts, write-offs, aging, statements |
| 8 | [Month end](08-month-end.md) | Closing a period, the GL export, and what to hand the bookkeeper |
| 9 | [Customers](09-customers.md) | Customers and divisions, addresses, contacts, terms, credit hold |
| 10 | [Parts and processes](10-parts-and-processes.md) | Memorized parts, the recipe, prices, specifications, inspections |
| 11 | [Reports](11-reports.md) | Backlog, shipped, turnaround, sales, payments, the comparison scoreboard |
| 12 | [Administration](12-administration.md) | Users, roles and permissions, pick lists, settings, accounting, surcharges, the setup checklist, audit log, backups, updates |
| 13 | [Document templates](13-templates.md) | Designing the paper: what can be changed, what is locked, publishing |
| 14 | [The practice copy](14-practice-copy.md) | Training without touching real data, and resetting it |
| 15 | [Glossary](15-glossary.md) | What the words for weights, quantities, containers, loads and shipment completion mean |

## Two things worth knowing before you start

**Nothing is ever really deleted.** Deleting hides a record; it stays in the history with who
removed it and — for the destructive ones — why. Every change to every record is recorded, and
every record has a History panel showing before and after.

**The screens tell you why you cannot do something.** A greyed-out button carries the reason in
its tooltip or in the text beside it: a missing permission, a closed month, a voided order, a
finalized invoice. If a control is disabled and you cannot tell why, hover it — and if it still
is not clear, that is a fault worth reporting.

---

*Supporting material for maintainers:*

- [Documentation index](../README.md) — installation, operations and contributor guides.
- [Dataset workflow](dataset.md) — fictional data, complete capture and HTML rebuild.
- [Public database contract](../public-baseline.md) — fresh initialization and upgrade boundaries.
