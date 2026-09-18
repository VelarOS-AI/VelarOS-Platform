import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { projectApprovalBridge } from '../src/impl/kernel/ProjectApprovalBridge.js'
import { createProjectKernel } from '../src/index.js'

import { failureOf, projectSpaceFixture } from './support/space'

describe('project approval context', () => {
  test('项目里的危险命令：确认卡片点名原样的命令与工作目录，必须用户亲自点、不记住答案', async () => {
    const root = await mkdtemp(join(tmpdir(), 'project-approval-dangerous-'))
    try {
      let ran = false
      const { call, confirmations, mutations } = await projectSpaceFixture({
        root, approve: false,
        runCommand: async () => { ran = true; throw new Error('被拒的命令不该跑起来') },
      })
      expect((await failureOf(call('shell', 'run', { command: 'rm -rf ./dist' }))).code).toBe('PERMISSION')
      expect(confirmations).toHaveLength(1)
      expect(confirmations[0]!.options).toMatchObject({
        approvalRisk: 'high',
        riskScope: 'project-command:dangerous',
        // 任何权限档都要弹卡、也不记住答案：审批端口会用操作键覆盖 riskScope，只靠后缀挡不住自动放行。
        requireManualApproval: true,
        rememberRiskScope: false,
        operation: { label: 'rm -rf ./dist', target: root },
      })
      // 被拒之后既不再问项目的修改授权，也不起进程。
      expect(mutations).toEqual([])
      expect(ran).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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
