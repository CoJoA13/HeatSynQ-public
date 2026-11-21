import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { resolveUpdatesDir } from "@/server/update-paths";
import { setUpdateHold } from "@/server/updates";

const Body = z.object({ held: z.boolean() });

export const POST = handle(async (req) => {
  mustCan(requireUser(), "admin", "edit");
  const { held } = Body.parse(await req.json());
  return NextResponse.json(await setUpdateHold(held, resolveUpdatesDir()));
});
