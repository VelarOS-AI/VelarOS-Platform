import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { projectApprovalBridge } from '../impl/kernel/ProjectApprovalBridge.js'
import { createProjectKernel } from '../index.js'

describe('审批桥', () => {
  test('宿主不给审批后端时，内核默认装上审批桥：调用里问当次的审批端口，调用之外拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'project-approval-default-'))
    try {
      const kernel = await createProjectKernel({ root })
      const approval = kernel.providers.approval
      expect(approval).toBeDefined()
      // 不在任何调用里：照旧拒绝，和「没有审批后端」的旧缺省等价。
      expect(await approval!.approve({ action: 'apply_edit', paths: ['a.txt'], risk: 'high', reason: 'test' })).toBe(false)
      let asked = ''
      const approved = await projectApprovalBridge.run({
        approval: { awaitConfirmationDecision: async (message: string) => { asked = message; return { approved: true, message: null } } } as never,
        abortSignal: new AbortController().signal,
      }, () => Promise.resolve(approval!.approve({ action: 'apply_edit', paths: ['a.txt'], risk: 'high', reason: 'test' })))
      expect(approved).toBe(true)
      expect(asked).toContain('apply_edit')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('denies privileged approval when no host scope is active', async () => {
    const kernel: {
      providers: {
        approval?: {
          approve(input: {
            action: string
            risk: 'low' | 'medium' | 'high'
            reason: string
          }): Promise<boolean> | boolean
        }
      }
    } = { providers: {} }

    projectApprovalBridge.install(kernel)

    expect(
      await kernel.providers.approval?.approve({
        action: 'apply_edit',
        risk: 'high',
        reason: 'test',
      }),
    ).toBe(false)
  })
})
