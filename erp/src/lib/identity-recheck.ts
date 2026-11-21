// When the Shell re-checks who is signed in (ruling R2, owner 2026-10-22; #607).
//
// The check ran on every client-side route change: `validateIdentity` begins by setting the draft
// store not ready, the Shell then draws its holding screen in place of the page, the page unmounts
// with its first reads out, and remounts to read again when the check lands. The draft-recovery
// design asks for a check at mount, on a bfcache `pageshow` and after a 401, never per route. So the
// effect is keyed on `identityCheckKey(pathname)`, which is one value for every app route and
// another for /login (login leaves /login by client navigation, so the key has to change there), and
// the checks that last the Shell's lifetime are bound here: a persisted `pageshow`, the tab becoming
// visible again, and a 401. The tab's return is `visibilitychange`, never window `focus`: a native
// `confirm()` blurs and refocuses the window, and a re-check there would unmount the page between a
// confirmation and the request it guards (ShipmentDetail's reverse), cancelling it silently.
//
// Client-safe leaf: no React, no `src/server` import. tests/shell-identity-recheck.test.ts runs it
// over fake targets and pins the Shell's effect to it from source.

/** The effect key: a route change inside the app re-runs nothing; leaving /login does. */
export function identityCheckKey(pathname: string): "login" | "app" {
  return pathname === "/login" ? "login" : "app";
}

type Listener<E> = (event: E) => void;
export type RecheckTargets = {
  window: { addEventListener(type: "pageshow", listener: Listener<{ persisted: boolean }>): void;
            removeEventListener(type: "pageshow", listener: Listener<{ persisted: boolean }>): void };
  document: { visibilityState: DocumentVisibilityState;
              addEventListener(type: "visibilitychange", listener: () => void): void;
              removeEventListener(type: "visibilitychange", listener: () => void): void };
  subscribeUnauthorized(listener: () => void): () => void;
};

/** Binds the checks that last the Shell's lifetime; the answer unbinds them all. */
export function bindIdentityRechecks(targets: RecheckTargets, validate: () => void): () => void {
  const onPageShow: Listener<{ persisted: boolean }> = (event) => { if (event.persisted) validate(); };
  const onVisibility = () => { if (targets.document.visibilityState === "visible") validate(); };
  targets.window.addEventListener("pageshow", onPageShow);
  targets.document.addEventListener("visibilitychange", onVisibility);
  // A page request's 401 has already reset identity and raised the holding screen. Only the
  // Shell's check routes an expired session to /login, so the 401 has to re-run it (#332).
  const offUnauthorized = targets.subscribeUnauthorized(validate);
  return () => {
    targets.window.removeEventListener("pageshow", onPageShow);
    targets.document.removeEventListener("visibilitychange", onVisibility);
    offUnauthorized();
  };
}
