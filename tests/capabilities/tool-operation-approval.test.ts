/**
 * 跨空间的工具操作身份：system:run 与 project:run 共用任务级审批端口，同一条危险命令换个工具也不能绕过用户的拒绝，
 * 批准也不会进任务记忆（危险命令每次都要人点头）。两个空间互不引用，这条约束属于仓库层，所以测试放在这里。
 */

import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { ApprovalPort } from '../../packages/agent/src/contract/requires.js'
import { CodingSessionTracker } from '../../packages/agent/src/impl/session/CodingSessionTracker'
import { createTaskApprovalPort } from '../../packages/agent/src/utils/toolkit/task-approval'
import type { ProjectToolContext } from '../../packages/project/src/contract/requires'
import { projectTools } from '../../packages/project/src/impl/ProjectTools'
import type { SystemToolContext } from '../../packages/system/src/index'
import { systemTools } from '../../packages/system/src/index'

function tools(approved: boolean) {
  const workspaceRoot = resolve('/workspace')
  const tracker = new CodingSessionTracker()
  let cards = 0
  let runs = 0
  const delegate: ApprovalPort = {
    awaitConfirmation: async () => { throw new Error('use shared decision channel') },
    awaitConfirmationDecision: async () => { cards++; return { approved, message: 'use a backup' } },
  }
  const approval = createTaskApprovalPort(delegate, tracker, {
    shouldAutoApprove: (options) => tracker.hasConfirmedRiskScope(options.riskScope ?? ''),
  })
  const run = async (command: string) => {
    runs++
    return { command, cwd: workspaceRoot, stdout: '', stderr: '', exitCode: 0, signal: null,
      durationMs: 0, timedOut: false, aborted: false, truncated: false, success: true,
      verification: { kind: 'unknown' as const, status: 'unknown' as const, issues: [] } }
  }
  const unused = (): never => { throw new Error('unexpected host access') }
  const system: SystemToolContext = {
    abortSignal: new AbortController().signal, approval,
    system: {
      resolvePath: (path) => resolve(workspaceRoot, path ?? '.'),
      runCommand: run,
      listBackgroundTasks: unused,
      refreshShellEnvironment: unused,
      createSandbox: unused,
      diffSandbox: unused,
      applySandbox: unused,
      discardSandbox: unused,
    },
  }
  const project: ProjectToolContext = {
    abortSignal: system.abortSignal, approval,
    project: {
      getRootPath: () => workspaceRoot, runCommand: run,
      runInDirectory: async (_path, action) => action(), runWithApproval: async (action) => action(),
      prepareMutation: async () => ({ approved: true, rootPath: workspaceRoot, switched: false,
        alreadyAuthorized: true, rejectionMessage: null, message: 'allowed' }),
      // project:run 的输出要过项目的脱敏后端，所以这里给一个只做脱敏的内核替身。
      kernel: async () => ({ redactText: async ({ content }: { content: string }) => ({ content, redacted: false }) }) as never,
      queryCode: unused,
    },
  }
  return { system, project, tracker, cards: () => cards, runs: () => runs }
}

describe('shared tool operation identity', () => {
  test('changing from system run to project run cannot repeat a rejected command', async () => {
    const h = tools(false)
    await expect(systemTools['system:run'].execute({ command: 'rm -rf ./dist' }, h.system))
      .rejects.toMatchObject({ code: 'EXECUTION_DENIED' })
    expect(await projectTools['project:run'].execute({ command: 'rm -rf ./dist' }, h.project))
      .toMatchObject({ approved: false, message: 'use a backup' })
    expect(h.cards()).toBe(1)
    expect(h.runs()).toBe(0)
  })

  test('an approved dangerous command is asked again, even from another tool', async () => {
    const h = tools(true)
    await systemTools['system:run'].execute({ command: 'rm -rf ./dist' }, h.system)
    await projectTools['project:run'].execute({ command: 'rm -rf ./dist' }, h.project)
    expect(h.cards()).toBe(2)
    expect(h.runs()).toBe(2)
    // 危险命令是人工审批：批准不进任务记忆，每次都由用户点头；拒绝仍跨工具共享（见上一条）。
    expect(h.tracker.getTaskApprovalRecords()).toEqual([])
  })
})
