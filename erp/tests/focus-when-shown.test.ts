import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusWhenShown } from "@/lib/focus-when-shown";

// A box in a hidden tab panel has no offsetParent and takes no focus; RecordTabs shows the panel a
// render after `open` lands, so the focus waits a few frames for it, and gives up.
describe("focusWhenShown", () => {
  let frames: (() => void)[] = [];
  beforeEach(() => { frames = []; vi.stubGlobal("requestAnimationFrame", (cb: () => void) => { frames.push(cb); return frames.length; }); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const step = () => { const run = frames; frames = []; run.forEach((cb) => cb()); };
  const box = (shown: () => boolean) => ({ get offsetParent() { return shown() ? {} : null; }, focus: vi.fn(), scrollIntoView: vi.fn() });

  it("focuses once the box's panel shows, and stops", () => {
    let shown = false; const b = box(() => shown);
    focusWhenShown(() => b as unknown as HTMLElement);
    step(); step();
    expect(b.focus).not.toHaveBeenCalled();
    shown = true; step();
    expect(b.focus).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([]);
  });

  it("gives up after its frames", () => {
    const b = box(() => false);
    focusWhenShown(() => b as unknown as HTMLElement);
    for (let i = 0; i < 20; i++) step();
    expect(b.focus).not.toHaveBeenCalled();
    expect(frames).toEqual([]);
  });

  it("survives the box going away", () => {
    focusWhenShown(() => null);
    expect(() => { for (let i = 0; i < 20; i++) step(); }).not.toThrow();
  });
});
