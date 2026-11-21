/**
 * The multi-order-shipment shipping ticket's template contract (spec §5.3). One builder
 * (`buildShippingTicketDefinition`) serves both ticket shapes today, and this contract starts
 * STRUCTURALLY IDENTICAL to ./shipper.ts — deliberately as its own full copy, not a shared
 * object or factory: `SHIPPER` and `MOS_SHIPPER` are distinct docTypes free to diverge (spec
 * §4.1 — a multi-order shipment's paper resolves this type, a single-order shipment's the
 * other), and sharing the declaration would put one template's paper at the mercy of the
 * other's edits (the spec §5.4 per-file rule). A test pins that they start identical; when they
 * diverge, that test — not this comment — is what changes.
 *
 * Derivation notes (the two-group container fold and its 282pt budget, the one-date-knob
 * default, the configurable liability text) live in ./shipper.ts and apply here unchanged.
 */
import { defaultConfig, type TemplateConfig, type TemplateContract } from "./types";
import { CANVAS_GRID } from "./canvas";
import { NET_WEIGHT } from "../weight-terms";

// Each shop supplies its own approved wording. Stored versions retain their explicit text;
// the upgrade precondition rejects versions that would otherwise inherit a changed default.
const SHIPPER_LIABILITY_TEXT_DEFAULT = "";

/** The printed height of one body row of the ticket's ruled tables under the Standard (its base
 *  size 8, Roboto), measured by tests/shipping-ticket-templates.test.ts ("the ticket's canvas floors"),
 *  rounded up to a whole point; and the Order fields strip's height, a boxed heading row and one body
 *  row, measured the same way. The canvas profile's floors. */
export const TICKET_ROW_FLOOR = 15;
export const TICKET_FIRST_TABLE_ROOM = 29;
/** The totals block's least width (#971 design §6, owner ruling 6 and the controller's call C1): its
 *  rows print in one fixed 260 pt column at the block's right (`totalsBlock`,
 *  src/server/pdf/shipping-ticket.ts), which a narrower block would print past; plus one grid step. */
export const TICKET_TOTALS_LEAST_WIDTH = 260 + CANVAS_GRID;

export const MOS_SHIPPER_CONTRACT: TemplateContract = {
  docType: "MOS_SHIPPER",
  name: "Multi-order shipping ticket",
  sections: [
    {
      key: "header", name: "Header", hideable: true, reorderable: true,
      fields: [
        { key: "company_name", name: "Company name", defaultLabel: "", removable: true },
        { key: "title", name: "Document title", defaultLabel: "Shipping Ticket", removable: true },
        { key: "order_no", name: "Order number", defaultLabel: "Order No.:", removable: true },
        { key: "ship_date", name: "Ship date", defaultLabel: "Ship Date:", removable: true },
        { key: "company_address", name: "Company address", defaultLabel: "", removable: true },
        { key: "company_phone", name: "Company phone", defaultLabel: "", removable: true },
      ],
    },
    {
      key: "parties", name: "Sold to / Ship to", hideable: true, reorderable: true,
      fields: [
        { key: "sold_to", name: "Sold-to box", defaultLabel: "Sold To:", removable: true },
        { key: "ship_to", name: "Ship-to box", defaultLabel: "Ship To:", removable: true },
      ],
    },
    {
      key: "field_strip", name: "Order fields", hideable: true, reorderable: true,
      fields: [
        {
          key: "po_number", name: "Purchase order", defaultLabel: "Purchase Order Number",
          removable: true, column: { table: "field_strip", defaultWidth: "*" },
        },
        {
          key: "packing_list_no", name: "Packing list number", defaultLabel: "Packing List No",
          removable: true, column: { table: "field_strip", defaultWidth: "*" },
        },
        {
          key: "customer_job_no", name: "Customer job number", defaultLabel: "Customer Job No",
          removable: true, column: { table: "field_strip", defaultWidth: 110 },
        },
        {
          key: "route", name: "Route", defaultLabel: "Route", removable: true,
          column: { table: "field_strip", defaultWidth: 70 },
        },
        {
          key: "carrier", name: "Carrier", defaultLabel: "Carrier", removable: true,
          column: { table: "field_strip", defaultWidth: 85 },
        },
      ],
    },
    {
      key: "lines", name: "Part lines", hideable: true, reorderable: true,
      fields: [
        {
          key: "line_qty", name: "Quantity", defaultLabel: "Quantity", removable: true,
          column: { table: "lines", defaultWidth: 70 },
        },
        {
          key: "line_part", name: "Part identity",
          defaultLabel: "Part No.  /  Part Name  /  Part Description", removable: true,
          column: { table: "lines", defaultWidth: "*" },
        },
        {
          key: "line_pounds", name: NET_WEIGHT, defaultLabel: NET_WEIGHT, removable: true,
          column: { table: "lines", defaultWidth: 90 },
        },
      ],
    },
    {
      key: "containers", name: "Containers", hideable: true, reorderable: true,
      fields: [
        {
          key: "container_type", name: "Container type", defaultLabel: "Container Type",
          removable: true, column: { table: "containers", defaultWidth: 80 },
        },
        {
          key: "container_count", name: "Containers", defaultLabel: "Containers",
          removable: true, column: { table: "containers", defaultWidth: "*" },
        },
        {
          key: "container_tare", name: "Tare", defaultLabel: "Tare",
          removable: true, column: { table: "containers", defaultWidth: "*" },
        },
        {
          key: "cust_cont_id", name: "Customer container id", defaultLabel: "Cust Cont Id",
          removable: true, column: { table: "containers", defaultWidth: 62 },
        },
      ],
    },
    {
      key: "serials", name: "Serial numbers", hideable: true, reorderable: true,
      fields: [
        { key: "serials", name: "Serial numbers", defaultLabel: "Serial Numbers:", removable: true },
      ],
    },
    {
      key: "liability", name: "Liability text", hideable: true, reorderable: true, fields: [],
    },
    {
      key: "totals", name: "Totals", hideable: true, reorderable: true,
      fields: [
        {
          key: "shipped_complete", name: "Shipped-complete banner",
          defaultLabel: "Shipped Complete", removable: true,
        },
        {
          key: "total_qty", name: "Quantity shipped", defaultLabel: "Quantity Shipped:",
          removable: true,
        },
        {
          key: "total_weight", name: NET_WEIGHT, defaultLabel: "Net weight:",
          removable: true,
        },
        { key: "total_tare", name: "Tare", defaultLabel: "Tare:", removable: true },
        { key: "total_gross", name: "Gross weight", defaultLabel: "Gross weight:", removable: true },
      ],
    },
    {
      key: "tear_off", name: "Tear-off strip", hideable: true, reorderable: true,
      fields: [
        { key: "tear_order_no", name: "Order number", defaultLabel: "Order No.:", removable: true },
        {
          key: "tear_shipped_complete", name: "Shipped complete", defaultLabel: "Shipped Complete",
          removable: true,
        },
        {
          key: "tear_total_qty", name: "Quantity shipped", defaultLabel: "Quantity Shipped:",
          removable: true,
        },
        {
          key: "tear_total_weight", name: NET_WEIGHT, defaultLabel: "Net weight:",
          removable: true,
        },
        { key: "received_by", name: "Received by", defaultLabel: "Received By:", removable: true },
        { key: "received_date", name: "Received date", defaultLabel: "Date:", removable: true },
        { key: "tear_sold_to", name: "Sold to", defaultLabel: "Sold To:", removable: true },
        { key: "shipped_on", name: "Shipped on", defaultLabel: "Shipped ON:", removable: true },
      ],
    },
  ],
  textBlocks: [
    {
      key: "shipper_liability_text", name: "Liability text",
      defaultText: SHIPPER_LIABILITY_TEXT_DEFAULT,
    },
  ],
  formats: { thousandsSeparator: true, dateFormat: "M/D/YYYY" },
  fonts: { family: "Roboto", baseSize: 8, headingSize: 16, smallSize: 5.5 },
  tableBudgets: { containers: 282 },
  // The canvas profile (design 2026-11-08 §4.1): five tables (the serial list a heading alone, the
  // totals a rows block), nothing required, no barcode; the serial list's heading and the totals'
  // rows are never field items; the Sold To and Ship To fields print in a border.
  canvas: {
    paper: "shipping ticket",
    tables: [
      { key: "field_strip", keyed: "section", heading: null, rows: false, printed: { kind: "boxed", copies: 1, head: { size: "base" } } },
      { key: "lines", keyed: "section", heading: null, rows: false, printed: { kind: "ruled", copies: 1, head: { size: "base" } } },
      { key: "containers", keyed: "section", heading: null, rows: false, printed: { kind: "ruled", copies: 2, head: { size: "base" } } },
      { key: "serials", keyed: "section", heading: "serials", rows: false, printed: null },
      { key: "totals", keyed: "section", heading: null, rows: true, printed: null },
    ],
    required: [],
    barcode: false,
    notFields: ["serials", "shipped_complete", "total_qty", "total_weight", "total_tare", "total_gross"],
    boxedFields: ["sold_to", "ship_to"],
    ruledFields: [],
    leastWidths: { totals: TICKET_TOTALS_LEAST_WIDTH },
    rowFloor: TICKET_ROW_FLOOR,
    firstTableRoom: TICKET_FIRST_TABLE_ROOM,
  },
};

export const DEFAULT_CONFIG: TemplateConfig = defaultConfig(MOS_SHIPPER_CONTRACT);
