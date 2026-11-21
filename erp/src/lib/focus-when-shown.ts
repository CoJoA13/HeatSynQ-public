// Takes the cursor to a box that may sit in a tab panel not shown yet: RecordTabs shows the panel a
// render after `open` lands, and a box in a hidden panel has no offsetParent and takes no focus, so
// this waits a few frames for it and then gives up. Returns the cancel. Client-safe.
export function focusWhenShown(get: () => HTMLElement | null): () => void {
  let frames = 0; let handle = 0;
  const tryFocus = () => {
    const box = get();
    if (box && box.offsetParent !== null) { box.focus(); box.scrollIntoView({ block: "center" }); return; }
    if (frames++ < 10) handle = requestAnimationFrame(tryFocus);
  };
  handle = requestAnimationFrame(tryFocus);
  return () => cancelAnimationFrame(handle);
}
