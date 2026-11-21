import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { handle, requireUser } from "@/server/http";
import { markSeen } from "@/server/updates";

const Body = z.object({ version: z.string() });

// Any signed-in user, own row only.
export const POST = handle(async (req) => {
  const user = requireUser();
  const { version } = Body.parse(await req.json());
  await markSeen(user.id, version);
  const row = await prisma.user.findFirst({ where: { id: user.id }, select: { lastSeenVersion: true } });
  return NextResponse.json({ lastSeenVersion: row?.lastSeenVersion ?? null });
});
