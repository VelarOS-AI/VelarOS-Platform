/**
 * 跨空间的命令操作身份：系统空间与项目空间都挂 `velar:shell`，两边共用任务级审批端口；同一条危险命令换个空间也不能绕过用户的拒绝，
 * 批准也不会进任务记忆（危险命令每次都要人点头）。两个空间互不引用，这条约束属于仓库层，所以测试放在这里。
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import type { ApprovalPort } from '../../packages/agent/src/contract/requires.js'
import { CodingSessionTracker } from '../../packages/agent/src/impl/session/CodingSessionTracker'
import { agentToolContracts } from '../../packages/agent/src/impl/tools/AgentToolContracts'
import { createCapabilityPort } from '../../packages/code-surface/src/index'
import { createProjectSpace } from '../../packages/project/src/index'
import { createSystemSpace, type SystemSpaceHost } from '../../packages/system/src/index'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 两个空间装在同一个工作目录上，共用一个任务级审批端口；记下弹了几张卡、真跑了几条命令。 */
function spaces(approved: boolean) {
  // 项目空间按真实路径钳工作目录，系统空间原样解析：根先解开符号链接，两边的工作目录才是同一个字符串。
  const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'velaros-operation-approval-')))
  roots.push(workspaceRoot)
  const tracker = new CodingSessionTracker()
  let cards = 0
  let runs = 0
  const delegate: ApprovalPort = {
    awaitConfirmation: async () => { throw new Error('use shared decision channel') },
    awaitConfirmationDecision: async () => { cards++; return { approved, message: 'use a backup' } },
  }
  const approval = agentToolContracts.createTaskApprovalPort(delegate, tracker, {
    shouldAutoApprove: (options) => tracker.hasConfirmedRiskScope(options.riskScope ?? ''),
  })
  const run = async (command: string) => {
    runs++
    return { command, cwd: workspaceRoot, stdout: '', stderr: '', exitCode: 0, signal: null,
      durationMs: 0, timedOut: false, aborted: false, truncated: false, success: true,
      verification: { kind: 'unknown' as const, status: 'unknown' as const, issues: [] } }
  }
  const unused = (): never => { throw new Error('unexpected host access') }
  const host = {
    resolvePath: (path?: string) => resolve(workspaceRoot, path ?? '.'),
    runCommand: run,
    listBackgroundTasks: unused,
    refreshShellEnvironment: unused,
    terminateBackgroundTask: unused,
    listSandboxes: unused,
    createSandbox: unused,
    diffSandbox: unused,
    applySandbox: unused,
    discardSandbox: unused,
  } as unknown as SystemSpaceHost
  const system = createCapabilityPort(createSystemSpace({ host, resolveCall: () => ({ abortSignal: new AbortController().signal, approval }) }).operations)
  const project = createCapabilityPort(createProjectSpace({
    resolveCall: () => ({
      abortSignal: new AbortController().signal,
      approval,
      project: {
        getRootPath: () => workspaceRoot,
        runCommand: run,
        prepareMutation: async () => ({ approved: true, message: 'allowed' }),
        // 项目里的命令输出要过项目的脱敏后端，所以这里给一个只做脱敏的内核替身。
        kernel: async () => ({ redactText: async ({ content }: { content: string }) => ({ content, redacted: false }) }) as never,
        listBackgroundTasks: unused,
        refreshShellEnvironment: unused,
        terminateBackgroundTask: unused,
        queryCode: unused,
      },
    }),
  }).operations)
  const runIn = (port: typeof system, command: string) => port.invoke({ namespace: 'shell', operation: 'run', input: { command } })
  return { system, project, runIn, tracker, cards: () => cards, runs: () => runs }
}

describe('shared command operation identity', () => {
  test('changing from the system space to the project space cannot repeat a rejected command', async () => {
    const h = spaces(false)
    const first = await h.runIn(h.system, 'rm -rf ./dist')
    const second = await h.runIn(h.project, 'rm -rf ./dist')
    expect(first.error).toBeDefined()
    expect(second.error).toMatchObject({ code: first.error!.code })
    expect(h.cards()).toBe(1)
    expect(h.runs()).toBe(0)
  })

  test('an approved dangerous command is asked again, even from the other space', async () => {
    const h = spaces(true)
    expect((await h.runIn(h.system, 'rm -rf ./dist')).error).toBeUndefined()
    expect((await h.runIn(h.project, 'rm -rf ./dist')).error).toBeUndefined()
    expect(h.cards()).toBe(2)
    expect(h.runs()).toBe(2)
    // 危险命令是人工审批：批准不进任务记忆，每次都由用户点头；拒绝仍跨空间共享（见上一条）。
    expect(h.tracker.getTaskApprovalRecords()).toEqual([])
  })
})
