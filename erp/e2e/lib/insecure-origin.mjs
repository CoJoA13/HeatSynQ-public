// #348: the one non-loopback HTTP origin the suite browses, so a flow can run in a real insecure
// browser context against the real server.
//
// Chromium treats `localhost`, `*.localhost` and loopback addresses as secure contexts, which is
// why every other flow browses an origin where `crypto.randomUUID` exists and the owner's report
// (Add step doing nothing on the install's plain-HTTP LAN address) could not reproduce. A `.test`
// name is not on that list. It is also a reserved TLD (RFC 6761), so it can never collide with a
// real host.
// `run.mjs` passes HOST_RESOLVER_RULE to the shared `chromium.launch`, so the browser alone
// resolves it to the loopback server both modes already bind: the standalone server on
// 127.0.0.1 and `next dev` on every interface. No system resolver or /etc/hosts entry is involved,
// and every other flow's `localhost` is untouched.
//
// `next dev` refuses an Origin-bearing `/_next/*` request from any host other than
// `localhost`/`*.localhost` unless `allowedDevOrigins` lists it (node_modules/next
// `block-cross-site-dev.js`), which includes its HMR WebSocket. So `next.config.ts` lists this host.
// `tests/e2e-insecure-origin.test.ts` holds that entry to this constant, and also holds run.mjs's
// launch argument to HOST_RESOLVER_RULE.
export const INSECURE_HOST = "heatsynq.test";
export const HOST_RESOLVER_RULE = `MAP ${INSECURE_HOST} 127.0.0.1`;

/** `baseURL` with its host swapped for INSECURE_HOST: the same scheme, port and server. */
export function insecureOrigin(baseURL) {
  const url = new URL(baseURL);
  url.hostname = INSECURE_HOST;
  return url.origin;
}

/**
 * The shared browser's environment: `env` with INSECURE_HOST added to the proxy bypass list.
 * Without a desktop session, as in the CI runner's container, Chromium on Linux takes its proxy
 * from `http_proxy` and honours only the lowercase `no_proxy`. The runner routes egress through a
 * proxy that `no_proxy` bypasses for `localhost` and `127.0.0.1` only, so the mapped host went to
 * that proxy, which refused it, instead of to the host-resolver rule above: the first CI run of the
 * flow failed on the proxy's "Access Denied" page (measured 2026-09-25). A desktop session
 * reads the desktop's proxy settings instead, which is why the flow passed locally. Both spellings
 * are set to the same list, so the bypass holds whichever one Chromium reads.
 */
export function browserEnv(env) {
  const entries = (env.no_proxy ?? env.NO_PROXY ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!entries.includes(INSECURE_HOST)) entries.push(INSECURE_HOST);
  const list = entries.join(",");
  return { ...env, no_proxy: list, NO_PROXY: list };
}
