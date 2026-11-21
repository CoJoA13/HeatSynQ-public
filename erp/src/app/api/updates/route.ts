import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { can } from "@/server/permissions";
import { practiceMode } from "@/server/practice-mode";
import { resolveUpdatesDir } from "@/server/update-paths";
import {
  currentUpdateStatus, getUpdateHold, reconcileHoldFile, whatsNewFor,
} from "@/server/updates";

// Every signed-in user sees what changed; the pending release and the hold are gated inside.
export const GET = handle(async () => {
  const user = requireUser();
  if (await practiceMode()) {
    return NextResponse.json({ running: null, whatsNew: [], pending: null, pendingNote: null, hold: null, canHold: false });
  }
  const dir = resolveUpdatesDir();
  const status = await currentUpdateStatus(dir);
  const viewer = can(user, "admin", "view");
  if (viewer) await reconcileHoldFile(dir);
  return NextResponse.json({
    running: status ? status.running.version : null,
    whatsNew: whatsNewFor(status, user.lastSeenVersion ?? null),
    pending: viewer ? status?.pending ?? null : null,
    // The pending release's notes, as the agent wrote them (before-tense); admin.view only.
    pendingNote: viewer && status?.pending ? status.notes.find((n) => n.version === status.pending!.version) ?? null : null,
    hold: viewer ? await getUpdateHold() : null,
    canHold: can(user, "admin", "edit"),
  });
});
