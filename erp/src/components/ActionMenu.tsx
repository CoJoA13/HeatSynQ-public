"use client";
// The "More actions" popover (spec 2026-10-30-ux-redesign-design.md §4.3): a <details> whose
// summary is a neutral button, the order hub's Order actions precedent, so it needs no outside
// listener to open; it closes when an item is chosen, on Escape, and when focus leaves it.
// Items are src/lib/action-menu.ts's; a disabled item keeps its reason as its title.
import { useRef } from "react";
import { itemTitle, type MenuItem } from "@/lib/action-menu";
import { BUTTON_NEUTRAL, CARD } from "@/lib/ui-classes";

export function ActionMenu({ label = "More actions", items }: { label?: string; items: MenuItem[] }) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  const close = () => { if (ref.current) ref.current.open = false; };
  return (
    <details ref={ref} className="relative"
             onKeyDown={(e) => { if (e.key === "Escape") close(); }}
             onBlur={(e) => { if (!ref.current?.contains(e.relatedTarget as Node | null)) close(); }}>
      <summary aria-haspopup="menu" className={BUTTON_NEUTRAL}>{label}</summary>
      <div role="menu" className={`${CARD} absolute right-0 z-20 mt-2 w-72 p-2 shadow-lg`}>
        {items.map((item) => {
          const className = `block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-surface-50${item.danger ? " text-danger-600" : ""}`;
          const body = <>{item.label}{item.sub && <span className="block text-xs text-ink-500">{item.sub}</span>}</>;
          // An href item is a document link (an export): the browser loads it and middle-click
          // opens it apart. It closes the menu on click (a download leaves the page in place), so it
          // carries no `data-navigation="document"`: #275 reserves that opt-out for an anchor with
          // no click handler (tests/document-navigation.test.tsx), and the Shell's capture guard
          // already lets an `/api/` href through on its own.
          return item.href !== undefined ? (
            <a key={item.label} role="menuitem" href={item.href} title={itemTitle(item)}
               onClick={close} className={className}>
              {body}
            </a>
          ) : (
            <button key={item.label} type="button" role="menuitem" disabled={item.disabled} title={itemTitle(item)}
                    onClick={() => { close(); item.onSelect(); }} className={className}>
              {body}
            </button>
          );
        })}
      </div>
    </details>
  );
}
