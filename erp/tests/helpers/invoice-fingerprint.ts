import { createHash } from "node:crypto";
import { shipmentFingerprintSource } from "@/lib/invoice-shipment-fingerprint";

/** `Invoice.shipmentFingerprint` for an order with nothing shipped: what `createInvoice` would have
 *  stored. For fixtures that write a DRAFT invoice with raw Prisma on an order with no shipments and
 *  then finalize it through the service; without it finalize refuses the draft as never calculated. */
export const NOTHING_SHIPPED_FINGERPRINT =
  createHash("sha256").update(shipmentFingerprintSource({ lines: [], freight: [] })).digest("hex");
