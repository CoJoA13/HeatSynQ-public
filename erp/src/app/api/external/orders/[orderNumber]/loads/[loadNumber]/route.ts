import { NextResponse } from "next/server";
import { INT4_MAX } from "@/lib/order-constants";
import { HttpError } from "@/server/errors";
import { authorizeExternalRecipeRead } from "@/server/external-recipe-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

function positiveInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= INT4_MAX ? number : null;
}

export async function GET(request: Request, context: { params: Promise<{ orderNumber: string; loadNumber: string }> }) {
  const access = authorizeExternalRecipeRead(request);
  if (!access.ok) {
    const error = access.status === 404 ? "Not found" : access.status === 401 ? "Unauthorized" : "Too many requests";
    return NextResponse.json({ error }, { status: access.status, headers: {
      ...headers, ...(access.retryAfter === undefined ? {} : { "Retry-After": String(access.retryAfter) }),
    } });
  }
  const params = await context.params;
  const orderNumber = positiveInt(params.orderNumber);
  const loadNumber = positiveInt(params.loadNumber);
  if (orderNumber === null || loadNumber === null) {
    return NextResponse.json({ error: "Invalid order or load number" }, { status: 400, headers });
  }
  try {
    // Only authorized, valid requests may initialize database modules. The shared handle
    // wrapper refreshes sessions, so this read-only integration uses native requests.
    const { readExternalLoad } = await import("@/server/external-loads");
    return NextResponse.json(await readExternalLoad(orderNumber, loadNumber), { headers });
  } catch (error) {
    const status = error instanceof HttpError && error.status === 404 ? 404 : 503;
    return NextResponse.json({ error: status === 404 ? "Not found" : "Service unavailable" }, { status, headers });
  }
}
