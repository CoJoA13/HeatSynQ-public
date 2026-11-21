"use client";
// The shared section sub-nav (#303). Lifted verbatim out of `app/receivables/ReceivablesNav.tsx`,
// whose shape — and exact classes — this keeps, so the Receivables bar is byte-identical to what it
// rendered before and the Reports bar is the same strip rather than a second dialect.
//
// The active rule is Shell.tsx's `navIsActive` at a smaller scale: the FIRST tab is the section
// ROOT and matches by exact pathname, every other tab by prefix. Exact-for-root is load-bearing,
// not a nicety — a section root's href (`/receivables`, `/reports`) is a prefix of every sibling
// tab's href, so a prefix match would light the root up on every page in the section.
//
// No permission check of its own: every tab's destination page gates itself (§5.16) and says why if
// denied, which is also why the bar stays mounted in a screen's own denial branch.
//
// Every tab is a Next `Link` and none carries `data-navigation="document"` (#275): that marker
// belongs only on plain anchors that intentionally load a document, and on a `Link` it would skip
// the one guard that sees a client navigation.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PILL_ACTIVE, PILL_IDLE } from "@/lib/ui-classes";

export type Tab = { label: string; href: string };

/** The selected and unselected look of every tab strip (#644; the redesign's pill pair since ruling
 *  1 of 2026-10-30): TabNav's own, read too by the order hub's section jumps and New order's tabs,
 *  which keep their own element and behaviour. The strings are `src/lib/ui-classes.ts`'s, and
 *  `tests/tab-nav.test.tsx` refuses a strip that spells a colour of its own or any `border-b-2`. */
export const TAB_ACTIVE = PILL_ACTIVE;
export const TAB_IDLE = PILL_IDLE;

export function tabActive(href: string, rootHref: string, pathname: string): boolean {
  return href === rootHref ? pathname === href : pathname.startsWith(href);
}

export function TabNav({ label, tabs }: { label: string; tabs: Tab[] }) {
  const pathname = usePathname();
  const rootHref = tabs[0].href;
  return (
    <nav aria-label={label} className="mb-4 flex flex-wrap gap-2">
      {tabs.map((t) => {
        const active = tabActive(t.href, rootHref, pathname);
        return (
          <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined}
                className={active ? TAB_ACTIVE : TAB_IDLE}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
