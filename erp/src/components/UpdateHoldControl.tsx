"use client";
// The Hold / Release hold control the banner and the System page share (release-updates PR 3).
// `useHoldAction` owns the one-shot hold and the refusal line; `HoldControl` only draws.
import { useState } from "react";
import { PanelMessage } from "./PanelMessage";
import { BUTTON_NEUTRAL } from "@/lib/ui-classes";
import { oneShotHold } from "@/lib/single-flight";
import { invalidateUpdates, sendHold, type UpdateHoldState } from "@/lib/updates-client";

export function useHoldAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [hold] = useState(() => oneShotHold(setBusy));
  const run = (held: boolean) =>
    hold.run(async () => {
      setMessage(null);
      try { await sendHold(held); } catch (e) {
        setMessage((e as Error).message);
        invalidateUpdates(); // a refusal means the screen is out of date: read the server again
      }
    });
  return { busy, message, run };
}

/** Hold when not held, Release hold when held; disabled, with its reason, without admin.edit. */
export function HoldControl({ hold, canHold, busy, message, onHold }: {
  hold: UpdateHoldState | null; canHold: boolean; busy: boolean; message: string | null;
  onHold: (held: boolean) => void;
}) {
  const held = hold?.held === true;
  return (
    <>
      <button type="button" disabled={busy || !canHold} title={canHold ? undefined : "Requires admin.edit"}
              onClick={() => onHold(!held)} className={BUTTON_NEUTRAL}>
        {held ? "Release hold" : "Hold"}
      </button>
      <PanelMessage message={message} />
    </>
  );
}
