import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  devServerArgs, dockerServerCopies, resolveDevBundler, resolveServerMode, serverEnv, STANDALONE_COPIES,
} from "../e2e/lib/server-mode.mjs";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

describe("E2E server mode", () => {
  it("defaults to production and accepts only the two named modes", () => {
    expect(resolveServerMode(undefined)).toBe("production");
    expect(resolveServerMode("")).toBe("production");
    expect(resolveServerMode("production")).toBe("production");
    expect(resolveServerMode("dev")).toBe("dev");
    for (const bad of ["prod", "DEV", "development", "start"]) {
      expect(() => resolveServerMode(bad), bad).toThrow(/E2E_SERVER must be "production" or "dev"/);
    }
  });

  // #209: the webpack knob. The nightly set it until the owner's ruling of 2026-10-08; it is a
  // local escape hatch now. A typo must refuse, never quietly leave Turbopack on.
  it("reads E2E_DEV_WEBPACK as exactly \"1\" or unset, in dev mode only", () => {
    expect(resolveDevBundler(undefined, "dev")).toBe("turbopack");
    expect(resolveDevBundler("", "dev")).toBe("turbopack");
    expect(resolveDevBundler("1", "dev")).toBe("webpack");
    for (const bad of ["true", "yes", "on", "0", "01", " 1", "1 ", "webpack", "TRUE"]) {
      expect(() => resolveDevBundler(bad, "dev"), bad).toThrow(/E2E_DEV_WEBPACK must be "1" when set/);
    }
    // Unset is fine in production mode (the required check); set is a refusal, not an ignore.
    expect(resolveDevBundler(undefined, "production")).toBe("turbopack");
    expect(resolveDevBundler("", "production")).toBe("turbopack");
    expect(() => resolveDevBundler("1", "production")).toThrow(/applies only to E2E_SERVER=dev/);
  });

  it("appends --webpack to the dev argv only when the knob chose webpack", () => {
    expect(devServerArgs(3100, "turbopack")).toEqual(["next", "dev", "-p", "3100", "--disable-source-maps"]);
    expect(devServerArgs(3100, "webpack")).toEqual(["next", "dev", "-p", "3100", "--disable-source-maps", "--webpack"]);
    expect(devServerArgs(3100, resolveDevBundler("1", "dev"))).toContain("--webpack");
    expect(devServerArgs(3100, resolveDevBundler(undefined, "dev"))).not.toContain("--webpack");
    expect(() => devServerArgs(3100, "turbo")).toThrow(/Unknown dev bundler/);
  });

  it("drives run.mjs's dev spawn through the knob, not a hard-coded argv", () => {
    const runner = readFileSync(new URL("../e2e/run.mjs", import.meta.url), "utf8");
    expect(runner).toContain("resolveDevBundler(process.env.E2E_DEV_WEBPACK, SERVER_MODE)");
    expect(runner).toContain('["npx", devServerArgs(PORT, DEV_BUNDLER), ERP_ROOT,');
    expect(runner).not.toMatch(/\["next", "dev", "-p", String\(PORT\)/);
  });

  it("copies exactly what the Dockerfile copies for the server (drift guard)", () => {
    expect(dockerServerCopies(dockerfile)).toEqual([...STANDALONE_COPIES]);
    expect(STANDALONE_COPIES).toEqual([
      { from: ".next/standalone", to: "." },
      { from: ".next/static", to: ".next/static" },
      { from: "public", to: "public" },
    ]);
  });

  it("reads only server copies, and notices one going missing", () => {
    const text = [
      "COPY --from=build /app/.next/standalone ./",
      "COPY --from=build /app/.next/static ./.next/static",
      "COPY --from=build /app/public ./public",
      "COPY --from=build /app/prisma ./prisma",
      "COPY --from=build /app/node_modules ./node_modules",
    ].join("\n");
    expect(dockerServerCopies(text)).toEqual([...STANDALONE_COPIES]);
    expect(dockerServerCopies(text.replace("COPY --from=build /app/public ./public\n", ""))).not.toEqual([...STANDALONE_COPIES]);
  });

  it("gives the server .env values, lets the process environment win, and applies overrides last", () => {
    const env = serverEnv('SESSION_SECRET="from-file"\nDATABASE_URL=postgres://file\nPORT=1\n',
      { DATABASE_URL: "postgres://process", PATH: "/usr/bin", UNSET: undefined },
      { PORT: "3100", HOSTNAME: "127.0.0.1" });
    expect(env).toMatchObject({ SESSION_SECRET: "from-file", DATABASE_URL: "postgres://process",
      PATH: "/usr/bin", PORT: "3100", HOSTNAME: "127.0.0.1" });
    expect(Object.hasOwn(env, "UNSET")).toBe(false);
  });
});
