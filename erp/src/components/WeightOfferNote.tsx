"use client";
// The offered weight (the quantity corrections design §4): after a quantity changes, quantity × each
// weight is shown as a sum with one control to accept it. It is never applied silently, because the
// weight already there may be a deliberate received weight. Presentation only: no state, no hook, no
// request. Whether there is an offer, and its figures and wording, are decided in
// src/lib/net-weight.ts; the screen that renders this decides what accepting does.
import type { ReactNode } from "react";
import { weightOfferBlocked, weightOfferSum, weightOfferUse, type WeightOffer } from "@/lib/net-weight";
import { LINK } from "@/lib/ui-classes";

/**
 * Shared by the order hub's Lines section and the shipment Lines grid. The text size and the
 * element around it are the caller's.
 *
 * `disabled` and `title` are the caller's own gate (permission, a voided record, a save in flight).
 * A figure below what has already shipped is blocked here whatever the caller says: the order line
 * cannot take it, so the control is disabled and the reason is both the control's title and text
 * after it, where it can be read without hovering.
 */
export function WeightOfferNote({ offer, disabled, title, onUse }: {
  offer: WeightOffer;
  disabled: boolean;
  title?: string;
  onUse: () => void;
}): ReactNode {
  const blocked = weightOfferBlocked(offer);
  return (
    <>
      <span className="text-ink-500">{weightOfferSum(offer)}</span>
      <button type="button" disabled={disabled || offer.belowShipped !== null} title={blocked ?? title}
              // Keep focus where it is until the click, as DiscardButton does. On the order hub the
              // Qty and Weight boxes save on blur: without this the pointer-down blurs a weight box
              // holding typed text, that blur saves the typed text, the hub disables this control
              // while that save is out, and the click never lands. This handler does not affect
              // keyboard activation: Enter or Space on the control still accepts. After a keyboard
              // activation the offer goes (at once in the shipment grid, when the weight save
              // lands on the hub), this button unmounts with focus on it, and nothing returns
              // focus to the box.
              onPointerDown={(event) => event.preventDefault()} onClick={onUse}
              className={`${LINK} ml-2`}>
        {weightOfferUse(offer)}
      </button>
      {blocked !== null && <span className="ml-2 text-accent-600">{blocked}</span>}
    </>
  );
}
