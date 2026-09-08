import { describe, expect, test } from 'bun:test'

import { projectTools } from '../../project/src/agent/Project.tool'
import type { ProjectToolContext } from '../../project/src/agent/Types'
import { systemPrimitiveTools } from '../../system/src/Primitive.tool'
import type { SystemToolContext } from '../../system/src/Types'
import { CodingSessionTracker } from '../src/agent/CodingSessionTracker'
import type { ApprovalPort } from '../src/tool-contract/approval'
import { createTaskApprovalPort } from '../src/tool-contract/task-approval'

function tools(approved: boolean) {
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
    return { command, cwd: '/workspace', stdout: '', stderr: '', exitCode: 0, signal: null,
      durationMs: 0, timedOut: false, aborted: false, truncated: false, success: true,
      verification: { kind: 'unknown' as const, status: 'unknown' as const, issues: [] } }
  }
  const unused = (): never => { throw new Error('unexpected host access') }
  const system: SystemToolContext = {
    abortSignal: new AbortController().signal, approval,
    system: {
      resolveCommandCwd: (cwd) => cwd ?? '/workspace',
      canStartBackgroundCommands: () => true, runCommand: run,
      globalSearch: unused, listProcesses: unused, listOpenPorts: unused,
      listBackgroundTasks: unused, terminateBackgroundTask: unused,
      refreshShellEnvironment: unused, openPath: unused, revealPath: unused,
      openApplication: unused, canRefreshShellEnvironment: () => false,
    },
  }
  const project: ProjectToolContext = {
    abortSignal: system.abortSignal, approval, system: system.system,
    project: {
      getRootPath: () => '/workspace', runCommand: run,
      runInDirectory: async (_path, action) => action(), runWithApproval: async (action) => action(),
      prepareMutation: async () => ({ approved: true, rootPath: '/workspace', switched: false,
        alreadyAuthorized: true, rejectionMessage: null, message: 'allowed' }),
      kernel: unused, queryCode: unused,
    },
  }
  return { system, project, tracker, cards: () => cards, runs: () => runs }
}

describe('shared tool operation identity', () => {
  test('changing from system run to project run cannot repeat a rejected command', async () => {
    const h = tools(false)
    await expect(systemPrimitiveTools['system:run'].execute({ command: 'rm -rf ./dist' }, h.system))
      .rejects.toMatchObject({ code: 'EXECUTION_DENIED' })
    expect(await projectTools['project:run'].execute({ command: 'rm -rf ./dist' }, h.project))
      .toMatchObject({ approved: false, message: 'use a backup' })
    expect(h.cards()).toBe(1)
    expect(h.runs()).toBe(0)
  })

  test('the same approved command is reused across tools, with a new decision for another target', async () => {
    const h = tools(true)
    await systemPrimitiveTools['system:run'].execute({ command: 'rm -rf ./dist' }, h.system)
    await projectTools['project:run'].execute({ command: 'rm -rf ./dist' }, h.project)
    expect(h.cards()).toBe(1)
    await projectTools['project:run'].execute({ command: 'rm -rf ./other' }, h.project)
    expect(h.cards()).toBe(2)
    expect(h.runs()).toBe(3)
    h.tracker.revokeTaskApproval(h.tracker.getTaskApprovalRecords()[0]!.id)
    await projectTools['project:run'].execute({ command: 'rm -rf ./dist' }, h.project)
    expect(h.cards()).toBe(3)
  })
})
