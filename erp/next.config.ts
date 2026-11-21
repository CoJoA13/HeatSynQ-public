import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";
import { buildVersionLabel, parseBuildStamp } from "./src/lib/build-version";
import { readReleaseVersion } from "./src/lib/release-version";

// The build version at the foot of the nav rail (#542). A build from `git archive` (a release build)
// finds build-stamp.txt filled in by export-subst (.gitattributes); a
// build in a checkout (a laptop, the E2E harness, CI's `npm run build`) asks git; a build with
// neither (a working tree without git) says "unknown"; CI's Docker image builds from an archive of
// HEAD since #543, so it carries the stamp too. Read once, at build time.
function buildStamp(): string | null {
  try {
    const stamp = readFileSync(join(process.cwd(), "build-stamp.txt"), "utf8");
    if (parseBuildStamp(stamp)) return stamp;
  } catch {
    // no stamp file: fall through to git
  }
  try {
    return execFileSync("git", ["log", "-1", "--format=%H %cI"], {
      cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

// The release version (release updates): erp/release-version.txt holds one line, written into the
// release build's source tree, and is absent from every other build (gitignored). A present file
// that is not a release version fails the build rather than label the install wrongly, and so does
// a read error other than a missing file (readReleaseVersion judges the text).
function releaseVersion(): string {
  let text: string;
  try {
    text = readFileSync(join(process.cwd(), "release-version.txt"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
  return readReleaseVersion(text);
}

const nextConfig: NextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_BUILD_VERSION: buildVersionLabel(buildStamp()),
    NEXT_PUBLIC_RELEASE_VERSION: releaseVersion(),
  },
  // DEV ONLY (#348): `next dev` refuses any `/_next/*` or `/__nextjs*` request that carries an
  // Origin from a host outside `localhost`, `*.localhost` and its own `--hostname`
  // (node_modules/next/dist/server/lib/router-utils/block-cross-site-dev.js; unchanged from 16.2.12 to 16.3.6.
  // 16.4.0 keeps that allow-list and changes one thing: `isInternalEndpoint` tests the request's parsed
  // pathname where it tested the raw URL, so a `/_next` in a query string no longer counts). Its HMR
  // WebSocket always carries one. The insecure-origin E2E flow browses `heatsynq.test`
  // (e2e/lib/insecure-origin.mjs), and without this entry a `next dev` run (the nightly) would refuse
  // that page its HMR socket, and the client reloads the page on its thirteenth failed connection in a
  // row (`reconnections > WEB_SOCKET_MAX_RECONNECTIONS`, which is 12 in node_modules/next/dist/lib/constants.js
  // on 16.3.6 and 16.4.0 alike). The production server never consults this setting.
  // `tests/e2e-insecure-origin.test.ts` holds it to the flow's constant.
  allowedDevOrigins: ["heatsynq.test"],
  // Next 16.3's dev server wrote AGENTS.md and CLAUDE.md into erp/ when it detected an AI coding agent;
  // 16.4.0's writes AGENTS.md only (node_modules/next/dist/server/lib/generate-agent-files.js). With
  // `false` it writes neither, and 16.4.0 also removes its own block from an AGENTS.md that has one.
  // The repo's reviewed agent instructions live at the root; never let the framework add its own (#209).
  agentRules: false,
  experimental: {
    // 16.4 added this, on by default as "security": when a coding agent runs `next dev` or
    // `next build` and a published advisory matches the installed Next, the command exits 1 with
    // upgrade instructions (node_modules/next/dist/lib/upgrade/nudge.js). To find out, `next dev`
    // outside CI posts the installed version to npm's advisory endpoint on every start. Off by the
    // owner's ruling of 2026-10-07: the required `security-audit` check is this repo's gate, and it
    // blocks the merge on a high or critical advisory. With this off, nothing stops on a moderate or
    // low one.
    agentUpgrade: false,
  },
  typescript: {
    // 16.3 type-checks `next build` through the tsc CLI over the whole project, which no longer drops
    // test-file diagnostics. The Docker build context is erp/ alone, so the tests that import ../ops
    // failed it with TS2307 (measured 2026-09-25). 16.4.0 does
    // the same: with this line removed, the erp-only build fails with TS2307 again (measured
    // 2026-10-07). The build config checks src/ and Next's route types
    // only. Dev and typegen read it too; it extends tsconfig.json, so the `@/` alias resolves the same
    // everywhere. The full-project `npx tsc --noEmit` gate still reads tsconfig.json (#209).
    tsconfigPath: "tsconfig.build.json",
  },
  // pdfmake and bwip-js are CommonJS renderers with their own internal `require` graphs (pdfkit,
  // fontkit, iconv-lite) and a megabyte of embedded base64 font data. Left to the bundler they
  // get inlined into every route chunk that touches the traveler; declared external they are
  // `require`d at runtime instead, and `output: "standalone"`'s file tracing copies them into
  // the image the same way it copies Prisma's engine.
  serverExternalPackages: ["pdfmake", "bwip-js"],
  // The vendored font directory (Phase 7 spec §6.2) is read with `readFileSync` from an app-root
  // path, so every route is told to carry all of it, licence and provenance files included (#334:
  // the tracer brought those along on some routes only, which is nothing to rest on): they land at
  // `.next/standalone/src/server/pdf/fonts/**`, which the Docker run stage copies to
  // `/app/src/server/pdf/fonts/**` — exactly where render.ts's `process.cwd()`-resolved read
  // looks. The build compiling is NOT proof the trace worked; `ls` the standalone output after
  // touching this (Task 6 report has the listing).
  outputFileTracingIncludes: {
    "/**": ["./src/server/pdf/fonts/**/*", "./prisma/public-migrations.json", "./prisma/public-baseline-templates.json", "./prisma/migrations/**"],
  },
};

export default nextConfig;
