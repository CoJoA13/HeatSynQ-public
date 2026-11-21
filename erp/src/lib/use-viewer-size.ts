"use client";
// The two measurements the template editor's PDF frame is sized from (`src/lib/preview-frame.ts`):
// the window's inner height, and the width of the box the frame sits in. Each is null until the
// browser has answered (on the server, and in a static render), so a caller keeps its unmeasured
// shape until then.
import { useEffect, useState, useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/** The window's inner height in CSS px, following every resize; null on the server. */
export function useWindowHeight(): number | null {
  return useSyncExternalStore(subscribe, () => window.innerHeight, () => null);
}

/** A callback ref and the content width, in CSS px, of the element it is attached to, following
 *  its resizes; null until an element is attached and measured. A callback ref, so an element that
 *  mounts after the component (a panel that renders nothing until it has a layout) is measured too. */
export function useMeasuredWidth(): [(element: HTMLElement | null) => void, number | null] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (element === null || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width];
}
