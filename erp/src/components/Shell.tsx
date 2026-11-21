"use client";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { railVersion } from "@/lib/build-version";
import { api } from "@/lib/fetcher";
import { useLatest } from "@/lib/use-latest";
import { visibleGroups, navIsActive, isAdminGroup } from "@/lib/nav";
import { RAIL_ADMIN_KEY, readAdminExpanded, storeAdminExpanded } from "@/lib/rail-admin-toggle";
import { initials } from "@/lib/initials";
import { CHIP, BUTTON_NEUTRAL_COMPACT } from "@/lib/ui-classes";
import { RAIL_INSET_VAR, RAIL_MAX_HEIGHT, railInset } from "@/lib/rail-fit";
import {
  shouldGuardNavigation, leavesCurrentPage,
} from "@/lib/unsaved-guard";
import { DraftsInTab } from "./DraftsInTab";
import { ModalHost } from "./ModalHost";
import { WhatsNewDialog } from "./WhatsNewDialog";
import { getBrowserDraftSession, sessionCheckStatus } from "@/lib/draft-session";
import { identityCheckKey, bindIdentityRechecks } from "@/lib/identity-recheck";
import { useDraftCount } from "@/lib/use-recoverable-draft";
import type { NavigationAttempt } from "@/lib/navigation-attempts";
import { captureDiscardNavigation, invalidateDiscardNavigation, confirmDiscard } from "@/lib/use-unsaved-section";
import { newId } from "@/lib/client-id";

type Me = { id: string; displayName: string; permissions: string[] };

// Local mirror of src/server/search.ts's SearchResults — not imported from src/server/**
// (CLAUDE.md "Constraints that will bite you": a client component pulling from there drags
// node:async_hooks and Prisma into the browser bundle).
type SearchResults = {
  exactOrderId: string | null;
  exactLoadNumber?: number;
  scanError?: string;
  orders: { id: string; orderNumber: number; customerCode: string; poNumber: string; leadPartNumber: string }[];
  parts: { id: string; partNumber: string; customerCode: string; name: string }[];
  customers: { id: string; code: string; name: string }[];
};

// The rail's groups, the visible-groups decision and the active-entry rule live in src/lib/nav.ts —
// a pure client-safe module so all three are unit-testable (tests/nav.test.ts). THE NAV DECISION
// (Task 16) is documented there: Document templates sits in the Configuration group but is gated
// on `templates.view` specifically, and a group heading renders only when one of its entries is
// visible.

// The rail's sticky scroll wrapper, kept to the viewport it can actually see. The rule and the
// reasoning are in src/lib/rail-fit.ts: the root layout stacks banners ABOVE <Shell>, a sticky
// element cannot see them, and they appear, disappear and scroll away on their own — so the
// wrapper's inset from the window's top is MEASURED, and its max-height is the viewport less that.
// A component of its own, not an effect in Shell: Shell's /login and session-pending early returns
// render no rail, and an effect declared up there would run once against nothing and never again.
function RailWrapper({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // A LAYOUT effect, not a passive one (GitLab Duo on !347): the practice banner is server-rendered
  // and so is already above the Shell at first paint, and a passive effect would let one hydrated
  // frame paint with the viewport-only fallback before correcting it. The fetched banners arrive
  // after mount either way.
  useLayoutEffect(() => {
    const wrapper = ref.current;
    const column = wrapper?.parentElement;
    if (!wrapper || !column) return;
    let applied: number | null = null;
    const measure = () => {
      // The column (the <aside>) is in normal flow, so its top edge is exactly how far the banners
      // push the rail down — negative once the page has scrolled past them, which railInset reads
      // as zero. Written only when it changes.
      const inset = railInset(column.getBoundingClientRect().top);
      if (inset === applied) return;
      applied = inset;
      wrapper.style.setProperty(RAIL_INSET_VAR, `${inset}px`);
    };
    // At most one layout read per frame (GitLab Duo on !347): the order board runs to several
    // thousand pixels, and `scroll` fires far more often than the screen repaints.
    let frame: number | null = null;
    const scheduleMeasure = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    measure();
    window.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);
    // A banner appearing or disappearing above the Shell moves the column without a scroll or a
    // resize. It always changes the document's height — the Shell is min-h-screen, so the body is
    // the banners plus at least one viewport — which the body's box reports.
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(document.body);
    return () => {
      window.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);
  return (
    // As tall as the space it has, not only at most that (#542): the inner column then puts the
    // build version at the foot of the window when the links are short, and after the last link
    // when they scroll.
    <div ref={ref} className="sticky top-0 overflow-y-auto" style={{ maxHeight: RAIL_MAX_HEIGHT, height: RAIL_MAX_HEIGHT }}>
      <div className="flex min-h-full flex-col">{children}</div>
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  const navigationLifetime = useRef({ live: false });
  useEffect(() => {
    const token = { live: true };
    navigationLifetime.current = token;
    return () => { token.live = false; };
  }, []);
  useEffect(() => {
    // A public pathname change is ambiguous: retain drafts and retire any pending intent.
    invalidateDiscardNavigation();
  }, [pathname]);
  useEffect(() => {
    window.addEventListener("popstate", invalidateDiscardNavigation);
    return () => window.removeEventListener("popstate", invalidateDiscardNavigation);
  }, []);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A close/Enter can precede the query effect. In that case there is no timer to clear yet;
  // the effect must also know that the latest query edit no longer requests a debounce.
  const debounceAllowed = useRef(false);
  const searchId = useId();
  const listboxId = `${searchId}-results`;
  const resultHrefs = results ? [
    ...results.orders.map((o) => `/orders/${o.id}${results.exactLoadNumber !== undefined ? `?load=${results.exactLoadNumber}#load-${results.exactLoadNumber}` : ""}`),
    ...results.parts.map((p) => `/parts/${p.id}`),
    ...results.customers.map((c) => `/customers/${c.id}`),
  ] : [];
  const activeHref = open && activeIndex !== null ? resultHrefs[activeIndex] : undefined;
  const activeOptionId = activeHref ? `${searchId}-option-${activeIndex}` : undefined;

  useEffect(() => {
    if (activeOptionId) {
      document.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activeOptionId]);

  const draftSummary = useDraftCount();
  const [authFailed, setAuthFailed] = useState(false);
  const [authRetry, setAuthRetry] = useState(0);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  // The "Settings & administration" toggle (spec 2026-10-30 §4.2, ruling 6): expanded until this
  // browser's own click collapsed it. Read in an effect, never at render, so the server and the
  // first client render agree; every storage access is guarded (private windows throw).
  const [expanded, setExpanded] = useState(true);
  const adminId = `${searchId}-admin`;
  useEffect(() => {
    try { setExpanded(readAdminExpanded(localStorage.getItem(RAIL_ADMIN_KEY))); } catch { /* storage unavailable: stay expanded */ }
  }, []);
  function toggleAdmin() {
    const next = !expanded;
    setExpanded(next);
    try {
      const value = storeAdminExpanded(next);
      if (value === null) localStorage.removeItem(RAIL_ADMIN_KEY); else localStorage.setItem(RAIL_ADMIN_KEY, value);
    } catch { /* storage unavailable: the state still toggles for this page */ }
  }
  // The identity check runs on mount, on leaving /login and on Retry, and for the Shell's lifetime
  // on a persisted pageshow, the tab becoming visible again and a 401, never on a route change
  // (ruling R2, #607; the decision is src/lib/identity-recheck.ts). Each check raises the holding
  // screen below until it lands.
  const identityKey = identityCheckKey(pathname);
  useEffect(() => {
    if (identityKey === "login") return;
    const session = getBrowserDraftSession();
    if (!session) return;
    let live = true;
    const validate = async () => {
      setAuthFailed(false);
      const result = await session.validateIdentity(() => api<Me>("/api/auth/me"));
      if (!live || result.kind === "stale") return;
      if (result.kind === "ready") setMe(result.data);
      else if (result.kind === "expired") { setMe(null); router.push("/login"); }
      else setAuthFailed(true);
    };
    void validate();
    const unbind = bindIdentityRechecks({ window, document, subscribeUnauthorized: session.subscribeUnauthorized }, () => { void validate(); });
    return () => { live = false; unbind(); };
  }, [identityKey, router, authRetry]);

  // THE UNSAVED-EDIT GUARD (the Shell half; the registry and both predicates are in
  // src/lib/unsaved-guard.ts). A detail page runs two save models at once — blur-save fields above
  // grids that need an explicit "Save X" click — and before this, an edited-but-unsaved grid was
  // discarded silently the moment anyone clicked a nav link. Mounted here because the Shell owns
  // the rail and the search results, which is where that click almost always is; the listener is
  // on `document` in the CAPTURE phase so it runs before next/link's own handler navigates.
  //
  // Both halves are needed and neither covers the other: `beforeunload` is the only thing that can
  // catch a reload, a close, or a typed URL, and it CANNOT catch an in-app route change (no
  // document unload happens); the click guard is the only thing that can catch the in-app case, and
  // it cannot see a reload. Programmatic navigation is covered separately, by `confirmDiscard`
  // above at each `router.push` — a push produces neither a click nor an unload.
  //
  // Plain page anchors declare data-navigation="document" (#275), leaving their one confirmation
  // to beforeunload. The marker belongs only on anchors using the browser's native navigation,
  // never Next Link or a router.push handler. Unmarked links retain the click guard. No acceptance
  // flag is kept, so canceled navigation cannot disarm the next departure. Exports and document
  // viewers retain the predicate's existing exclusions.
  //
  // Back/forward is nonblocking. The document draft registry retains work, and popstate
  // invalidates pending departure attribution without touching history or consuming drafts.
  // The document session independently owns the immediate beforeunload guard.

  useEffect(() => {
    function onClickCapture(e: MouseEvent) {
      const target = e.target instanceof Element ? e.target : null;
      const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
      const raw = anchor?.getAttribute("href") ?? null;
      if (!shouldGuardNavigation({
        // A bare hash keeps its raw form so the predicate can recognise an in-page jump; anything
        // else is normalised through the anchor's resolved pathname, so an absolute same-origin
        // href compares against location.pathname on equal terms.
        href: raw === null ? null : raw.startsWith("#") ? raw : `${anchor!.pathname}${anchor!.hash}`,
        sameOrigin: anchor !== null && anchor.origin === window.location.origin,
        currentPath: window.location.pathname,
        modifierKey: e.ctrlKey || e.metaKey || e.shiftKey || e.altKey,
        newTab: anchor?.target === "_blank",
        download: anchor?.hasAttribute("download") ?? false,
        defaultPrevented: e.defaultPrevented,
        documentNavigation: anchor?.dataset.navigation === "document",
      })) return;
      const token = navigationLifetime.current;
      const attempt = captureDiscardNavigation(() => token.live && navigationLifetime.current === token);
      if (!confirmDiscard()) {
        attempt?.cancel();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Default Link navigation is merely requested; no public commit proves attribution.
      if (attempt && !attempt.attach(`${anchor!.pathname}${anchor!.search ?? ""}${anchor!.hash}`)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    // Eligible clean departures also supersede held callbacks before the URL changes.
    document.addEventListener("click", onClickCapture, true);
    return () => { document.removeEventListener("click", onClickCapture, true); };
  }, []);

  async function signOut() {
    // Before the logout request, not after: once the session is dropped there is no way back to
    // the page holding the edits.
    invalidateDiscardNavigation();
    if (!confirmDiscard({ allDrafts: true })) return;
    setLogoutError(null);
    try {
      const success = await getBrowserDraftSession()?.logout(() => api("/api/auth/logout", { method: "POST" }));
      if (success) { setMe(null); router.push("/login"); }
    } catch { setLogoutError("Sign out failed. Your drafts are retained. Please retry."); }
  }

  // Named `latest`, not `gate` — this file has no `gate()` import of its own, but the parts/
  // customers page precedent always names this binding `latest` for readability at the call
  // sites below, so this file keeps that name too.
  const latest = useLatest();
  // F7 (parts/page.tsx precedent): ticket-gated on BOTH the success and the failure path — a
  // superseded request's rejection landing after a newer request already succeeded must not
  // overwrite fresh results with a stale failure message, and a superseded success must not
  // overwrite a newer one either.
  //
  // Resolves to `null` on failure rather than rethrowing. The debounce timer below fires this
  // with `void runSearch(term)` and attaches no `.catch` — `void` only tells the linter this
  // promise is deliberately not awaited, it does not attach a rejection handler, so a rethrow
  // here would be a genuine unhandled promise rejection at runtime for any search that fails
  // before the Enter path ever calls it. Returning `null` after recording `searchError` keeps
  // this function's promise always-resolving, so no caller needs to remember to catch it —
  // `onSearchKeyDown` below checks the result instead of using try/catch.
  const runSearch = useCallback(async (term: string): Promise<SearchResults | null> => {
    const t = latest.next();
    let data: SearchResults;
    try {
      data = await api<SearchResults>(`/api/search?q=${encodeURIComponent(term)}`);
    } catch (e) {
      if (latest.isCurrent(t)) {
        setSearchError((e as Error).message);
        setResults(null);
        setActiveIndex(null);
        setOpen(false);
      }
      return null;
    }
    // Obsolete data must not escape to the immediate-Enter caller either: suppressing only
    // the dropdown still let a cancelled exact lookup navigate after Escape, blur or typing.
    if (!latest.isCurrent(t)) return null;
    setResults(data);
    setActiveIndex(null);
    setOpen(!data.scanError);
    setSearchError(data.scanError ?? null);
    return data;
  }, [latest]);

  // Debounced 250ms dropdown (design spec §11). A blank query means nothing to search — clears
  // any stale dropdown/error rather than leaving one on screen from a term the user has since
  // erased.
  useEffect(() => {
    const term = query.trim();
    if (!term) {
      // Bump the ticket so an in-flight search for the erased term cannot land after this clear
      // and re-open the dropdown under an empty box — the debounce may already have fired, and
      // selectResult/Enter clear the box mid-flight while navigating (Shell never remounts, so
      // the stale response would otherwise re-open over the NEW page). A discarded ticket
      // nothing will ever match: the makeLatestGate discipline.
      latest.next();
      setResults(null);
      setActiveIndex(null);
      setOpen(false);
      setSearchError(null);
      return;
    }
    if (!debounceAllowed.current) return;
    const timer = setTimeout(() => {
      debounceRef.current = null;
      void runSearch(term);
    }, 250);
    debounceRef.current = timer;
    return () => clearTimeout(timer);
  }, [query, runSearch, latest]);

  // Barcode scanners type an order number or ORDER-LOAD then send Enter near-instantly — often faster than the 250ms
  // debounce window — so Enter cannot simply read whatever `results` happens to already hold. It
  // cancels any pending debounce timer and issues its own immediate, ticket-gated search, and
  // navigates on THAT response's `exactOrderId`. This is the scan path (task-12-brief.md).
  // A deliberate close (Escape, blur) also discards any in-flight search: without the ticket
  // bump, a late current-ticket response would re-open the dropdown the user just closed (same
  // makeLatestGate discipline as the blank-query branch above).
  function cancelDebounce() {
    debounceAllowed.current = false;
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    debounceRef.current = null;
  }

  function closeSearchDropdown(cancelNavigation = true) {
    if (cancelNavigation) invalidateDiscardNavigation();
    cancelDebounce();
    latest.next();
    setOpen(false);
    setActiveIndex(null);
  }

  function changeQuery(value: string) {
    invalidateDiscardNavigation();
    cancelDebounce();
    latest.next();
    debounceAllowed.current = true;
    setQuery(value);
    setResults(null);
    setActiveIndex(null);
    setOpen(false);
    setSearchError(null);
  }

  /**
   * `confirmDiscard`, but only when the destination is a different page.
   *
   * The click guard gets this for free — `shouldGuardNavigation` already refuses to prompt for the
   * path already open — but these two search paths call `router.push` directly and so asked
   * unconditionally. Searching for the order you already have open is a routine lookup, and
   * pushing to the same keyed detail page does not unmount the editor: accepting the prompt
   * discarded nothing, and the edits stayed registered afterwards, so it was a repeatable warning
   * about nothing (Codex P2 on !272). Same rule, one function, both callers.
   */
  function confirmDiscardBefore(href: string): boolean {
    const [path] = href.split(/[?#]/);
    return leavesCurrentPage(path, pathname) ? confirmDiscard() : true;
  }

  async function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape" || e.key === "Tab") {
      closeSearchDropdown();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!open || resultHrefs.length === 0) return;
      e.preventDefault();
      const down = e.key === "ArrowDown";
      setActiveIndex((index) => index === null
        ? (down ? 0 : resultHrefs.length - 1)
        : Math.max(0, Math.min(resultHrefs.length - 1, index + (down ? 1 : -1))));
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (activeHref) {
      selectResult(activeHref);
      return;
    }
    const term = query.trim();
    if (!term) return;
    const token = navigationLifetime.current;
    const attempt = captureDiscardNavigation(() => token.live && navigationLifetime.current === token);
    if (!attempt) return;
    cancelDebounce();
    const data = await runSearch(term);
    if (!data || !attempt.isCurrent()) { attempt.cancel(); return; }
    if (data.exactOrderId) {
      const load = data.exactLoadNumber;
      selectResult(`/orders/${data.exactOrderId}${load !== undefined ? `?load=${load}#load-${load}` : ""}`, attempt);
    }
    else attempt.cancel();
  }

  function selectResult(href: string, captured?: NavigationAttempt) {
    // A scan must refresh even when the same load is already open. Keep the page's order key
    // unchanged so this refresh uses the existing edit/recovery guards and retains drafts.
    if (/^\/orders\/[^/?#]+\?load=\d+#load-\d+$/.test(href)) {
      href = href.replace("#", `&scan=${newId()}#`);
    }
    const token = navigationLifetime.current;
    const attempt = captured ?? captureDiscardNavigation(() => token.live && navigationLifetime.current === token);
    if (!attempt || !attempt.isCurrent()) return;
    if (!confirmDiscardBefore(href)) { attempt.cancel(); return; }
    if (!attempt.isCurrent()) return;
    const departing = leavesCurrentPage(href.split(/[?#]/)[0], pathname);
    if (departing && !attempt.attach(href)) return;
    closeSearchDropdown(false);
    setQuery("");
    setResults(null);
    if (!departing) attempt.cancel();
    try { router.push(href); }
    catch { attempt.cancel(); setSearchError("Navigation failed. Please try the search again."); }
  }

  function optionProps(index: number) {
    const selected = activeHref !== undefined && activeIndex === index;
    return {
      id: `${searchId}-option-${index}`,
      role: "option" as const,
      tabIndex: -1,
      "aria-selected": selected,
      className: `block w-full px-2 py-1 text-left ${selected
        ? "bg-line text-ink-800" : "hover:bg-surface-50"}`,
    };
  }

  if (pathname === "/login") return <>{children}</>;
  if (!me || !draftSummary.identityReady || me.id !== draftSummary.owner?.userId) return <main className="p-6">
    <p role="status">{sessionCheckStatus(authFailed, draftSummary)}</p>
    <button type="button" onClick={() => setAuthRetry(value => value + 1)}
            className={`${BUTTON_NEUTRAL_COMPACT} mt-2`}>Retry session check</button>
  </main>;

  // The rail groups this user can see, each already reduced to its visible entries — a heading
  // renders iff one of its entries does (src/lib/nav.ts's nav decision).
  const groups = visibleGroups(me.permissions);
  const dailyGroups = groups.filter((g) => !isAdminGroup(g));
  const adminGroups = groups.filter(isAdminGroup);
  const noMatches = results !== null
    && results.orders.length === 0 && results.parts.length === 0 && results.customers.length === 0;
  // One group of the rail. The first VISIBLE group carries no top padding, whichever group that
  // turns out to be for this user (src/lib/nav.ts's nav decision decides which are visible).
  const renderGroup = (g: (typeof groups)[number], first: boolean) => (
    <div key={g.heading ?? "separator"}>
      {g.heading !== null && (
        <div className={`${first ? "pt-1" : "pt-3"} px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-ink-300`}>
          {g.heading}
        </div>
      )}
      <div className="space-y-1">
        {g.entries.map((n) => {
          const active = navIsActive(n.href, pathname);
          return (
            <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined}
                  className={`block rounded-md px-3 py-2 hover:bg-ink-700 ${active ? "bg-ink-700 font-semibold text-white" : ""}`}>
              {n.label}
            </Link>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-surface-50">
      {/* STICK THE INNER WRAPPER, NOT THE <aside>. The aside stays in normal flow and stretches to
          the full page height (a flex item at the default align-items:stretch), which is what keeps
          the dark column running the whole way down a long page — the order board runs to several
          thousand px. Sticking the aside itself would instead end that column at one viewport
          height, a purely cosmetic regression on every screen taller than the viewport, the manual's
          captures included. What has to stay put is the LINKS: before this, scrolling the board far
          enough left the operator with no navigation on screen at all.
          Scrolling the wrapper — never growing it — is the other half, and is not optional: a pinned
          rail is clipped at the viewport, so on a short screen (or for an administrator, whose seven
          groups run past 900px) its last entries would be unreachable rather than merely off-screen.
          RailWrapper sizes it to the viewport it can actually SEE — the window less whatever the root
          layout stacks above the Shell (the practice, setup, default-password and backup banners),
          re-measured as those come and go and as the page scrolls (src/lib/rail-fit.ts has the
          rule). e2e/lib/rail.mjs proves, from the top of the page with the banners up, that the last
          and first entries are reachable at a 600px-tall window. */}
      <aside className="w-[216px] shrink-0 bg-ink-900 text-ink-200">
        <RailWrapper>
          {/* The wordmark as text (spec 2026-10-30 §4.2): the brand asset stays for the login page. */}
          <div className="flex h-15 items-center px-4 text-[25px] font-semibold leading-none text-white">
            HeatSyn<span className="text-accent-400">Q</span>
          </div>
          <p className="px-4 pb-6 text-[10px] font-medium uppercase tracking-wide text-ink-300">Heat treating</p>
          <nav aria-label="Main" className="px-2 pb-4 text-sm">
            {dailyGroups.map((g, i) => renderGroup(g, i === 0))}
            {/* The admin groups fold under one toggle (ruling 6 of 2026-10-30), drawn only when this
                user can see at least one of them; expanded by default, collapsed by this browser's
                own click (src/lib/rail-admin-toggle.ts). The `hidden` panel keeps the links in the
                DOM for the rail-fit measurement and out of the tab order while collapsed. */}
            {adminGroups.length > 0 && <>
              <hr className="mx-2 my-2 border-ink-700" />
              <button type="button" aria-expanded={expanded} aria-controls={adminId} onClick={toggleAdmin}
                      className="block w-full rounded-md px-3 py-2 text-left text-xs text-ink-300 hover:bg-ink-700">
                Settings &amp; administration
              </button>
              <div id={adminId} hidden={!expanded}>
                {adminGroups.map((g) => renderGroup(g, false))}
              </div>
            </>}
          </nav>
          {/* The user row and the build this install runs (#542), for anyone reporting a problem:
              the label is baked in at build time by next.config.ts, "unknown" when the build could
              read no commit. Sign out lives here (ruling 6), not in the header. */}
          <div className="mt-auto px-4 pb-3 pt-2">
            <hr className="mb-2 border-ink-700" />
            <div className="flex items-center gap-2 text-sm text-white">
              <span className={CHIP} aria-hidden="true">{initials(me.displayName)}</span>
              <span className="truncate">{me.displayName}</span>
              <button type="button" onClick={signOut} className="ml-auto shrink-0 text-xs text-ink-300 underline">Sign out</button>
            </div>
            {logoutError && <p role="alert" className="mt-1 text-xs text-red-300">{logoutError}</p>}
            {(() => {
              const build = process.env.NEXT_PUBLIC_BUILD_VERSION ?? "unknown";
              const rail = railVersion(build, process.env.NEXT_PUBLIC_RELEASE_VERSION ?? null);
              return (
                <p className="pt-2 text-xs text-ink-300" title={rail.title ?? undefined}>
                  {rail.title === null ? (
                    <>Build Version:{" "}<span className="whitespace-nowrap">{build}</span></>
                  ) : (
                    <span className="whitespace-nowrap">{rail.text}</span>
                  )}
                </p>
              );
            })()}
          </div>
        </RailWrapper>
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="relative z-30 flex h-[72px] items-center gap-5 bg-surface-0 px-8">
          <div className="relative flex-1">
            <input
              role="combobox"
              aria-label="Global search"
              aria-autocomplete="list"
              aria-expanded={open && results !== null}
              aria-controls={open && results !== null ? listboxId : undefined}
              aria-activedescendant={activeOptionId}
              value={query}
              onChange={(e) => changeQuery(e.target.value)}
              onKeyDown={(e) => { void onSearchKeyDown(e); }}
              onFocus={() => { if (results) setOpen(true); }}
              onBlur={() => closeSearchDropdown()}
              placeholder="Search order, PO, part, customer… or scan traveler"
              className="w-full rounded-md bg-surface-50 px-3 py-2.5 text-sm text-ink-800 placeholder:text-ink-500"
            />
            {open && results && (
              <div id={listboxId} role="listbox" aria-label="Search results"
                   className="absolute z-10 mt-1 max-h-[min(24rem,calc(100dvh-4rem))] w-full overflow-y-auto rounded-lg border border-line bg-surface-0 text-sm shadow-lg">
                {noMatches ? (
                  <div className="p-2 text-ink-500">No matches</div>
                ) : (
                  <>
                    {results.orders.length > 0 && (
                      <div role="group" aria-labelledby={`${searchId}-orders`}>
                        <div id={`${searchId}-orders`} className="bg-surface-50 px-2 py-1 text-xs font-medium text-ink-500">Orders</div>
                        {results.orders.map((o, index) => (
                          <button key={o.id} type="button" onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => selectResult(resultHrefs[index])}
                                  {...optionProps(index)}>
                            #{o.orderNumber}{results.exactLoadNumber !== undefined ? ` · Load ${results.exactLoadNumber}` : ""} · {o.customerCode} · PO {o.poNumber || "—"} · {o.leadPartNumber}
                          </button>
                        ))}
                      </div>
                    )}
                    {results.parts.length > 0 && (
                      <div role="group" aria-labelledby={`${searchId}-parts`}>
                        <div id={`${searchId}-parts`} className="bg-surface-50 px-2 py-1 text-xs font-medium text-ink-500">Parts</div>
                        {results.parts.map((p, index) => (
                          <button key={p.id} type="button" onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => selectResult(`/parts/${p.id}`)}
                                  {...optionProps(results.orders.length + index)}>
                            {p.customerCode} · {p.partNumber} — {p.name}
                          </button>
                        ))}
                      </div>
                    )}
                    {results.customers.length > 0 && (
                      <div role="group" aria-labelledby={`${searchId}-customers`}>
                        <div id={`${searchId}-customers`} className="bg-surface-50 px-2 py-1 text-xs font-medium text-ink-500">Customers</div>
                        {results.customers.map((c, index) => (
                          <button key={c.id} type="button" onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => selectResult(`/customers/${c.id}`)}
                                  {...optionProps(results.orders.length + results.parts.length + index)}>
                            {c.code} · {c.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {searchError && (
              <div className="absolute z-10 mt-1 w-full rounded-[5px] bg-red-50 p-2 text-xs text-red-700">
                {searchError}
              </div>
            )}
          </div>
          <DraftsInTab />
          {/* Help opens the user manual, served from erp/public (owner, 2026-10-30). A plain anchor
              that loads a document, so it carries the #275 marker and opens a new tab. */}
          <a href="/manual.html" target="_blank" rel="noopener" data-navigation="document" className="text-sm text-ink-500">Help</a>
          <span className={CHIP} aria-hidden="true">{initials(me.displayName)}</span>
        </header>
        <main className="flex-1">{children}</main>
        {/* The one modal (ruling 5 of 2026-10-30): every in-page confirmation and reason asks through
            src/lib/modal.ts and renders here, once per signed-in tree. */}
        <ModalHost />
        <WhatsNewDialog />
      </div>
    </div>
  );
}
