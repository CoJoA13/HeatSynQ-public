# HeatSynQ glossary

The shop's words and what each one means here. One meaning per word. When a screen, a document or a
conversation uses a word differently, this file is right and the other is fixed.

Started 2026-10-06 from the owner's rulings on weights and shipment completion. Add a term when its
meaning is settled; record the words to avoid beside it. Entries marked *designed* describe an approved
design that the code does not follow yet; the code is what it does today.

## Weights

All weights are in pounds and are shown with "lb", never "lbs".

| Term | Meaning | Formula | Avoid |
|---|---|---|---|
| **Each weight** | The weight of one piece. Kept on the part. | | Part weight, each wt |
| **Net weight** | The parts alone, with no container. For one order line, one quote line or one load, or summed for an order or a shipment. | quantity × each weight | Line weight, pounds, pounds shipped, total weight, total wt, total lbs, ship now lbs, and "Weight" alone as a heading |
| **Tare each** | The weight of one empty container. A container type carries a default. | | |
| **Tare total** | The empty containers of one row, or of an order or shipment. | tare each × containers | Container weight, tare weight |
| **Gross weight** | Parts and containers together: what a scale reads and what a truck carries. An order or shipment figure, never a container-row figure. | net weight + tare total | |
| **Scale gross** | A gross weight read from a scale and typed in, as opposed to calculated. Used only to chase a quantity discrepancy. | | Actual weight |
| **Weighed net** | The parts' weight according to the scale. | scale gross − tare total | |
| **Implied pieces** | The piece count the scale suggests, for an order whose lines all name one part. | weighed net ÷ each weight, to the nearest whole piece | |

"Line" is a scope, not a weight: a line's weight is its net weight. A net weight is never net of
anything but containers.

Status: current. On paper every weight carries "lb", and **Tare** is a tare total: a container
row's in its column, the order's in the totals. A label typed into a document template is that
template's own.

## Quantities

| Term | Meaning | Avoid |
|---|---|---|
| **Quantity** | A count of pieces. Never a count of containers. | |
| **Containers** | How many containers a row holds. | Container quantity, count, # of containers |
| **Pieces** (on a container row) | The total pieces in that row's containers, not pieces per container. | Qty/container |
| **Ordered** | The quantity on the order line, as it stands now. | |
| **Shipped to date** | The quantity on live shipments for a line. A voided shipment counts for nothing. | |
| **Ship now** | The quantity this shipment sends. | |

Status: current.

## Containers and loads

| Term | Meaning |
|---|---|
| **Container** | The customer's packaging the parts arrive and leave in: a skid, a bin, a wire basket. |
| **Load** | A subdivision of an order for processing, with its own traveler sheet. Loads are not containers, and shipments are not bound by load boundaries. |

## Shipment completion

| Term | Meaning | Avoid |
|---|---|---|
| **Complete** (a line) | Shipped to date has reached ordered, or the line was closed short. Quantity decides; weight does not. | |
| **Close short** | A person's decision on a shipment that a line which shipped under its ordered quantity is finished. | Line complete, the Complete tick |
| **Shipped** (an order) | Every line is complete. | Shipped complete, closed |
| **Partially shipped** (an order) | Something has shipped and at least one line is not complete. | Shipped partial |

Status: current.
