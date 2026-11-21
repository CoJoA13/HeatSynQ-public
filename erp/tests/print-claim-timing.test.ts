/**
 * #556: how long a whole-shipment ticket print and an all-loads traveler print hold their claims, and
 * when the claims are released. An opt-in timing test: it runs only with MEASURE_556=1, which CI never
 * sets. Without it the file registers one skipped placeholder and nothing else, so it imports its
 * modules, registers no hook and touches no database.
 *
 * Against erp_test only (the beforeAll refuses any other database, and so does the probe), it times
 * the whole-set ticket print (`printShippingTickets` with no order, as the print route calls it for
 * "Print all tickets") and the all-loads traveler print (`printTraveler` -> `printSelectedTraveler`)
 * on REAL renders, and records from OUTSIDE the print's event loop, on a worker thread with its own
 * `pg` connection, when the claims are released. Each print's budget is read from source when the
 * run starts (`SHIPPING_TICKET_PRINT_TIMEOUT_MS` in shippers.ts, `TRAVELER_PRINT_TIMEOUT_MS` in
 * traveler.ts), never copied here; the beforeAll refuses the run when either is not found.
 *
 * Nothing under src/ is edited or mocked; the render is real. Test-side instruments only:
 *  - a worker_threads probe (its own event loop, its own raw `pg` Client, not the Prisma pool) that
 *    every MEASURE_556_POLL_MS runs `SELECT id FROM "Order" WHERE id = $1 FOR UPDATE SKIP LOCKED`
 *    (and the same on the "Shipper" row for tickets) in autocommit, plus a pg_stat_activity read;
 *  - a main-thread event-loop lag meter (setInterval, MEASURE_556_TICK_MS);
 *  - a wrapper on globalThis.setTimeout that dates Prisma's transaction-timeout timer (armed when the
 *    transaction starts, its delay exactly the print's budget) and its firing; each print is expected
 *    to arm exactly one such timer (`timers_seen`, a soft check);
 *  - a pass-through spy on renderSheetGroups that dates the render's start and end;
 *  - a pass-through wrapper on pdf-lib's PDFDocument.prototype.save that dates the merged save (the
 *    ticket's first macrotask turn is expected there: pdf-lib's save yields every 50 objects).
 *
 * Reading the figures. Postgres here has no server-side timeout (idle_in_transaction_session_timeout,
 * transaction_timeout and statement_timeout are 0; the config line prints them), so a claim ends
 * only when Node sends ROLLBACK or COMMIT, and Prisma's ROLLBACK goes out only when its timer runs,
 * at the print thread's first event-loop turn after the budget. What yields: pdf-lib's load (every
 * 100 parsed objects per group) and save (every 50 objects), and pdfkit's embed of a PNG with an
 * alpha channel (png-js decodePixels -> async zlib.inflate). The traveler's barcode is an RGBA PNG,
 * so the traveler turns once per load; the Standard ticket places no image, and a one- or two-page
 * ticket group stays under pdf-lib's 100 objects, so it does not turn until the merged save (in the
 * 2026-10-18 run its loop_max_gap ended at save_start). A ticket template with a placed RGBA PNG logo
 * turns once per sheet (a JPEG logo would not): the `-logo` variants measure that case, off by
 * default.
 *
 * Outcomes. Each line's outcome is stored, returned or error. An error line also carries err, code,
 * status, refused and expired: refused=yes is an HttpError 400 carrying the refusal's words, "took
 * too long to print", which #556's two ticket sentences and #521's traveler sentence all hold (the
 * tests that pin each sentence whole are shipping-ticket.test.ts and traveler-templates.test.ts);
 * expired=yes is a raw Prisma P2028, which both prints now map to their refusal, so a yes on a ticket
 * or traveler line is a regression (the controls' bare transaction expires raw, by design).
 *
 * Which sizes reach the budget. No default ticket size should: on 2026-10-18, before the ticket had
 * its 15 s budget, the largest default, 160 two-page tickets, failed at Prisma's 5 s default and
 * settled in 8.7-9.1 s. By extrapolation from about 29 ms a printed page without a logo and about
 * 57 ms with one (not measured at those sizes), a whole-set print reaches 15 s at about 260
 * two-page orders without a logo (set MEASURE_556_NS), and at about 130 with the `-logo` variants,
 * which the default n=160 of multi-page-logo already passes (it settled in 17.48 s on 2026-10-18).
 * The default two-page traveler of 100 loads is #521's refusal (21.25-21.34 s on 2026-10-18).
 *
 * Env:
 *   MEASURE_556=1                     run at all
 *   MEASURE_556_NS=10,40,80,120,160   ticket order counts
 *   MEASURE_556_VARIANTS=one-page,multi-page
 *                                     also one-page-logo / multi-page-logo: the shipment's customer is
 *                                     assigned a ticket template with a placed RGBA PNG logo
 *                                     (synthetic, about the real logo's 1716x560 pixels)
 *   MEASURE_556_CERTS=1               withCerts as "Print all tickets" sends it (its checkbox is
 *                                     pre-ticked, ShipmentDetail.tsx); 0 prints without
 *   MEASURE_556_SERIALS=<k>           printable serials per order in the multi-page variant
 *   MEASURE_556_TICKETS=0             skip the ticket measurements
 *   MEASURE_556_CONTROL=0             skip the two no-render controls (500 ms timeout, yielding vs blocking)
 *   MEASURE_556_TRAVELER=0            skip the traveler measurements
 *   MEASURE_556_TRAVELER_LOADS=100    loads in the traveler order (the all-loads bound is 100)
 *   MEASURE_556_TRAVELER_VARIANTS=one-page,two-page
 *   MEASURE_556_REPS=1                repetitions of each measurement
 *   MEASURE_556_POLL_MS=100           probe interval
 *   MEASURE_556_TICK_MS=20            lag meter interval
 *   MEASURE_556_JSON=<path>           append one JSON line per measurement with the full traces
 *
 * Full run, from erp/: first pause both runner slots with their `paused` files, so no CI job shares
 * the machine, stay on mains and set the full-clock profile the 2026-10-18 run used, Performance
 * (ops/github/runner/README.md, "A host's power profile"; on the laptop `system76-power profile
 * performance`). Record the config line, which prints both budgets, platform_profile, the governor,
 * the AC state, the load average and the Postgres timeouts; each measured line prints its own
 * profile and load average. With NODE_OPTIONS=--expose-gc each measurement collects garbage first
 * (gc_before=yes), so a major collection of the fixture's garbage does not land inside the print.
 * The default sizes and variants are the 2026-10-18 full run's; its repetitions and forced
 * collection are not the defaults (its config line reads reps=3 and gc_exposed=true). As that run:
 *   NODE_OPTIONS=--expose-gc MEASURE_556=1 MEASURE_556_REPS=3 \
 *     npx vitest run tests/print-claim-timing.test.ts --silent=false
 * and as its logo run, one of each, with no traveler and no controls (its log holds none):
 *   NODE_OPTIONS=--expose-gc MEASURE_556=1 MEASURE_556_NS=80,160 \
 *     MEASURE_556_VARIANTS=one-page-logo,multi-page-logo MEASURE_556_TRAVELER=0 \
 *     MEASURE_556_CONTROL=0 npx vitest run tests/print-claim-timing.test.ts --silent=false
 * Both runs also set MEASURE_556_JSON, which changes no figure. They measured the ticket on
 * Prisma's 5 s default, so a run on this code repeats their prints, not their outcomes.
 */
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { loadavg } from "node:os";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { toBuffer } from "bwip-js/node";
import { PDFDocument } from "pdf-lib";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { pageCount, paintedImageCounts } from "./helpers/pdf";
import { runWithContext } from "@/server/context";
import { HttpError } from "@/server/errors";
import { isExpiredTransaction } from "@/server/db-errors";
import { createOrder, type OrderDetail } from "@/server/orders";
import {
  createShipper, addOrderToShipper, replaceShipperLines, printShippingTickets,
} from "@/server/shippers";
import { printTraveler } from "@/server/traveler";
import { practiceMode } from "@/server/practice-mode";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { SHIPPER_DEFAULT_CONFIG, MOS_SHIPPER_DEFAULT_CONFIG } from "@/lib/template-contracts/index";
import * as pdfRenderer from "@/server/pdf/render";

const ON = process.env.MEASURE_556 === "1";
const list = (v: string | undefined, d: string) => (v ?? d).split(",").map((s) => s.trim()).filter(Boolean);
const NS = list(process.env.MEASURE_556_NS, "10,40,80,120,160").map(Number);
const VARIANTS = list(process.env.MEASURE_556_VARIANTS, "one-page,multi-page");
const SERIALS = Number(process.env.MEASURE_556_SERIALS ?? 80);
const CERTS = process.env.MEASURE_556_CERTS !== "0";
const TICKETS = process.env.MEASURE_556_TICKETS !== "0";
const CONTROL = process.env.MEASURE_556_CONTROL !== "0";
const CONTROL_TIMEOUT_MS = 500;
const TRAVELER = process.env.MEASURE_556_TRAVELER !== "0";
const TRAVELER_LOADS = Number(process.env.MEASURE_556_TRAVELER_LOADS ?? 100);
const TRAVELER_VARIANTS = list(process.env.MEASURE_556_TRAVELER_VARIANTS, "one-page,two-page");
const REPS = Number(process.env.MEASURE_556_REPS ?? 1);
const POLL_MS = Number(process.env.MEASURE_556_POLL_MS ?? 100);
const TICK_MS = Number(process.env.MEASURE_556_TICK_MS ?? 20);
const JSON_OUT = process.env.MEASURE_556_JSON;

// Each print's transaction budget, read from source by the beforeAll (`readBudget`), so a skipped run
// reads nothing and a renamed constant refuses only a run that was asked for. The cases read them
// when they run.
let TICKET_TIMEOUT_MS = 0; // SHIPPING_TICKET_PRINT_TIMEOUT_MS in shippers.ts
let TRAVELER_TIMEOUT_MS = 0; // TRAVELER_PRINT_TIMEOUT_MS in traveler.ts
const LONG = 1_800_000;

/** The digits of `const <name> = <digits>;` in a source file under src/server, or a refusal. */
function readBudget(file: string, name: string): number {
  const source = readFileSync(new URL(`../src/server/${file}`, import.meta.url), "utf8");
  const match = new RegExp(`const ${name} = ([\\d_]+);`).exec(source);
  const ms = match ? Number(match[1].replace(/_/g, "")) : Number.NaN;
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(`#556 timing refuses to run: no \`const ${name} = <digits>;\` in src/server/${file}`);
  }
  return ms;
}

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "measure-556" }, user: null }, fn);

// ------------------------------------------------------------------------------------------------
// The probe: a worker thread with its own event loop and its own pg connection.
// ------------------------------------------------------------------------------------------------

const PROBE_CODE = `
const { parentPort, workerData } = require("node:worker_threads");
const { Client } = require(workerData.pgPath);
const { url, orderId, shipperId, pollMs } = workerData;
if (!/\\/erp_test(\\?|$)/.test(url)) throw new Error("the probe refuses any database but erp_test: " + url);
const client = new Client({ connectionString: url });
const samples = [];
let stopping = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll() {
  while (!stopping) {
    const t = Date.now();
    const o = await client.query('SELECT id FROM "Order" WHERE id = $1 FOR UPDATE SKIP LOCKED', [orderId]);
    const tOrder = Date.now();
    const s = shipperId
      ? await client.query('SELECT id FROM "Shipper" WHERE id = $1 FOR UPDATE SKIP LOCKED', [shipperId])
      : null;
    const tShipper = Date.now();
    const a = await client.query(
      "SELECT pid, state, (extract(epoch FROM xact_start) * 1000)::float8 AS xact_ms, " +
      "(extract(epoch FROM state_change) * 1000)::float8 AS change_ms, wait_event_type, wait_event, " +
      "left(query, 60) AS query FROM pg_stat_activity " +
      "WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'");
    samples.push({
      t, tOrder, tShipper, tEnd: Date.now(), orderFree: o.rowCount === 1,
      shipperFree: s === null ? null : s.rowCount === 1, act: a.rows,
    });
    const wait = pollMs - (Date.now() - t);
    if (wait > 0) await sleep(wait);
  }
}
let loop = Promise.resolve();
parentPort.on("message", async (m) => {
  // A failed poll ends the loop but not the worker: the samples so far still come back on stop,
  // and the error rides beside them (an unhandled rejection here would kill the worker, and the
  // main thread would wait for samples that never come).
  if (m.type === "go") loop = poll().catch((e) =>
    parentPort.postMessage({ type: "error", message: String(e && e.stack || e) }));
  if (m.type === "stop") {
    stopping = true;
    await loop;
    try { await client.end(); } catch {}
    parentPort.postMessage({ type: "samples", samples });
  }
});
client.connect().then(
  () => parentPort.postMessage({ type: "ready" }),
  (e) => parentPort.postMessage({ type: "error", message: String(e && e.stack || e) }));
`;

type Activity = {
  pid: number; state: string | null; xact_ms: number | null; change_ms: number | null;
  wait_event_type: string | null; wait_event: string | null; query: string | null;
};
type Sample = {
  t: number; tOrder: number; tShipper: number; tEnd: number;
  orderFree: boolean; shipperFree: boolean | null; act: Activity[];
};

const requireHere = createRequire(import.meta.url);

async function startProbe(orderId: string, shipperId: string | null) {
  const url = process.env.DATABASE_URL ?? "";
  const worker = new Worker(PROBE_CODE, {
    eval: true,
    workerData: { pgPath: requireHere.resolve("pg"), url, orderId, shipperId, pollMs: POLL_MS },
  });
  let probeError: string | undefined;
  let stopped = false;
  let resolveSamples: (s: Sample[]) => void = () => {};
  const samples = new Promise<Sample[]>((r) => { resolveSamples = r; });
  await new Promise<void>((resolve, reject) => {
    worker.on("message", (m: { type: string; message?: string; samples?: Sample[] }) => {
      if (m.type === "ready") resolve();
      if (m.type === "error") { probeError ??= m.message; reject(new Error(`probe: ${m.message}`)); }
      if (m.type === "samples") resolveSamples(m.samples ?? []);
    });
    // A worker that dies (before or after ready) settles both waits, so a probe failure costs this
    // measurement its samples, never the run 30 minutes of test timeout.
    worker.on("error", (e) => { probeError ??= String(e); reject(e); resolveSamples([]); });
    worker.on("exit", (code) => {
      if (!stopped) probeError ??= `probe worker exited ${code} before stop`;
      reject(new Error(probeError ?? "probe worker exited before ready"));
      resolveSamples([]);
    });
  });
  return {
    go: () => worker.postMessage({ type: "go" }),
    stop: async (): Promise<{ samples: Sample[]; error?: string }> => {
      worker.postMessage({ type: "stop" });
      const s = await samples;
      const error = probeError;
      stopped = true;
      await worker.terminate();
      return { samples: s, error };
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Main-thread instruments: the event-loop lag meter, Prisma's timer, the render's start and end.
// ------------------------------------------------------------------------------------------------

function startLoopMeter() {
  const ticks: number[] = [Date.now()];
  const iv = setInterval(() => ticks.push(Date.now()), TICK_MS);
  return { stop: () => { clearInterval(iv); ticks.push(Date.now()); return ticks; } };
}

type TimerRecord = { armed: number; fired?: number; cleared?: number };

function watchTimers(delayMs: number) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const records: TimerRecord[] = [];
  const byHandle = new Map<unknown, TimerRecord>();
  const wrapped = function (this: unknown, fn: unknown, ms?: number, ...rest: unknown[]) {
    if (ms === delayMs && typeof fn === "function") {
      const rec: TimerRecord = { armed: Date.now() };
      records.push(rec);
      const handle = realSetTimeout(function (this: unknown, ...a: unknown[]) {
        rec.fired = Date.now();
        return (fn as (...x: unknown[]) => unknown).apply(this, a);
      }, ms, ...rest);
      byHandle.set(handle, rec);
      return handle;
    }
    return (realSetTimeout as unknown as (...x: unknown[]) => unknown)(fn, ms, ...rest);
  };
  (wrapped as unknown as Record<symbol, unknown>)[promisify.custom] =
    (realSetTimeout as unknown as Record<symbol, unknown>)[promisify.custom];
  const wrappedClear = function (handle: unknown) {
    const rec = byHandle.get(handle);
    if (rec && rec.fired === undefined && rec.cleared === undefined) rec.cleared = Date.now();
    return (realClearTimeout as unknown as (h: unknown) => void)(handle);
  };
  globalThis.setTimeout = wrapped as unknown as typeof setTimeout;
  globalThis.clearTimeout = wrappedClear as unknown as typeof clearTimeout;
  return {
    records,
    restore: () => { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; },
  };
}

function spyRender() {
  const real = pdfRenderer.renderSheetGroups;
  const times: { start?: number; end?: number } = {};
  const spy = vi.spyOn(pdfRenderer, "renderSheetGroups").mockImplementation(async (defs) => {
    times.start = Date.now();
    try { return await real(defs); } finally { times.end = Date.now(); }
  });
  return { times, restore: () => spy.mockRestore() };
}

/** Dates every pdf-lib save during the print; renderSheetGroups' merged save is the one expected
 *  (stampPractice saves again only in practice mode). A plain prototype wrapper, restored after. */
function spySave() {
  const proto = PDFDocument.prototype;
  const real = proto.save;
  const calls: { start: number; end?: number }[] = [];
  proto.save = async function (this: PDFDocument, ...args: Parameters<PDFDocument["save"]>) {
    const rec: { start: number; end?: number } = { start: Date.now() };
    calls.push(rec);
    try { return await real.apply(this, args); } finally { rec.end = Date.now(); }
  };
  return { calls, restore: () => { proto.save = real; } };
}

const readOr = (path: string) => { try { return readFileSync(path, "utf8").trim(); } catch { return "na"; } };

/** The host state the ruling names (mains, full clock), read so each figure carries it. */
function hostState() {
  let ac = "na";
  try {
    for (const d of readdirSync("/sys/class/power_supply")) {
      if (readOr(`/sys/class/power_supply/${d}/type`) === "Mains") ac = readOr(`/sys/class/power_supply/${d}/online`);
    }
  } catch { /* no power_supply class */ }
  return {
    profile: readOr("/sys/firmware/acpi/platform_profile"),
    governor: readOr("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"),
    ac_online: ac,
  };
}

// ------------------------------------------------------------------------------------------------
// One measured print, and the line it prints.
// ------------------------------------------------------------------------------------------------

type Outcome =
  | { ok: true; documentId: string | null; returnedPages: number | null }
  | { ok: false; err: unknown };

async function measure(opts: {
  kind: "ticket" | "traveler" | "control"; variant: string; n: number; rep: number; fixtureMs: number;
  fixtureDetail?: string;
  orderId: string; shipperId: string | null; timeoutMs: number; expectedPages: number | null;
  print: () => Promise<{ documentId: string; pdf: Buffer } | null>;
  extra?: Record<string, string | number>;
}) {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") gc();
  const probe = await startProbe(opts.orderId, opts.shipperId);
  const meter = startLoopMeter();
  let instrumentsStopped = false;
  const stopInstruments = async () => {
    instrumentsStopped = true;
    const ticks = meter.stop();
    return { ticks, ...(await probe.stop()) };
  };
  const timers = watchTimers(opts.timeoutMs);
  const render = spyRender();
  const saves = spySave();
  let outcome: Outcome;
  let t0 = 0;
  let tSettle = 0;
  const load1 = loadavg()[0];
  const host = hostState();
  try {
    try {
      probe.go();
      t0 = Date.now();
      outcome = await asSystem(opts.print).then(
        (r): Outcome => (r === null ? { ok: true, documentId: null, returnedPages: null }
          : { ok: true, documentId: r.documentId, returnedPages: pageCount(r.pdf) }),
        (err: unknown): Outcome => ({ ok: false, err }));
      tSettle = Date.now();
    } finally {
      saves.restore();
      render.restore();
      timers.restore();
    }
    // Let the probe see a release that lands at or just after settle.
    await new Promise((r) => setTimeout(r, Math.max(400, POLL_MS * 4)));
  } catch (e) {
    // Never leave a polling worker (and its connection) behind a failed measurement.
    if (!instrumentsStopped) await stopInstruments().catch(() => {});
    throw e;
  }
  const { ticks, samples, error: probeError } = await stopInstruments();

  const rel = (t: number | undefined | null) => (t === undefined || t === null ? "na" : String(Math.round(t - t0)));
  const fields: Record<string, string | number> = {
    kind: opts.kind, variant: opts.variant, n: opts.n, rep: opts.rep, fixture_ms: opts.fixtureMs,
    ...(opts.fixtureDetail ? { fixture_detail: opts.fixtureDetail } : {}),
    ...(opts.extra ?? {}),
    profile: host.profile, ac: host.ac_online, load1: load1.toFixed(2),
    gc_before: typeof gc === "function" ? "yes" : "no",
    settle_ms: tSettle - t0,
  };

  // Outcome and the stored page count.
  let pages: number | "na" = "na";
  if (outcome.ok && outcome.documentId === null) {
    fields.outcome = "returned";
    fields.pages = "na";
  } else if (outcome.ok) {
    const documentId = outcome.documentId ?? "";
    const stored = await prisma.storedDocument.findUniqueOrThrow({ where: { id: documentId } });
    const storedPdf = Buffer.from(stored.fileData);
    pages = pageCount(storedPdf);
    fields.outcome = "stored";
    fields.doc = documentId;
    fields.pages = pages;
    fields.returned_pages = outcome.returnedPages ?? "na";
    if (opts.variant.endsWith("-logo")) {
      // The logo variant must actually paint its image: one per page, read off the stored bytes.
      const images = paintedImageCounts(storedPdf);
      fields.images_per_page = `${Math.min(...images)}..${Math.max(...images)}`;
    }
  } else {
    fields.outcome = "error";
    fields.pages = "na";
  }
  fields.expected_pages = opts.expectedPages ?? "na";
  fields.pages_per_group = pages === "na" ? "na" : (pages / opts.n).toFixed(2);
  fields.stored_docs = await prisma.storedDocument.count();

  // Render window and Prisma's transaction-timeout timer.
  fields.render_start_ms = rel(render.times.start);
  fields.render_end_ms = rel(render.times.end);
  fields.render_ms = render.times.start !== undefined && render.times.end !== undefined
    ? render.times.end - render.times.start : "na";
  fields.saves = saves.calls.length;
  fields.save_start_ms = rel(saves.calls.at(-1)?.start);
  fields.save_end_ms = rel(saves.calls.at(-1)?.end);
  const timer = timers.records[0];
  fields.timers_seen = timers.records.length;
  // Prisma arms its transaction timer through the global setTimeout with exactly the budget; a print
  // that arms none, or several, is flagged here without losing the rest of the run.
  expect.soft(timers.records.length, `${opts.kind} ${opts.variant} n=${opts.n}: timers armed with ${opts.timeoutMs} ms`).toBe(1);
  fields.timer_armed_ms = rel(timer?.armed);
  fields.timer_due_ms = timer ? rel(timer.armed + opts.timeoutMs) : "na";
  fields.timer_fired_ms = timer?.fired !== undefined ? rel(timer.fired) : (timer?.cleared !== undefined ? "cleared" : "na");
  fields.timer_late_ms = timer?.fired !== undefined ? timer.fired - (timer.armed + opts.timeoutMs) : "na";

  // Event-loop lag on the print's thread, between t0 and settle.
  let maxGap = 0; let gapStart = 0; let gapEnd = 0;
  const longGaps: string[] = [];
  for (let i = 1; i < ticks.length; i++) {
    if (ticks[i] < t0 || ticks[i - 1] > tSettle) continue;
    const gap = ticks[i] - ticks[i - 1];
    if (gap > maxGap) { maxGap = gap; gapStart = ticks[i - 1]; gapEnd = ticks[i]; }
    if (gap >= 250) longGaps.push(`${rel(ticks[i - 1])}-${rel(ticks[i])}`);
  }
  fields.loop_max_gap_ms = maxGap;
  fields.loop_max_gap_at = `${rel(gapStart)}-${rel(gapEnd)}`;
  fields.loop_gaps_ge250 = longGaps.length === 0 ? "none" : longGaps.join(",");
  const due = timer ? timer.armed + opts.timeoutMs : undefined;
  fields.first_tick_after_due_ms = due === undefined ? "na" : rel(ticks.find((t) => t >= due));

  // The probe: when the order row (and the Shipper row) were seen locked and free.
  const firstLocked = samples.find((s) => !s.orderFree);
  const lastLocked = [...samples].reverse().find((s) => !s.orderFree);
  const freeAfter = firstLocked ? samples.find((s) => s.t > firstLocked.t && s.orderFree) : undefined;
  fields.polls = samples.length;
  fields.first_locked_ms = rel(firstLocked?.tOrder);
  fields.last_locked_ms = rel(lastLocked?.tOrder);
  fields.claim_free_ms = firstLocked ? rel(freeAfter?.tOrder) : "never_seen_locked";
  const firstShipLocked = samples.find((s) => s.shipperFree === false);
  const shipFreeAfter = firstShipLocked ? samples.find((s) => s.t > firstShipLocked.t && s.shipperFree === true) : undefined;
  fields.shipper_free_ms = opts.shipperId === null ? "na"
    : (firstShipLocked ? rel(shipFreeAfter?.tShipper) : "never_seen_locked");
  let probeMaxGap = 0;
  for (let i = 1; i < samples.length; i++) probeMaxGap = Math.max(probeMaxGap, samples[i].t - samples[i - 1].t);
  fields.probe_max_gap_ms = probeMaxGap;

  // pg_stat_activity: the print's backend, its transaction's start, its states, its end.
  let printPid: number | undefined; let printXact: number | undefined;
  if (firstLocked) {
    const open = firstLocked.act.filter((a) => a.xact_ms !== null && a.xact_ms >= t0 - 50)
      .sort((a, b) => (a.xact_ms ?? 0) - (b.xact_ms ?? 0));
    if (open[0]) { printPid = open[0].pid; printXact = open[0].xact_ms ?? undefined; }
  }
  let idleInTx = 0; let active = 0; let otherState = 0;
  let xactEnd: number | undefined; let xactGoneSeen: number | undefined; let endState = "na";
  if (printPid !== undefined) {
    for (const s of samples) {
      if (s.t < (firstLocked?.t ?? 0)) continue;
      const row = s.act.find((a) => a.pid === printPid);
      if (row && row.xact_ms !== null && Math.abs(row.xact_ms - (printXact ?? 0)) < 1) {
        if (row.state === "idle in transaction") idleInTx++;
        else if (row.state === "active") active++;
        else otherState++;
        continue;
      }
      xactGoneSeen = s.t;
      endState = row ? String(row.state).replace(/\s+/g, "_") : "gone";
      xactEnd = row && row.xact_ms === null && row.change_ms !== null ? row.change_ms : undefined;
      break;
    }
  }
  fields.print_pid = printPid ?? "na";
  fields.xact_start_ms = rel(printXact);
  fields.xact_end_ms = rel(xactEnd); // state_change of the backend once its transaction is over
  fields.xact_gone_seen_ms = rel(xactGoneSeen);
  fields.xact_end_state = endState;
  fields.samples_idle_in_tx = idleInTx;
  fields.samples_active = active;
  fields.samples_other = otherState;
  // Where the release landed, read off the line: against Prisma's timer, the render's end and the
  // merged save's start (the ticket's expected first turn).
  const delta = (a: number | undefined, b: number | undefined) =>
    (a === undefined || b === undefined ? "na" : Math.round(a - b));
  fields.release_minus_timer_ms = delta(xactEnd, timer?.fired);
  fields.release_minus_render_end_ms = delta(xactEnd, render.times.end);
  fields.release_minus_save_start_ms = delta(xactEnd, saves.calls.at(-1)?.start);
  fields.released_before_settle = firstLocked && freeAfter
    ? (freeAfter.tOrder < tSettle ? "yes" : "no") : "na";
  if (probeError) fields.probe_error = probeError.replace(/\s+/g, " ").slice(0, 120);

  if (!outcome.ok) {
    const err = outcome.err as { constructor?: { name?: string }; code?: unknown; status?: unknown; meta?: unknown; message?: unknown };
    const meta = (err.meta ?? {}) as { timeout?: unknown; timeTaken?: unknown };
    fields.err = err.constructor?.name ?? typeof err;
    fields.code = err.code === undefined ? "na" : String(err.code);
    fields.status = err.status === undefined ? (err instanceof HttpError ? err.status : "na") : String(err.status);
    // The refusal of a print whose claim expired (#556's two ticket sentences, #521's traveler one).
    fields.refused = err instanceof HttpError && err.status === 400 && err.message.includes("took too long to print")
      ? "yes" : "no";
    // A raw P2028: both prints map their expiry to the refusal, so a yes on a print is a regression.
    fields.expired = isExpiredTransaction(err) ? "yes" : "no";
    fields.prisma_timeout = typeof meta.timeout === "number" ? meta.timeout : "na";
    fields.prisma_time_taken = typeof meta.timeTaken === "number" ? meta.timeTaken : "na";
    fields.msg = JSON.stringify(String(err.message ?? err).replace(/\s+/g, " ").slice(0, 200));
  }

  console.log(`[measure-556] ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (JSON_OUT) {
    appendFileSync(JSON_OUT, JSON.stringify({
      fields, t0, tSettle, timers: timers.records, saves: saves.calls, render: render.times,
      ticks: ticks.map((t) => t - t0),
      samples: samples.map((s) => ({
        ...s, t: s.t - t0, tOrder: s.tOrder - t0, tShipper: s.tShipper - t0, tEnd: s.tEnd - t0,
      })),
    }) + "\n");
  }
  return { outcome, pages, fields };
}

// ------------------------------------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------------------------------------

/** One customer, one part with one step, N orders of one line each, and one shipment carrying
 *  them all. Built incrementally, each step its own small transaction, so the setup never runs
 *  one Serializable transaction over N orders against the 5 s default (createShipper over 160
 *  orders could expire on its own). `serialsPerOrder` > 0 adds that many printable serials to each
 *  order's ticket (the multi-page variant), written raw as the overflow case in
 *  tests/shipping-ticket-templates.test.ts writes them, snapshot columns filled. */
async function ticketShipment(n: number, serialsPerOrder: number, logo = false) {
  const customer = await prisma.customer.create({ data: { code: "M556", name: "Measure 556 Co" } });
  if (logo) {
    // The shop's planned header logo is an RGBA PNG of 1716x560 (HANDOFF §7 item 6). A synthetic
    // RGBA PNG of about those pixels (a wide Code 128, colour type 6) placed on the ticket the
    // shipment resolves (MOS_SHIPPER for 2+ orders), through the same publish-and-assign recipe as
    // tests/shipping-ticket-templates.test.ts. A barcode deflates faster than real artwork, so its
    // cost per sheet is a floor; what it shows is whether the ticket then turns once per sheet.
    const docType = n > 1 ? "MOS_SHIPPER" as const : "SHIPPER" as const;
    const png = await toBuffer({ bcid: "code128", text: "AHT-LOGO-556-SYNTH", scale: 7, height: 28, includetext: false });
    const t = await asSystem(() => createTemplate(docType, `Measure 556 logo ${docType}`));
    const c = structuredClone(docType === "MOS_SHIPPER" ? MOS_SHIPPER_DEFAULT_CONFIG : SHIPPER_DEFAULT_CONFIG);
    c.logo = { placement: "header-right", width: 90 };
    await asSystem(() => editDraft(t.id, { config: c, updatedAt: t.draft.updatedAt }));
    await asSystem(() => uploadLogo(t.id, png, "image/png"));
    await asSystem(() => publishDraft(t.id));
    await asSystem(() => assignTemplate(customer.id, docType, t.id));
  }
  await prisma.customerAddress.create({
    data: {
      customerId: customer.id, kind: "BILL_TO", name: "Accounts payable", street: "300 Example Way",
      city: "Anniston", state: "AL", zip: "36201", isDefault: true,
    },
  });
  const shipTo = await prisma.customerAddress.create({
    data: {
      customerId: customer.id, kind: "SHIP_TO", name: "Demo Components Corporation", street: "300 Example Way",
      city: "Anniston", state: "AL", zip: "36201", isDefault: true,
    },
  });
  const code = await prisma.processStepCode.create({ data: { code: "M556", name: "Austenitize" } });
  const part = await prisma.part.create({
    data: {
      customerId: customer.id, partNumber: "M556-1", name: "Track Shoe", description: "D-001",
      eachWeight: "21.5000",
    },
  });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });

  const tOrders = Date.now();
  const orders: OrderDetail[] = [];
  for (let i = 0; i < n; i++) {
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: `M556-PO-${i + 1}`, customerJobNo: "JOB-9",
      lines: [{ partId: part.id, qty: 10, weight: "215.00" }],
    }));
    orders.push(order);
  }
  const lineOf = (o: OrderDetail) => ({
    orderLineId: o.lines[0].id, qty: o.lines[0].qty, weight: o.lines[0].weight, lineComplete: true,
  });

  const tShipment = Date.now();
  const { shipper: first } = await asSystem(() => createShipper({
    customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id, route: "South",
    orders: [{ orderId: orders[0].id, lines: [lineOf(orders[0])], containers: [], serials: [] }],
  }, { canOverrideCreditHold: false }));
  for (const order of orders.slice(1)) {
    const detail = await asSystem(() => addOrderToShipper(first.id, order.id));
    const so = detail.orders.find((o) => o.orderId === order.id)!;
    await asSystem(() => replaceShipperLines(first.id, so.id, [lineOf(order)]));
  }

  const tSerials = Date.now();
  const shipperOrders = await prisma.shipperOrder.findMany({
    where: { shipperId: first.id }, select: { id: true, orderId: true },
  });
  expect(shipperOrders).toHaveLength(n);
  if (serialsPerOrder > 0) {
    for (const so of shipperOrders) {
      const order = orders.find((o) => o.id === so.orderId)!;
      const lineId = order.lines[0].id;
      await prisma.orderSerial.createMany({
        data: Array.from({ length: serialsPerOrder }, (_, i) => ({
          orderId: order.id, lineId, position: i + 1,
          serial: `SER-${String(i + 1).padStart(3, "0")}`, description: "",
        })),
      });
      const serials = await prisma.orderSerial.findMany({
        where: { orderId: order.id }, select: { id: true, serial: true, lineId: true },
      });
      await prisma.shipperSerial.createMany({
        data: serials.map((s) => ({
          shipperOrderId: so.id, orderSerialId: s.id, printOnShipper: true,
          serial: s.serial, description: "", orderLineIdAtSave: s.lineId,
        })),
      });
    }
  }
  // The member order the probe watches: the lowest id, the first row claimOrdersInOrder locks.
  const probeOrderId = [...orders.map((o) => o.id)].sort()[0];
  const tDone = Date.now();
  const fixtureDetail = `orders:${tShipment - tOrders}/shipment:${tSerials - tShipment}/serials:${tDone - tSerials}`;
  return { shipperId: first.id, probeOrderId, fixtureDetail };
}

const TWO_PAGE_INSTRUCTION =
  "Ramp the furnace to soak temperature, hold until the whole load equalizes, verify with " +
  "the pyrometer log, then transfer to the quench within the allowed window and record the " +
  "elapsed transfer time on this line before the next step begins.";

/** The W5 timing order (tests/traveler-templates.test.ts): one line of `loads` pieces, loadQty 1,
 *  so `loads` loads. two-page: 25 steps whose instruction wraps (two pages a sheet); one-page:
 *  3 short steps. */
async function travelerOrder(loads: number, variant: string) {
  const customer = await prisma.customer.create({ data: { code: "W5T", name: "Timing Co" } });
  const code = await prisma.processStepCode.create({ data: { code: "W5T", name: "Austemper" } });
  const part = await prisma.part.create({
    data: { customerId: customer.id, partNumber: "W5T-1", name: "Timing Part", eachWeight: "1.0000", loadQty: 1 },
  });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  const steps = variant === "two-page"
    ? Array.from({ length: 25 }, (_, i) => ({ revisionId: rev.id, position: i + 1, codeId: code.id, instruction: TWO_PAGE_INSTRUCTION }))
    : Array.from({ length: 3 }, (_, i) => ({ revisionId: rev.id, position: i + 1, codeId: code.id, instruction: `Step ${i + 1}.` }));
  await prisma.partProcessStep.createMany({ data: steps });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: part.id, qty: loads, weight: `${loads}.00` }],
  }));
  expect(order.loads).toHaveLength(loads);
  return { orderId: order.id };
}

// ------------------------------------------------------------------------------------------------
// The measurements
// ------------------------------------------------------------------------------------------------

describe("#556 print-claim timing (MEASURE_556=1)", () => {
  // Off, one skipped placeholder and nothing else: no hook, no generated case, no database.
  if (!ON) {
    it.skip("set MEASURE_556=1 to run the #556 timing", () => {});
    return;
  }

  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? "";
    if (!/\/erp_test(\?|$)/.test(url)) throw new Error(`#556 timing refuses a database other than erp_test: ${url}`);
    TICKET_TIMEOUT_MS = readBudget("shippers.ts", "SHIPPING_TICKET_PRINT_TIMEOUT_MS");
    TRAVELER_TIMEOUT_MS = readBudget("traveler.ts", "TRAVELER_PRINT_TIMEOUT_MS");
    // practiceMode() memoizes its one database read per process; read it now so no measured print
    // pays it (it runs inside stampPractice, at the end of the render).
    expect(await practiceMode()).toBe(false);
    // No server-side timeout may end the transaction for Node: if one is set, say so on the record.
    const pg = await prisma.$queryRaw<{ name: string; setting: string }[]>`
      SELECT name, setting FROM pg_settings WHERE name IN ('idle_in_transaction_session_timeout',
        'transaction_timeout', 'statement_timeout', 'lock_timeout', 'server_version')`;
    const host = hostState();
    console.log(`[measure-556] config ticket_budget_ms=${TICKET_TIMEOUT_MS} traveler_budget_ms=${TRAVELER_TIMEOUT_MS} ` +
      `ns=${NS.join(",")} variants=${VARIANTS.join(",")} serials=${SERIALS} ` +
      `certs=${CERTS} tickets=${TICKETS} traveler=${TRAVELER} traveler_loads=${TRAVELER_LOADS} ` +
      `traveler_variants=${TRAVELER_VARIANTS.join(",")} reps=${REPS} poll_ms=${POLL_MS} tick_ms=${TICK_MS} ` +
      `node=${process.version} cpus=${(await import("node:os")).cpus().length} ` +
      `platform_profile=${host.profile} governor=${host.governor} ac_online=${host.ac_online} ` +
      `load1=${loadavg()[0].toFixed(2)} gc_exposed=${typeof (globalThis as { gc?: unknown }).gc === "function"} ` +
      pg.map((r) => `pg.${r.name}=${r.setting}`).join(" "));
  });
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  // Warm-up (JIT, fonts, first module paths): one small print of EVERY variant the run measures, so
  // no measured size pays the first pass through the multi-page two-pass render, the oversized-steps
  // layout or the logo embed. Measured and printed (variant=warmup-<variant>) but not counted. Each
  // its own test, so each gets a fresh database (the fixtures reuse their customer codes).
  if (TICKETS) {
    for (const variant of VARIANTS) {
      it(`warm-up ticket ${variant} n=2`, async () => {
        const t = Date.now();
        const s = await ticketShipment(2, variant.startsWith("multi-page") ? SERIALS : 0, variant.endsWith("-logo"));
        await measure({
          kind: "ticket", variant: `warmup-${variant}`, n: 2, rep: 0, fixtureMs: Date.now() - t,
          orderId: s.probeOrderId, shipperId: s.shipperId, timeoutMs: TICKET_TIMEOUT_MS, expectedPages: null,
          extra: { certs: String(CERTS) },
          print: () => printShippingTickets(s.shipperId, undefined, { withCerts: CERTS }),
        });
      }, LONG);
    }
  }
  if (TRAVELER) {
    for (const variant of TRAVELER_VARIANTS) {
      it(`warm-up traveler ${variant} loads=2`, async () => {
        const t = Date.now();
        const o = await travelerOrder(2, variant);
        await measure({
          kind: "traveler", variant: `warmup-${variant}`, n: 2, rep: 0, fixtureMs: Date.now() - t,
          orderId: o.orderId, shipperId: null, timeoutMs: TRAVELER_TIMEOUT_MS, expectedPages: null,
          print: () => printTraveler(o.orderId),
        });
      }, LONG);
    }
  }

  // Controls, no render: a transaction with a 500 ms timeout claims an order row, then either awaits
  // 1.5 s (the event loop turns, so Prisma's timer can fire and send ROLLBACK at ~500 ms) or holds the
  // thread for 1.5 s synchronously (the timer cannot run until the thread is free). They show what the
  // probe reports for a release mid-transaction and for one held to the end of a blocked stretch, and
  // exercise the error capture. Skipped with MEASURE_556_CONTROL=0.
  if (CONTROL) {
    for (const variant of ["yielding", "blocking"]) {
      it(`control ${variant}: 500 ms timeout, 1.5 s ${variant === "yielding" ? "await" : "synchronous hold"}`, async () => {
        const t = Date.now();
        const o = await travelerOrder(1, "one-page");
        await measure({
          kind: "control", variant, n: 1, rep: 1, fixtureMs: Date.now() - t,
          orderId: o.orderId, shipperId: null, timeoutMs: CONTROL_TIMEOUT_MS, expectedPages: null,
          print: () => prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${o.orderId} FOR UPDATE`;
            if (variant === "yielding") await new Promise((r) => setTimeout(r, 1_500));
            else { const end = Date.now() + 1_500; while (Date.now() < end) { /* hold the thread */ } }
            await tx.order.findFirst({ where: { id: o.orderId }, select: { id: true } });
            return null;
          }, { timeout: CONTROL_TIMEOUT_MS }),
        });
      }, LONG);
    }
  }

  if (TICKETS) {
    for (const variant of VARIANTS) {
      for (const n of NS) {
        for (let rep = 1; rep <= REPS; rep++) {
          it(`ticket ${variant} n=${n} rep=${rep}`, async () => {
            const t = Date.now();
            const multi = variant.startsWith("multi-page");
            const s = await ticketShipment(n, multi ? SERIALS : 0, variant.endsWith("-logo"));
            const { outcome, pages } = await measure({
              kind: "ticket", variant, n, rep, fixtureMs: Date.now() - t, fixtureDetail: s.fixtureDetail,
              orderId: s.probeOrderId, shipperId: s.shipperId, timeoutMs: TICKET_TIMEOUT_MS,
              expectedPages: multi ? 2 * n : n,
              extra: { certs: String(CERTS) },
              // The whole-set print as the route makes it for "Print all tickets" (order omitted,
              // withCerts as the pre-ticked checkbox sends it).
              print: () => printShippingTickets(s.shipperId, undefined, { withCerts: CERTS }),
            });
            // The variant must be what it claims: one page a ticket, or exactly two. A soft check, so a
            // mismatch is flagged without losing the rest of the run.
            if (outcome.ok) expect.soft(pages).toBe(multi ? 2 * n : n);
          }, LONG);
        }
      }
    }
  }

  if (TRAVELER) {
    for (const variant of TRAVELER_VARIANTS) {
      for (let rep = 1; rep <= REPS; rep++) {
        it(`traveler ${variant} loads=${TRAVELER_LOADS} rep=${rep}`, async () => {
          const t = Date.now();
          const o = await travelerOrder(TRAVELER_LOADS, variant);
          const { outcome, pages } = await measure({
            kind: "traveler", variant, n: TRAVELER_LOADS, rep, fixtureMs: Date.now() - t,
            orderId: o.orderId, shipperId: null, timeoutMs: TRAVELER_TIMEOUT_MS,
            expectedPages: variant === "two-page" ? 2 * TRAVELER_LOADS : TRAVELER_LOADS,
            print: () => printTraveler(o.orderId),
          });
          if (outcome.ok) expect.soft(pages).toBe(variant === "two-page" ? 2 * TRAVELER_LOADS : TRAVELER_LOADS);
        }, LONG);
      }
    }
  }
});
