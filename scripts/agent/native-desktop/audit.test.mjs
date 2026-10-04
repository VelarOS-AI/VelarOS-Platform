// 用途：验证补丁访问审计区分普通文档、实际交付与待复核命令，且不依赖具体题目。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexPolicyAudit, isSolutionPatchURL, scriptPolicyAudit } from './audit.mjs'

test('recognizes patch URLs across repositories and leaves ordinary documentation available', () => {
  assert.equal(isSolutionPatchURL('https://github.com/a/b/commit/abc.patch'), true)
  assert.equal(isSolutionPatchURL('https://gitlab.example/a/b/commits/def.diff?raw=1'), true)
  assert.equal(isSolutionPatchURL('https://github.com/c/d/pull/12.patch'), true)
  assert.equal(isSolutionPatchURL('https://docs.example/api/read'), false)
  assert.equal(isSolutionPatchURL('file:///tmp/commit/a.patch'), false)
})

test('deduplicates execution pages and distinguishes delivered patch text from a failed attempt', () => {
  const call = {
    module: 'velaros:web',
    operation: 'read',
    status: 'succeeded',
    input: JSON.stringify({ url: 'https://github.com/a/b/commit/abc.patch' }),
    output: JSON.stringify({ text: 'patch body' }),
  }
  const page = { turns: [{ executions: [{ executionId: 'one', calls: [call] }] }] }
  const delivered = scriptPolicyAudit([page, page])
  assert.equal(delivered.confirmedSolutionPatchAccess, true)
  assert.equal(delivered.requiresReview, false)
  assert.equal(delivered.findings.length, 1)
  assert.equal(delivered.findings[0].deliveredChars, 10)
  call.status = 'failed'
  call.output = '{}'
  const failed = scriptPolicyAudit([page])
  assert.equal(failed.confirmedSolutionPatchAccess, false)
  assert.equal(failed.requiresReview, true)
})

test('command URLs require delivery review and do not claim a confirmed violation', () => {
  const audit = codexPolicyAudit(
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', command: "curl 'https://github.com/x/y/pull/33.diff'" },
    })
  )
  assert.equal(audit.requiresReview, true)
  assert.equal(audit.confirmedSolutionPatchAccess, false)
  assert.equal(audit.findings.length, 1)
})
