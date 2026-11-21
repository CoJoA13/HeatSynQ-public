// Standalone Node 26 monitor. The systemd unit owns serialization via flock; no application
// packages, database credentials, Docker socket, or administrator session are needed here.
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BACKUP_STATES = new Set(['ok', 'failed', 'stale', 'unknown', 'not_applicable']);
const GITHUB_API = 'https://api.github.com';
const HOUR = 3_600_000;
const safeError = () => new Error('Monitor configuration, state, or transport is invalid; inspect the runbook.');

function endpoint(value) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw safeError();
  return url.href;
}

// The repository becomes part of an API route, so the names `.` and `..` are refused: `owner/..`
// would turn the issue route into another route.
function githubTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw safeError();
  const { repository, issue, mention, appClientId, privateKeyFile } = value;
  if (typeof repository !== 'string' || !/^[A-Za-z0-9-]{1,39}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/.test(repository) ||
      !Number.isSafeInteger(issue) || issue < 1 ||
      typeof mention !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(mention) ||
      typeof appClientId !== 'string' || !/^[A-Za-z0-9]{1,40}$/.test(appClientId) ||
      typeof privateKeyFile !== 'string' || !path.isAbsolute(privateKeyFile)) throw safeError();
  return { repository, issue, mention, appClientId, privateKeyFile };
}

export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw safeError();
  const { serviceId, tokenFile, stateDir, diskPaths } = value;
  if (typeof serviceId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(serviceId) ||
      typeof tokenFile !== 'string' || !path.isAbsolute(tokenFile) ||
      typeof stateDir !== 'string' || !path.isAbsolute(stateDir) ||
      !Array.isArray(diskPaths) || diskPaths.length < 1 || diskPaths.length > 8 ||
      diskPaths.some((p) => typeof p !== 'string' || !path.isAbsolute(p)) ||
      new Set(diskPaths).size !== diskPaths.length) throw safeError();
  const baseUrl = endpoint(value.baseUrl);
  const backupsRequired = value.backupsRequired ?? true;
  const minimumFreePercent = value.minimumFreePercent ?? 10;
  if (typeof backupsRequired !== 'boolean' || !Number.isFinite(minimumFreePercent) || minimumFreePercent < 1 || minimumFreePercent > 50) throw safeError();
  // The GitLab channel was removed on 2026-10-10. A config that still names it is refused, so a
  // stale config cannot run as if its notices were going somewhere.
  if (value.gitlab !== undefined) throw safeError();
  const github = value.github === undefined ? undefined : githubTarget(value.github);
  return { serviceId, tokenFile, stateDir, diskPaths, baseUrl, backupsRequired, minimumFreePercent, github };
}

// `anyBody` is for a caller that must read the status and headers of an answer whose body is not
// JSON: the body is then null where it would otherwise be a refusal.
/** @param {string | URL} url
 * @param {{token?: string, timeoutMs?: number, payload?: Record<string, unknown>, method?: string, headers?: Record<string, string>, maxBytes?: number, anyBody?: boolean}} options */
export async function fetchJson(url, { token = undefined, timeoutMs = 5000, payload = undefined, method = undefined, headers = {}, maxBytes = 8192, anyBody = false } = {}) {
  const response = await fetch(url, {
    method: method ?? (payload === undefined ? 'GET' : 'POST'),
    headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
  });
  const reader = response.body?.getReader();
  if (!reader) throw safeError();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw safeError();
      chunks.push(value);
    }
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { if (!anyBody) throw safeError(); }
    return { status: response.status, body, headers: response.headers };
  } finally { await reader.cancel().catch(() => {}); }
}

// A GitHub App signs in with a short-lived RS256 token: issued a minute back to allow for clock
// drift, good for nine minutes more, inside GitHub's ten-minute limit.
/** @param {string} clientId @param {import('node:crypto').KeyObject} key @param {number} nowSeconds */
export function appJwt(clientId, key, nowSeconds) {
  if (key.asymmetricKeyType !== 'rsa') throw safeError();
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(nowSeconds); // GitHub reads whole seconds.
  const body = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: now - 60, exp: now + 540, iss: clientId })}`;
  return `${body}.${sign('sha256', Buffer.from(body), key).toString('base64url')}`;
}

// How long GitHub asks a limited client to wait, in seconds: the seconds it names, or else the
// time until a spent allowance resets. A refusal that names neither (a missing permission, for
// one) returns null, and the next run simply tries again. A header counts only as whole digits,
// so one that is missing, empty or in another form names nothing.
/** @param {number} status @param {Headers} headers @param {number} nowSeconds */
export function waitSeconds(status, headers, nowSeconds) {
  if (status !== 403 && status !== 429) return null;
  const digits = (name) => { const value = headers.get(name); return value !== null && /^\d+$/.test(value) ? Number(value) : null; };
  const after = digits('retry-after');
  if (after !== null) return after;
  const reset = digits('x-ratelimit-reset');
  return headers.get('x-ratelimit-remaining') === '0' && reset !== null ? Math.max(0, reset - nowSeconds) : null;
}

const NEXT_STEP = {
  availability: 'Check the app and database containers and their logs, then the URL or proxy.',
  backups: 'Open Admin → Backups with an authorized account for the reason.',
};
const checkLabel = (key) => (key.startsWith('disk_') ? `disk ${key.slice(5)}` : key);
const nextStep = (key) => NEXT_STEP[key] ??
  `Free space or free inodes on entry ${key.slice(5)} of the monitor's \`diskPaths\` are under the configured minimum, or that path could not be read.`;
// Every time the owner reads is UTC, to the second.
const stamp = (iso) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');

// The hidden line that ends a notice. The monitor looks for it before it posts that notice again.
const noticeMarker = (incident, kind) => `<!-- heatsynq-monitor incident: ${incident.fingerprint} ${kind} -->`;

/** @param {{mention: string, serviceId: string, repository: string}} target @param {string} key
 * @param {{fingerprint: string, start_time: string}} incident */
export function firingComment(target, key, incident) {
  return `@${target.mention} The **${checkLabel(key)}** check on \`${target.serviceId}\` has failed three times in a row, ` +
    `first at ${stamp(incident.start_time)}. ${nextStep(key)} ` +
    `Runbook: https://github.com/${target.repository}/blob/main/ops/monitoring/README.md` +
    `\n\n${noticeMarker(incident, 'firing')}`;
}

/** @param {{mention: string, serviceId: string}} target @param {string} key
 * @param {{fingerprint: string, start_time: string, end_time?: string}} incident */
export function recoveryComment(target, key, incident) {
  return `@${target.mention} The **${checkLabel(key)}** check on \`${target.serviceId}\` has passed twice in a row, ` +
    `as of ${stamp(incident.end_time)}. The incident began at ${stamp(incident.start_time)}.` +
    `\n\n${noticeMarker(incident, 'recovery')}`;
}

// An incident is open from its third failure until its second healthy reading sets end_time.
/** @param {Record<string, any>} checks */
export function openIncidents(checks) {
  return Object.entries(checks).filter(([, check]) => check.incident && !check.incident.end_time)
    .map(([key, check]) => `${checkLabel(key)} since ${stamp(check.incident.start_time)}`).join('; ') || 'none';
}

// The tracking issue's description. Its first line is the marker ops/monitoring/watch.mjs parses.
/** @param {string} serviceId @param {{checkedAt: string, availability: string, backups: string, disks: {state: string}[]}} report
 * @param {string} incidents */
export function heartbeatBody(serviceId, report, incidents) {
  return [
    `<!-- heatsynq-monitor last-report: ${stamp(report.checkedAt)} -->`,
    `**Install:** \`${serviceId}\``,
    `**Last report:** ${stamp(report.checkedAt)}`,
    `**Availability:** ${report.availability}`,
    `**Backups:** ${report.backups}`,
    ...report.disks.map((disk, index) => `**Disk ${index + 1}:** ${disk.state}`),
    `**Open incidents:** ${incidents}`,
    '',
    'The health monitor on this install rewrites this description about once an hour, and when an incident opens or ends. ' +
      'The monitor watch reads it. The comments below need you.',
  ].join('\n');
}

export function advanceCheck(previous, healthy, now) {
  const next = structuredClone(previous ?? { failures: 0, successes: 0 });
  if (healthy === null) return next; // No observation never supplies recovery evidence.
  if (healthy) {
    next.failures = 0; delete next.firstFailure;
    next.successes = Math.min(2, next.successes + 1);
    if (next.successes === 2 && next.incident && !next.incident.end_time) next.incident.end_time = now;
  } else {
    next.successes = 0;
    if (!next.failures) next.firstFailure = now;
    next.failures = Math.min(3, next.failures + 1);
    if (next.failures === 3) {
      // An incident that ended after its firing was delivered is over, whether or not its recovery
      // got through. Failing again is a new incident with its own fingerprint and start, so its
      // firing is told apart from the old one and is not taken for a notice GitHub already has.
      if (next.incident?.end_time && next.incident.firingSent) delete next.incident;
      next.incident ??= { fingerprint: randomUUID(), start_time: next.firstFailure, firingSent: false };
      // An incident whose firing never left still owes that one firing, under its first start.
      // (Its recovery was never tried: a recovery is sent only after its firing.)
      delete next.incident.end_time;
    }
  }
  return next;
}

async function secret(file) {
  const info = await stat(file);
  if (!info.isFile() || (info.mode & 0o077) || info.size > 4096) throw safeError();
  const value = (await readFile(file, 'utf8')).trim();
  if (!value || /\s/.test(value)) throw safeError();
  return value;
}

async function privateKey(file) {
  const info = await stat(file);
  if (!info.isFile() || (info.mode & 0o077) || info.size > 16384) throw safeError();
  return createPrivateKey(await readFile(file, 'utf8'));
}

async function persist(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, file);
  const directory = await open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

function validState(value, identity, keys) {
  const date = (s) => typeof s === 'string' && Number.isFinite(Date.parse(s));
  const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!value || value.version !== 2 || value.identity !== identity || !record(value.checks) ||
      Object.keys(value.checks).some((key) => !keys.includes(key))) return false;
  if (value.retryAt !== undefined && !date(value.retryAt)) return false;
  if (value.heartbeat !== undefined && !(record(value.heartbeat) && date(value.heartbeat.at) && typeof value.heartbeat.incidents === 'string')) return false;
  return Object.values(value.checks).every((s) => record(s) && Number.isInteger(s.failures) && s.failures >= 0 && s.failures <= 3 &&
    Number.isInteger(s.successes) && s.successes >= 0 && s.successes <= 2 &&
    (s.firstFailure === undefined || date(s.firstFailure)) &&
    (s.incident === undefined || (record(s.incident) && typeof s.incident.fingerprint === 'string' && /^[a-f0-9-]{36}$/.test(s.incident.fingerprint) &&
      date(s.incident.start_time) && typeof s.incident.firingSent === 'boolean' &&
      ['end_time', 'firingTried', 'recoveryTried'].every((field) => s.incident[field] === undefined || date(s.incident[field])))));
}

export function diskHealth(info, minimumFreePercent) {
  const freePercent = info.blocks > 0 ? 100 * info.bavail / info.blocks : 0;
  const freeInodesPercent = info.files > 0 ? 100 * info.ffree / info.files : null;
  const healthy = freePercent >= minimumFreePercent && (freeInodesPercent === null || freeInodesPercent >= minimumFreePercent);
  return { state: healthy ? 'ok' : 'low', freePercent: Math.floor(freePercent), freeInodesPercent: freeInodesPercent === null ? null : Math.floor(freeInodesPercent) };
}

async function observe(config) {
  const report = { availability: 'failed', backups: 'unavailable', disks: [] };
  const checks = { availability: false, backups: null };
  try {
    const { status, body } = await fetchJson(new URL('/api/health', config.baseUrl));
    checks.availability = status === 200 && body?.ok === true && body?.db === true;
  } catch { /* Request failures carry no private transport details into persisted state. */ }
  if (checks.availability) {
    report.availability = 'ok';
    try {
      const token = await secret(config.tokenFile);
      if (!/^[a-f0-9]{64}$/i.test(token)) throw safeError();
      const { status, body } = await fetchJson(new URL('/api/health/operations', config.baseUrl), { token, timeoutMs: 90000 });
      if (![200, 503].includes(status) || typeof body?.ok !== 'boolean' || typeof body?.db !== 'boolean' ||
          !BACKUP_STATES.has(body.backups) || (status === 200) !== body.ok ||
          body.ok !== (body.db && ['ok', 'not_applicable'].includes(body.backups))) throw safeError();
      report.backups = body.backups;
      checks.backups = body.db && (body.backups === 'ok' || (!config.backupsRequired && body.backups === 'not_applicable'));
    } catch { report.backups = 'unavailable'; checks.backups = false; }
  }
  for (let index = 0; index < config.diskPaths.length; index++) {
    let disk = { state: 'unknown', freePercent: null, freeInodesPercent: null };
    try {
      disk = diskHealth(await statfs(config.diskPaths[index]), config.minimumFreePercent);
    } catch { /* unreadable capacity is not healthy */ }
    report.disks.push(disk); checks[`disk_${index + 1}`] = disk.state === 'ok';
  }
  return { report, checks };
}

// One run's GitHub client. It signs in at most once, and it makes no request while GitHub has
// asked the monitor to wait: a 403 or 429 that names a wait sets state.retryAt, capped at an hour
// and counted from the answer, which can come well after the run began (the probes run first).
function githubClient(target, state, now, api, clock) {
  const at = Date.parse(now);
  const call = async (method, route, bearer, payload, maxBytes = 262144) => {
    if (state.retryAt !== undefined) throw safeError();
    // anyBody: a limit answered with a page that is not JSON still names its wait in the headers.
    const response = await fetchJson(new URL(route, api), { method, token: bearer, payload, timeoutMs: 10000, maxBytes, anyBody: true,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'heatsynq-monitor' } });
    const answered = clock();
    const wait = waitSeconds(response.status, response.headers, answered / 1000);
    if (wait !== null) state.retryAt = new Date(answered + Math.min(wait * 1000, HOUR)).toISOString();
    return response;
  };
  const signIn = async () => {
    const jwt = appJwt(target.appClientId, await privateKey(target.privateKeyFile), Math.floor(at / 1000));
    const installation = await call('GET', `/repos/${target.repository}/installation`, jwt);
    if (installation.status !== 200 || !Number.isSafeInteger(installation.body?.id)) throw safeError();
    // Narrowed to this repository's issues, whatever else the App is later granted.
    const grant = await call('POST', `/app/installations/${installation.body.id}/access_tokens`, jwt,
      { repositories: [target.repository.split('/')[1]], permissions: { issues: 'write' } });
    if (grant.status !== 201 || typeof grant.body?.token !== 'string' || !grant.body.token) throw safeError();
    return grant.body.token;
  };
  let token;
  const send = async (method, route, payload, accepted) => {
    token ??= signIn(); // One attempt a run: a sign-in that failed is not repeated for the next notice.
    const response = await call(method, route, await token, payload);
    if (response.status !== accepted) throw safeError();
  };
  const issue = `/repos/${target.repository}/issues/${target.issue}`;
  // Whether the issue already holds a comment with this marker, among those written since `since`.
  // One page of a hundred is read; a megabyte allows for long comments.
  const holds = async (marker, since) => {
    token ??= signIn();
    const response = await call('GET', `${issue}/comments?since=${since}&per_page=100`, await token, undefined, 1048576);
    if (response.status !== 200 || !Array.isArray(response.body)) throw safeError();
    return response.body.some((comment) => typeof comment?.body === 'string' && comment.body.includes(marker));
  };
  return { holds, comment: (body) => send('POST', `${issue}/comments`, { body }, 201), describe: (body) => send('PATCH', issue, { body }, 200) };
}

async function deliver(config, state, stateFile, now, api, clock) {
  const at = Date.parse(now);
  // A wait that has passed is over. So is one more than an hour ahead, which only a clock that
  // jumped can leave behind.
  const wait = state.retryAt === undefined ? 0 : Date.parse(state.retryAt) - at;
  if (!(wait > 0 && wait <= HOUR)) delete state.retryAt;
  // With no GitHub target there is nothing to post, and an incident still runs its course here:
  // marked as fired, then dropped once it has ended.
  const github = config.github ? githubClient(config.github, state, now, api, clock) : null;
  const target = { ...config.github, serviceId: config.serviceId };
  // Posts one notice. The time of the first try is on disk before the request leaves. A later try
  // means the first got no usable answer and may still have reached GitHub, so it reads the issue
  // for the notice's marker first and posts only when the marker is not there (owner ruling
  // 2026-10-10). It reads from five minutes before the first try, to allow for GitHub's clock.
  const notify = async (incident, kind, text) => {
    if (!github) return;
    const tried = `${kind}Tried`;
    if (incident[tried]) {
      if (await github.holds(noticeMarker(incident, kind), stamp(new Date(Date.parse(incident[tried]) - 300_000).toISOString()))) return;
    } else { incident[tried] = now; await persist(stateFile, state); }
    await github.comment(text);
  };
  for (const [key, check] of Object.entries(state.checks)) {
    const incident = check.incident;
    if (!incident) continue;
    try {
      if (!incident.firingSent) { await notify(incident, 'firing', firingComment(target, key, incident)); incident.firingSent = true; await persist(stateFile, state); }
      if (incident.end_time) { await notify(incident, 'recovery', recoveryComment(target, key, incident)); delete check.incident; await persist(stateFile, state); }
    } catch { state.report.delivery = 'failed'; }
  }
  // A run that could not deliver a notice writes no heartbeat. A channel that takes the heartbeat
  // and refuses notices would otherwise look alive for good; this way it goes stale and the watch
  // reports it.
  if (!github || state.report.delivery === 'failed') return;
  // The heartbeat: the tracking issue's description, which the monitor watch reads. Due when none
  // was written, when the last is an hour old or is stamped ahead of now (a clock that stepped
  // back), or when the open incidents changed.
  const incidents = openIncidents(state.checks);
  const age = state.heartbeat ? at - Date.parse(state.heartbeat.at) : HOUR;
  if (age < 0 || age >= HOUR || state.heartbeat.incidents !== incidents) {
    try { await github.describe(heartbeatBody(config.serviceId, state.report, incidents)); state.heartbeat = { at: now, incidents }; }
    catch { state.report.delivery = 'failed'; }
  }
}

// The API origin and the clock are test seams; the deployed CLI always talks to api.github.com
// and reads the system clock.
/** @param {ReturnType<typeof validateConfig>} config
 * @param {{now?: string, api?: string, clock?: () => number}} options */
export async function runCycle(config, { now = new Date().toISOString(), api = GITHUB_API, clock = Date.now } = {}) {
  // The tracking issue is part of the identity, so pointing the monitor at another one refuses the
  // old state. The App's Client ID and key file are not, so a key rotation keeps it.
  const identity = createHash('sha256').update(JSON.stringify({ baseUrl: config.baseUrl, serviceId: config.serviceId,
    diskPaths: config.diskPaths, backupsRequired: config.backupsRequired,
    github: config.github ? { repository: config.github.repository, issue: config.github.issue } : null })).digest('hex');
  const keys = ['availability', 'backups', ...config.diskPaths.map((_, i) => `disk_${i + 1}`)];
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const dirInfo = await stat(config.stateDir);
  if (!dirInfo.isDirectory() || (dirInfo.mode & 0o077)) throw safeError();
  const stateFile = path.join(config.stateDir, 'state.json');
  let state = { version: 2, identity, checks: {} };
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (!validState(state, identity, keys)) throw safeError();
  } catch (error) { if (error.code !== 'ENOENT') throw safeError(); }
  const { checks, report } = await observe(config);
  state.report = { checkedAt: now, ...report, delivery: config.github ? 'ok' : 'disabled' };
  for (const [key, healthy] of Object.entries(checks)) state.checks[key] = advanceCheck(state.checks[key], healthy, now);
  // Persist before sending. A notice whose first try got no answer is looked for on the issue
  // before it is posted again; the fingerprint in each comment ties a recovery to its firing.
  await persist(stateFile, state);
  await deliver(config, state, stateFile, now, api, clock);
  await persist(stateFile, state);
  return state.report;
}

async function main() {
  if (process.argv.length !== 3) throw safeError();
  const info = await stat(process.argv[2]);
  if (!info.isFile() || (info.mode & 0o077) || info.size > 16384 || Number(process.versions.node.split('.')[0]) < 26) throw safeError();
  const config = validateConfig(JSON.parse(await readFile(process.argv[2], 'utf8')));
  const report = await runCycle(config);
  process.stdout.write(JSON.stringify(report) + '\n');
  // Monitored outages live in the state file and the notices. A delivery failure additionally reds the systemd run.
  if (report.delivery === 'failed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('HeatSynQ monitor could not complete; check configuration/state using the runbook.\n'); process.exitCode = 1; });
}
