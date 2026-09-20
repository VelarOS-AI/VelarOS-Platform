// Run after compiling: node --test smoke.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { evidenceBudget, deltaCanServeAsCurrentContent,
  validateSelections, recoveryAction, operationInputCompatible } = require('./dist/invariants.js');
const { candidate, selection, budget, unknownWrite } = require('./dist/contracts.examples.js');
const candidates = new Map([['c1', candidate]]);
const allowed = new Set(['i1']);

test('budget includes output, mandatory feedback and envelope', () => {
  assert.deepEqual(evidenceBudget(budget), { kind: 'ok', tokens: 7000 });
});
test('mandatory overflow blocks; does not silently remove constraints', () => {
  assert.deepEqual(evidenceBudget({ ...budget, windowTokens: 8000 }), { kind: 'blocked', deficit: 1000 });
});
test('invalid and unsafe numeric budgets rejected', () => {
  for (const value of [-1, NaN, Infinity, 1.5]) {
    assert.throws(() => evidenceBudget({ ...budget, envelope: value }), RangeError);
  }
});
test('change-summary cannot serve as current full content', () => {
  assert.equal(deltaCanServeAsCurrentContent({ kind: 'change-summary', fromHash: 'a', toHash: 'b' }, new Map()), false);
});
test('previously seen but currently absent baseline is insufficient', () => {
  assert.equal(deltaCanServeAsCurrentContent({ kind: 'reconstructive-delta', baseEvidenceId: 'e1', baseContentHash: 'a', targetContentHash: 'b' }, new Map()), false);
});
test('wrong baseline hash rejected', () => {
  assert.equal(deltaCanServeAsCurrentContent({ kind: 'reconstructive-delta', baseEvidenceId: 'e1', baseContentHash: 'a', targetContentHash: 'b' }, new Map([['e1', 'wrong']])), false);
});
test('exact baseline physically available in request allows delta', () => {
  assert.equal(deltaCanServeAsCurrentContent({ kind: 'reconstructive-delta', baseEvidenceId: 'e1', baseContentHash: 'a', targetContentHash: 'b' }, new Map([['e1', 'a']])), true);
});
test('registered compatible selection accepted', () => {
  assert.deepEqual(validateSelections([selection], candidates, allowed, 8), { ok: true });
});
test('hallucinated candidate rejected', () => {
  assert.equal(validateSelections([{ ...selection, candidateId: 'fake' }], candidates, allowed, 8).code, 'UNKNOWN_CANDIDATE');
});
test('foreign intent rejected', () => {
  assert.equal(validateSelections([{ ...selection, intentIds: ['foreign'] }], candidates, allowed, 8).code, 'INVALID_INTENT');
});
test('unsupported representation rejected', () => {
  assert.equal(validateSelections([{ ...selection, form: 'summary' }], candidates, allowed, 8).code, 'UNSUPPORTED_FORM');
});
test('duplicate selection rejected', () => {
  assert.equal(validateSelections([selection, selection], candidates, allowed, 8).code, 'DUPLICATE_SELECTION');
});
test('selection budget enforced', () => {
  assert.equal(validateSelections([selection], candidates, allowed, 0).code, 'PLAN_TOO_LARGE');
});
test('unknown external write must reconcile, not retry', () => {
  assert.equal(recoveryAction(unknownWrite), 'reconcile');
});
test('successful write reuses receipt, not execution', () => {
  assert.equal(recoveryAction({ ...unknownWrite, outcome: 'succeeded' }), 'reuse-result');
});
test('failed read may be retried through broker budget', () => {
  assert.equal(recoveryAction({ ...unknownWrite, effect: 'read', outcome: 'failed', idempotency: { kind: 'read-only' } }), 'retry-read');
});
test('same operation with different inputs cannot reuse receipt', () => {
  assert.equal(operationInputCompatible('a', 'b'), false);
  assert.equal(operationInputCompatible('', ''), false);
  assert.equal(operationInputCompatible('a', 'a'), true);
});
