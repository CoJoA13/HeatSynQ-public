// #348: the three pieces that let `e2e/flows/insecure-origin.mjs` browse a real insecure context,
// pinned to the one constant they share. The flow itself proves the host resolves (it cannot sign
// in otherwise). It could not prove the `next dev` allowance, because a refused HMR WebSocket only
// reloads the page after about two minutes of retries, so that entry is held here.
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { HOST_RESOLVER_RULE, INSECURE_HOST, browserEnv, insecureOrigin } from "../e2e/lib/insecure-origin.mjs";
import { harnessRuntime, type AttemptResult } from "./helpers/e2e-harness-runtime";

const success: AttemptResult = {
  ok: true, error: null, kind: null, committed: 0, indeterminate: 0, netFailures: [],
};

describe("insecure-origin wiring (#348)", () => {
  it("names a host Chromium does not treat as a secure context", () => {
    // Loopback names and addresses are secure contexts, so the flow would prove nothing on them.
    expect(INSECURE_HOST).not.toMatch(/(^|\.)localhost$/i);
    expect(INSECURE_HOST).not.toMatch(/^[\d.]+$|:/);
    expect(INSECURE_HOST.endsWith(".test")).toBe(true); // RFC 6761: can never be a real host
    expect(HOST_RESOLVER_RULE).toBe(`MAP ${INSECURE_HOST} 127.0.0.1`);
  });

  it("keeps the scheme and port and swaps only the host", () => {
    expect(insecureOrigin("http://localhost:3100")).toBe(`http://${INSECURE_HOST}:3100`);
    expect(insecureOrigin("http://localhost:3100/orders?x=1")).toBe(`http://${INSECURE_HOST}:3100`);
  });

  it("run.mjs launches the shared browser with the host mapped to this run's loopback server", async () => {
    const runtime = harnessRuntime({ runAttempt: () => success });
    runtime.cleanup.resolve();
    await runtime.main();
    expect(runtime.launchSettings).toHaveLength(1);
    expect(runtime.launchSettings[0].args).toEqual([`--host-resolver-rules=${HOST_RESOLVER_RULE}`]);
  });

  it("adds the host to the proxy bypass the browser reads, keeping what was there", () => {
    const ci = { http_proxy: "http://proxy:3128", no_proxy: "localhost,127.0.0.1,postgres", PATH: "/bin" };
    const env = browserEnv(ci);
    // Chromium without a desktop session reads the lowercase spelling (measured: NO_PROXY alone
    // left the host going to the proxy).
    expect(env.no_proxy).toBe(`localhost,127.0.0.1,postgres,${INSECURE_HOST}`);
    expect(env.NO_PROXY).toBe(env.no_proxy);
    expect(env.http_proxy).toBe(ci.http_proxy);
    expect(env.PATH).toBe("/bin");
    expect(ci.no_proxy).toBe("localhost,127.0.0.1,postgres"); // the harness's own env is untouched
    expect(browserEnv({ NO_PROXY: "localhost" }).no_proxy).toBe(`localhost,${INSECURE_HOST}`);
    expect(browserEnv({}).no_proxy).toBe(INSECURE_HOST);
    expect(browserEnv({ no_proxy: ` localhost , ${INSECURE_HOST} ` }).no_proxy).toBe(`localhost,${INSECURE_HOST}`);
  });

  it("run.mjs launches the shared browser with that bypass", async () => {
    const runtime = harnessRuntime({ runAttempt: () => success });
    runtime.cleanup.resolve();
    await runtime.main();
    expect(runtime.launchSettings).toHaveLength(1);
    expect((runtime.launchSettings[0].env as Record<string, string> | undefined)?.no_proxy?.split(",")).toContain(INSECURE_HOST);
  });

  it("next.config.ts lets next dev serve /_next/* and its HMR socket to that host", () => {
    // Default allowlist in Next 16.2, and the same in 16.4.0 (node_modules/next/dist/server/lib/
    // router-utils/block-cross-site-dev.js): `localhost`, `*.localhost`, and the `--hostname` if one is given.
    // The E2E dev server passes none, so without this entry the flow's page is refused its HMR
    // WebSocket and reloads itself mid-flow once the client gives up reconnecting.
    expect(nextConfig.allowedDevOrigins).toContain(INSECURE_HOST);
  });
});
