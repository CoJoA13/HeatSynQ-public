# 15. Glossary

[← Back to contents](README.md)

This chapter gives the meaning of the app's words for weights, quantities, containers, loads and
shipment completion. Each word has one meaning.

## Weights

All weights are in pounds and are shown with "lb", never "lbs".

| Term | Meaning | Formula |
|---|---|---|
| **Each weight** | The weight of one piece. Kept on the part. | |
| **Net weight** | The parts alone, with no container. For one order line, one quote line or one load, or summed for an order or a shipment. | quantity × each weight |
| **Tare each** | The weight of one empty container. A container type carries a default. | |
| **Tare total** | The empty containers of one row, or of an order or shipment. | tare each × containers |
| **Gross weight** | Parts and containers together: what a scale reads and what a truck carries. An order or shipment figure, never a container-row figure. | net weight + tare total |
| **Scale gross** | A gross weight read from a scale and typed in, as opposed to calculated. Used only to chase a quantity discrepancy. | |
| **Weighed net** | The parts' weight according to the scale. | scale gross − tare total |
| **Implied pieces** | The piece count the scale suggests, for an order whose lines all name one part. | weighed net ÷ each weight, to the nearest whole piece |

"Line" is a scope, not a weight: a line's weight is its net weight. A net weight is never net of
anything but containers.

In **Order totals** and in a shipment's totals, **Net**, **Tare** and **Gross** are short for net
weight, tare total and gross weight. A shipment's net weight is its ship-now net weights added up,
and its tare total is its own container rows' tare totals added up. The line at the top of a saved
order has no tare and no gross. On an order whose container rows were all weighed it ends with one
weight figure, in which **Net** is the order's net weight and **weighed** is its weighed net.

## Quantities

| Term | Meaning |
|---|---|
| **Quantity** | A count of pieces. Never a count of containers. |
| **Containers** | How many containers a row holds. |
| **Pieces** (on a container row) | The total pieces in that row's containers, not pieces per container. |
| **Ordered** | The quantity on the order line, as it stands now. |
| **Shipped to date** | The quantity on live shipments for a line. A voided shipment counts for nothing. |
| **Ship now** | The quantity this shipment sends. |

## Containers and loads

| Term | Meaning |
|---|---|
| **Container** | The customer's packaging the parts arrive and leave in: a skid, a bin, a wire basket. |
| **Load** | A subdivision of an order for processing, with its own traveler sheet. Loads are not containers, and shipments are not bound by load boundaries. |

## Shipment completion

| Term | Meaning |
|---|---|
| **Complete** (a line) | Shipped to date has reached ordered, or the line was closed short. Quantity decides; weight does not. |
| **Close short** | A person's decision on a shipment that a line which shipped under its ordered quantity is finished. |
| **Shipped** (an order) | Every line is complete. |
| **Partially shipped** (an order) | Something has shipped and at least one line is not complete. |

Some screens show another word. The printed documents and the template editor use the words in
this chapter, and every weight on paper carries "lb". The traveler prints **Each weight** and
**Net weight** for each line, and **Containers** and **Tare** for each container row. Beside them,
under the heading **Order totals**, it prints the order's **Net**, **Tare** and **Gross**. The
shipping ticket prints **Net weight** for each line, **Containers** and **Tare** for each
container row, and **Net weight**, **Tare** and **Gross weight** for its order; its tear-off strip
states the net weight only. On paper a container row's **Tare** is its tare total, printed over
its tare each, and **Tare** in the totals is the order's tare total. The certification, the
invoice and the quote print **Net weight**. The bill of lading prints one weight for the shipment
and says under it which it is: **Gross weight**, or **Net weight** when the shipment has no gross.
No document prints a gross weight for an order or a shipment with no containers, or with a
container row that has no tare each. A label typed into a template is that template's own and can
differ. The shipping ticket prints **Shipped Complete** when every line on it is complete.

---

Previous: [14. The practice copy](14-practice-copy.md) · [← Back to contents](README.md)
