import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Out-of-band process edits for fixtures (owner ruling 2026-09-26: the document save is the only
 *  write path). `edit` receives the saved steps as document rows and returns the rows to save. The
 *  baseline is a plain read; the save goes through `ctx.apiMutate`, the harness's counted write.
 *  Both must answer 200, as the per-step helpers this replaces required. A row from
 *  `newProcessStep` carries no parameters yet: they are copied here from its code's suggestions in
 *  the editor catalog (keys = suggestion IDs, empty values), as the editor's Add does, so a flow
 *  finds the same inputs on an appended step as on one added on screen. Every new row also names
 *  its code's code and name from that catalog, as the editor's Save does. Resolves with the save's
 *  answer: the saved baseline, the step id each submitted row landed on and each row's keys. */
export async function saveProcessViaApi(page, ctx, partId, edit) {
  const url = `${ctx.baseURL}/api/parts/${partId}/process/document`;
  // Recover one expired keep-alive socket on a read; Playwright retries only ECONNRESET.
  const res = await page.request.get(url, { maxRetries: 1 });
  assert.equal(res.status(), 200, `Read the process document of part ${partId}`);
  const baseline = await res.json();
  const steps = (baseline.revision?.steps ?? []).map(s => ({ clientId: s.id, stepId: s.id, codeId: s.codeId,
    instruction: s.instruction, parameters: s.parameters.map(p => ({ key: p.key, label: p.label, type: p.type, unit: p.unit, value: p.value })) }));
  const edited = edit(steps);
  const catalogRes = await page.request.get(`${ctx.baseURL}/api/process/editor-catalog`, { maxRetries: 1 });
  assert.equal(catalogRes.status(), 200, "Read the process editor catalog");
  const catalog = await catalogRes.json();
  const completed = edited.map(row => {
    if (row.stepId !== null) return row;
    const code = catalog.find(c => c.id === row.codeId);
    assert.ok(code, `Process code ${row.codeId} is in the editor catalog`);
    // An added step names the code and name it was added as (R11, #659), as the editor sends them.
    const named = { ...row, codeSeen: { code: code.code, name: code.name } };
    if (row.parameters !== undefined) return named;
    return { ...named, parameters: code.fields.map(f => ({ key: f.id, label: f.label, type: f.type, unit: f.unit, value: "" })) };
  });
  const saved = await ctx.apiMutate(page, url,
    { method: "PUT", data: { expectedBaselineToken: baseline.baselineToken, steps: completed } });
  assert.equal(saved.status(), 200, `Save the process document of part ${partId}: ${await saved.text()}`);
  return saved.json();
}

/** A new row for a `saveProcessViaApi` edit. The server assigns its step id; the harness runs in
 *  Node, so the provisional identity comes from node:crypto. Its parameters are copied from the
 *  code's suggestions by `saveProcessViaApi`. */
export function newProcessStep(codeId, instruction) {
  return { clientId: `new:${randomUUID()}`, stepId: null, codeId, instruction };
}
