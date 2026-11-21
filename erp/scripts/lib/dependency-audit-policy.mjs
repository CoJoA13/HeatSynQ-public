// No dependency-audit exception is approved (#209, owner ruling 2026-09-25): the Next 16.3.6
// adoption retired the temporary Windows/AVIF dispositions and their deadline machinery, so every
// high/critical advisory leaf blocks. A non-null security/audit-exception.json is REFUSED, never
// ignored: a stale or newly added file cannot authorize anything without a code change and an
// owner ruling. The built-image libheif check (image-decoder-policy.mjs) stays in the docker job.
export const NO_EXCEPTION_APPROVED =
  "No dependency-audit exception is approved; security/audit-exception.json must be null. A new exception needs an owner ruling.";
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isString = (value) => typeof value === "string" && value.length > 0;

function fail(message) {
  throw new Error(message);
}

function severity(value) {
  const rank = SEVERITIES.indexOf(value);
  if (rank < 0) fail("Invalid audit severity");
  return rank;
}

/** Pure decision boundary: execution evidence comes from the CLI, never from audit JSON itself. */
export function evaluateAudit(input) {
  // Checked first, before the report is read, so a clean report cannot hide a non-null file.
  if (!isObject(input) || input.policy !== null) fail(NO_EXCEPTION_APPROVED);
  const { report, npmExitCode } = input;
  if (npmExitCode !== 0 && npmExitCode !== 1) fail("Unexpected npm audit exit status");
  if (!isObject(report) || Object.hasOwn(report, "error") || report.auditReportVersion !== 2 || !isObject(report.vulnerabilities)) {
    fail("Invalid or failed npm audit report");
  }
  const rows = report.vulnerabilities;
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const [name, row] of Object.entries(rows)) {
    if (!isObject(row) || row.name !== name || !Array.isArray(row.via) || row.via.length === 0 ||
        !Array.isArray(row.nodes) || row.nodes.length === 0 || !row.nodes.every(isString)) {
      fail("Malformed audit advisory row");
    }
    severity(row.severity);
    counts[row.severity]++;
    counts.total++;
  }
  const reportedCounts = report.metadata?.vulnerabilities;
  if (!isObject(reportedCounts) || Object.entries(counts).some(([key, value]) => reportedCounts[key] !== value)) {
    fail("Audit metadata counts disagree with vulnerability rows");
  }
  const severe = counts.high + counts.critical > 0;
  if (npmExitCode !== (severe ? 1 : 0)) fail("npm audit exit status disagrees with its high/critical threshold");

  // Advisory leaves, not package rows: audit metadata counts packages, and one package row can
  // carry several advisories. Indirect references are walked so a parent row cannot hide a leaf.
  const blocking = new Set();
  const visited = new Map();
  const visiting = new Set();
  const visit = (name) => {
    if (!Object.hasOwn(rows, name)) fail("Unresolved audit dependency reference");
    if (visiting.has(name)) fail("Audit dependency reference cycle");
    if (visited.has(name)) return visited.get(name);
    visiting.add(name);
    const row = rows[name];
    let maximum = -1;
    for (const via of row.via) {
      if (typeof via === "string") {
        maximum = Math.max(maximum, visit(via));
        continue;
      }
      if (!isObject(via) || !isString(via.url) || !isString(via.name) || !isString(via.dependency)) {
        fail("Malformed audit advisory leaf");
      }
      const rank = severity(via.severity);
      maximum = Math.max(maximum, rank);
      if (rank >= 3) blocking.add(via.url);
    }
    if (severity(row.severity) !== maximum) fail("Audit row severity disagrees with its advisory evidence");
    visiting.delete(name);
    visited.set(name, maximum);
    return maximum;
  };
  for (const name of Object.keys(rows)) visit(name);
  return { passed: blocking.size === 0, blocking: [...blocking].sort() };
}
