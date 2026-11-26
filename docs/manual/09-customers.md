# 9. Customers

[← Back to contents](README.md)

The customer record is where the shop's commercial agreement with an account lives: their terms,
their tax status, their addresses, who to send paper to, and whether they are good for the work.

## The list

![The customers list](img/customers.png)

**Customers** shows **Code**, **Name**, **Parent**, **Credit hold** and **Active**, the last two
as **Yes** or **No**, so a held account is seen without opening anything. Search matches the code
or the name. Two views sit above the search box: **Active customers**, the usual list, and
**Include inactive**, which brings back the ones that have been retired. **Export to Excel**, under
**More actions** at the top right, gives you the list as it stands, in the view and search you have
applied.

New customers are added on the bottom row of the table — a **Code** and a **Name** is all it takes;
everything else is filled in on the record itself. **Add customer** at the top of the page takes
you straight to that row. **Paste from spreadsheet** opens a panel that takes a block of customers
at once (code, name, default PO and order notes).

## The customer record

![A customer record](img/customers-detail.png)

The title is the code and name, and under it the code again, **Active** or **Inactive**, and
**Division of AERO** when the customer has a parent. **Delete customer** sits at the top right. The
**At a glance** card beside the record shows the customer's **Terms**, whether they are on **Credit
hold**, and their **Open balance**, which is the Receivables section's net and shows a dash until
that section has read (it is left off for someone without receivables view).

The record is six tabs, every one of them live at once:

| Tab | What is on it |
|---|---|
| **Overview & notes** | **Identity** — the code, the name and the **Phone** (the customer's main number, which prints on the traveler under the received-from address), each editable in place — and the **Standing notes** |
| **Addresses & contacts** | **Addresses** and **Contacts** |
| **Terms & billing** | **Commercial settings** and **Surcharge overrides** |
| **Defaults & documents** | **Order defaults** and **Document templates** |
| **Receivables** | This customer's own A/R |
| **History** | The audit history, the addresses, contacts and overrides included |

> **Most fields save when you leave them or press Enter.** There is no Save button on this screen.
> Type, then tab or click away, or press **Enter**, which keeps the cursor in the box, and it is
> saved; a green **Saved** shows beside the box while it holds what was saved. If the app refuses
> a value the box snaps back to what was stored and a red message says why.

### Commercial settings

The commercial terms of the account, on **Terms & billing**. Five tick boxes — **Credit hold**,
**Taxable**, **COD**, **Active**, **Surcharge opt-out** — and then:

| Field | What it does |
|---|---|
| **Terms** | Their payment terms. This is what drives due dates and the early-pay discount |
| **Parent** | Makes this customer a division of another (below) |
| **Default PO** | Filled in for them at order entry |
| **Credit limit** | Recorded on the account |
| **Finance charge (monthly %)** | Their own monthly rate for the statement's finance-charge line, as a percent — 1.5 means 1.5% per month; blank uses the plant default |
| **Sales tax rate (%)** | Their own rate, entered as a percent — 7 means 7%; *"Blank uses the plant default."* Only ever used if **Taxable** is ticked |
| **Invoice folder** | Where this customer's finalized invoices and credits are filed when printed (chapter 6), pasted from Windows Explorer; blank files nothing |

**Taxable and the tax rate are two different decisions.** The tick box decides *whether* tax is
billed; the rate decides *at what rate*. Untick the box and the rate is ignored entirely.

**The Invoice folder is pasted, not typed.** Open the customer's folder in Windows Explorer, copy
the path from its address bar (it reads like `Z:\Customers\AERO`), paste it into the box and leave
it. The app checks that the folder is inside the office's shared folder and exists, and says
**Folder found.** beside the box. A path it refuses is not saved: the box goes back to what was
stored and the red message says why, for example *"No folder was found at that path. Check it in
Windows Explorer, then paste it again."* Leave the box blank to file nothing for this customer. An
install without the shared folder set up, the practice copy among them, refuses any folder: *"This
install has no invoice share set up, so an invoice folder cannot be saved."*

### Order defaults

What a new order for this customer starts with, on **Defaults & documents**:

| Field | What it does |
|---|---|
| **Request days override** | Their own lead time in days; blank uses the plant default |
| **Certification required** | Yes / No / inherit |
| **Certification scope** | By order / By load / By shipment, or inherit |
| **Suppress cert charge** | Tick it and their invoices carry no certification charge, even on an order that requires a cert |

The two certification controls have a three-way choice, and the inherit option tells you what it
currently means — *"Inherit plant — currently Yes"*, *"Inherit plant — currently By order"* — so you
are never guessing what leaving it alone will do. A part can override this again (chapter 10).

### Divisions

A division is just a customer with a **Parent** set, on **Commercial settings**. Choose the parent
from the dropdown and the line under the title changes to read **Division of AERO**. There is no
separate "add a division" action.

The app will not let you tangle the tree: *"A customer cannot be its own ancestor"* and *"That
parent would create a circular relationship"*. A parent cannot be deleted while it still has live
divisions.

> **Divisions inherit far less than people expect.** This trips people up, so it is worth being
> blunt about it.

| | Inherited from the parent? |
|---|---|
| Document templates | **Yes** — this is the only thing that inherits |
| Terms | No — set them on each division |
| Addresses and contacts | No — each division keeps its own |
| Credit hold, credit limit, tax, surcharge opt-out | No |
| Certification defaults | No — a division falls back to the **plant** setting, never the parent's |
| Invoice folder | No — a division's prints are filed in its own folder, never the parent's |

Two things *are* family-wide, and they are both about money coming in: **one cheque can settle
invoices across the whole family**, and a **statement can be printed combined** for the family or
one per division (chapter 7).

Setting a parent's terms does **not** push them down to the divisions. If the whole family trades on
2% 10 Net 30, every division needs it set.

### Surcharge overrides

Energy and similar surcharges are set up plant-wide (chapter 12); this section is where one customer
departs from them. Per surcharge you can tick **Opt out**, or type a **Rate override (%)** or an
**Amount override ($)**. A surcharge with nothing set says so in plain words — *"no override — bills
at the plant rate"* for a percent surcharge, *"…at the plant amount"* for a flat one — and **Clear
override** puts it back. An override or an opt-out reaches an open draft invoice when it is
recalculated, not when its lines are saved.

Changing prices is a guarded thing: this section needs `customers.edit` **and** the `change_prices`
action.

### Document templates

Which template each of the nine document types prints with for this customer, with the rule stated
on the screen: *"Unset types inherit the parent division's choice, then fall back to the type's
default."*

Every row tells you where its answer actually came from — **Assigned: Invoice — Aerospace layout**,
or **Inherited from AERO — Aerospace Dynamics Corp: …**, or **Invoice / credit default (Standard)**.
Leave a row on **Use default / inherit** and it follows the chain.

A template that has never been published is listed but cannot be chosen: *"This template has never
been published — publish a version before assigning it"*.

### Standing notes

Three free-text notes that surface at the three moments they matter: **At order entry**, **At
shipping**, **At invoicing**. Use them for the things a new person would not know — "always call
before delivery", "PO must appear on the invoice".

### Addresses

Three uses — **Ship to**, **Bill to** and **Received from** — listed with **Use**, **Name**,
**Street**, **City**, **State**, **Zip**, **Active** and **Default**, which reads **Yes** on the
address that use goes to.

**There is one default per use, not one per customer.** The first active address of a use becomes
that use's default on its own; after that, **make default** moves it. The app keeps this tidy for
you — an address that is deleted or deactivated never keeps the default, and it falls to another
live address of that use.

Which one gets used where:

| Document | Address used |
|---|---|
| Shipment and BOL | A **Ship to** you pick from that customer's live ship-to addresses; a shipment keeps showing and printing its own after it is made inactive or deleted |
| Invoice | The default **Bill to**, and the **Ship to** of the order's latest shipment (the customer's default **Ship to** when no shipment names one), frozen onto the invoice when it is raised |
| Certificate and statement | The default **Bill to** |
| Traveler | **Received from** |

### Contacts

**Name**, **Email**, **Phone**, and four tick boxes deciding what they get: **Shippers**,
**Invoices**, **Statements**, **Certs**.

Only the name is required. **Email is optional** — plenty of shop contacts are phone-only — but if
you type one it has to be a real address, because a typo fails silently when documents are sent.

### Receivables

That customer's own A/R: a **Net balance**, an aging strip across the buckets, and **Open items**
underneath — Document, Type, Date, Due date, Original, Open. Type reads **Invoice**, **Credit** or
**On account**. When there is nothing outstanding it says *"Nothing open — this customer is
settled."*

**This section is scoped to this customer alone.** It is never rolled up across a family, even for a
parent. That is deliberate, and it means:

> The same parent customer will show one figure here and a different one on the A/R aging report,
> and **both are right**. This section answers "what does this account owe". The aging report, when
> you filter it to a parent, answers "what does this family owe". Know which question you are
> asking.

It is also where credits are applied (**Apply**) and where a bad-debt balance is written off
(**Write off**) — see chapter 7.

## Credit hold

Credit hold is one tick box in Commercial settings (and a line on the At a glance card), and it
behaves differently at the two points it matters.

**At order entry it warns and lets you through.** The new-order screen shows an amber banner:

> *"⚠ CASC is on credit hold — orders can be entered; shipping will require release."*

That is the intended behaviour, not a leak. Taking the order costs nothing; letting the parts leave
the building is the decision.

**At shipment it stops you.** Saving a shipment for a held customer is refused:

> *"CASC · Cascade Spring Co is on credit hold — see /customers/… to lift it"*

Someone holding the **`override_credit_hold`** action can push it through, but only with a
**reason** — the shipping screen makes that explicit: *"Saving this shipment records a credit-hold
override. Reason (required, kept in the audit history — printed nowhere)."* A blank reason is
refused. Without that action there is no reason box at all, just *"Saving a shipment for them
requires the override_credit_hold action."*

The reason goes into the audit history and **never onto the paperwork** — the customer's BOL does
not announce that their credit was overridden.

**Lifting a hold** is untieing the box on the customer record, which needs `customers.edit`. That is
the route every refusal points at.

## Deleting a customer

**Delete customer**, at the top right of the record, opens a dialog that asks for a reason and
tells you exactly what it means:

> *"Its addresses and contacts are deleted with it. The code can be reused later, which starts a
> fresh customer rather than restoring this one."*

That last sentence matters. Re-using a deleted code does not bring the old customer back — it makes
a brand-new one with its own history.

A customer that is still in use will not delete, and the app names what is holding it: divisions,
parts, live orders, live quotes or live payments. For the counted ones a panel lists the actual
records with an **Export list to Excel** so you can work through them.

---

Next: [10. Parts and processes →](10-parts-and-processes.md) · Previous: [8. Month end](08-month-end.md)
