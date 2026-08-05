import { describe, expect, test } from 'bun:test'

import { projectTools } from '../src/agent/Project.tool.js'
import { installProjectApprovalProvider } from '../src/composition/approval.js'

describe('project approval context', () => {
  test('dangerous project commands request approval that can never be reused', async () => {
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
        system: { canStartBackgroundCommands: () => true },
      } as never,
    )) as { approved: boolean }

    // 与 system:run 同一条判决：破坏性命令不进 riskScope 记忆，每次都要用户亲自点头。
    expect(seen).toEqual({
      approvalRisk: 'high',
      riskScope: 'project-command:dangerous',
      requireManualApproval: true,
      rememberRiskScope: false,
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

    installProjectApprovalProvider(kernel)

    expect(
      await kernel.providers.approval?.approve({
        action: 'apply_edit',
        risk: 'high',
        reason: 'test',
      }),
    ).toBe(false)
  })
})
