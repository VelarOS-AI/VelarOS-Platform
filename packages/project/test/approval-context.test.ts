import { describe, expect, test } from 'bun:test'

import { projectTools } from '../src/agent/Project.tool.js'
import {
  analyzeCommandExecution,
  isParallelCommandExecutionSafe,
  isShellCommandReadOnly,
} from '../src/command-execution-policy.js'
import { installProjectApprovalProvider } from '../src/composition/approval.js'

describe('project approval context', () => {
  test('finds git subcommands after global options and fails closed for unknown forms', () => {
    expect(isShellCommandReadOnly('git -C repo status')).toBe(true)
    expect(isShellCommandReadOnly('git -c core.fileMode=false log -1')).toBe(true)
    expect(isShellCommandReadOnly('git --git-dir repo/.git status')).toBe(true)
    expect(isShellCommandReadOnly('git --git-dir=repo/.git status')).toBe(true)
    expect(isShellCommandReadOnly('git -C --output=repo status')).toBe(true)
    expect(isShellCommandReadOnly('git -C repo checkout main')).toBe(false)
    expect(isShellCommandReadOnly('git --git-dir=repo/.git clean -fd')).toBe(false)
    expect(isShellCommandReadOnly('git branch -D obsolete')).toBe(false)
    expect(isShellCommandReadOnly('git config --set core.fileMode false')).toBe(false)
    expect(isShellCommandReadOnly('git diff --output=changes.patch')).toBe(false)
    expect(isShellCommandReadOnly('git log --output history.txt')).toBe(false)
    expect(isShellCommandReadOnly('git show --output=commit.txt HEAD')).toBe(false)
    expect(isShellCommandReadOnly('git --future-option status')).toBe(false)
    expect(isShellCommandReadOnly('git future-command')).toBe(false)
    expect(isShellCommandReadOnly('git -C')).toBe(false)
    expect(isParallelCommandExecutionSafe({
      command: 'git -C repo checkout main',
      parallel: true,
    })).toBe(false)
  })

  test('recognizes split and long recursive force removals as dangerous', () => {
    for (const command of [
      'rm -r -f ./victim',
      'rm -f -r ./victim',
      'rm --recursive --force ./victim',
      'rm -r --force ./victim',
    ]) {
      const plan = analyzeCommandExecution(command)
      expect(plan.isDangerous).toBe(true)
      expect(plan.shouldRequestConfirmation).toBe(true)
    }

    expect(analyzeCommandExecution('rm -f ./file').isDangerous).toBe(false)
    expect(analyzeCommandExecution('rm -r ./directory').isDangerous).toBe(false)
  })

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
