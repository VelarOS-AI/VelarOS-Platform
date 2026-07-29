/**
 * @test-meta
 * title: Velaros approval context
 * summary: 发布契约：验证 workspace approval provider 把风险 scope 传给宿主确认 API。
 * area: packages
 */
import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { installApprovalProvider, withApprovalContext } from '../dist/velaros/index.js'

test('workspace approval provider forwards a stable high-risk scope', async () => {
  const kernel = { providers: {} }
  const seen = []
  installApprovalProvider(kernel)

  await withApprovalContext(
    {
      abortSignal: new AbortController().signal,
      approval: {
        awaitConfirmationDecision: async (_message, _abortSignal, options) => {
          seen.push(options)
          return { approved: true }
        },
      },
    },
    async () => {
      const approved = await kernel.providers.approval.approve({
        action: 'apply_edit',
        paths: ['src/a.ts'],
        risk: 'high',
        reason: 'protected file',
      })

      assert.equal(approved, true)
    }
  )

  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], {
    approvalRisk: 'high',
    riskScope: 'workspace-approval:high:apply_edit',
  })
})
