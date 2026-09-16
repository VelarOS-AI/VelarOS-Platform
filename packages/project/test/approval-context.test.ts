import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createProjectKernel } from '../src/exports/index.js'
import { projectApprovalBridge } from '../src/impl/kernel/ProjectApprovalBridge.js'
import { projectTools } from '../src/impl/ProjectTools.js'

describe('project approval context', () => {
  test('dangerous project approval identifies the precise command and working directory', async () => {
    const workspaceRoot = resolve('/workspace')
    let seen: Record<string, unknown> | undefined
    const result = (await projectTools['project:run'].execute(
      { command: 'rm -rf ./dist' },
      {
        abortSignal: new AbortController().signal,
        approval: {
          awaitConfirmationDecision: async (
            _message: string,
            _signal?: AbortSignal,
            options?: Record<string, unknown>,
          ) => {
            seen = options
            return { approved: false, message: 'nope', autoApproved: false }
          },
        },
        project: { getRootPath: () => workspaceRoot },
      } as never,
    )) as { approved: boolean }

    expect(seen).toMatchObject({
      approvalRisk: 'high',
      riskScope: 'project-command:dangerous',
      // 任何权限档都要弹卡、也不记住答案：审批端口会用操作键覆盖 riskScope，只靠后缀挡不住自动放行。
      requireManualApproval: true,
      rememberRiskScope: false,
      operation: { label: 'rm -rf ./dist', target: workspaceRoot },
    })
    expect(result.approved).toBe(false)
  })

  test('宿主不给审批后端时，内核默认装上审批桥：工具调用里问当次的审批端口，调用之外拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'project-approval-default-'))
    try {
      const kernel = await createProjectKernel({ root })
      const approval = kernel.providers.approval
      expect(approval).toBeDefined()
      // 不在任何工具调用里：照旧拒绝，和「没有审批后端」的旧缺省等价。
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
