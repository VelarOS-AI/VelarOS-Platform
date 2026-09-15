import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { projectApprovalBridge } from '../src/impl/operations/ProjectApprovalBridge.js'
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
