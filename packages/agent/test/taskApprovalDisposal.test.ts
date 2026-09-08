import { expect, test } from 'bun:test'

import { CodingSessionTracker } from '../src/agent/CodingSessionTracker'
import { PrimaryAgentProfile } from '../src/agent/PrimaryAgentProfile'
import { createAgentExecutionStack } from '../src/agent/runner'
import { ExecutionEventBus } from '../src/kernel/execution/ExecutionEventBus'
import type { ApprovalDecision } from '../src/protocol'
import { createTaskApprovalPort } from '../src/tool-contract/task-approval'

function createRunnerHarness() {
  const trackers: CodingSessionTracker[] = []
  const captured = new Error('context captured before model execution')
  const profile = new PrimaryAgentProfile(
    { getSkillMarkdownForRole: () => '', listSkillsForRole: () => [] },
    { getToolCategoryId: () => 'probe' }
  )
  const stack = createAgentExecutionStack({
    model: {
      createAgentProvider: () => { throw captured },
      resolveRoleRuntime: async () => { throw captured },
    },
    toolRegistry: {
      names: [], get: () => null, getDescriptor: () => null,
      listAvailable: () => [], toAiTools: () => ({}),
    },
    query: {
      roleEngine: { resolve: () => profile.resolve({ knownToolNames: [], allowSubAgents: false }) },
      getToolNamesForCategories: () => [],
    },
  })
  const runner = stack.createRunner({
    contextHelper: { buildToolContext: ({ codingSession }) => {
      expect(codingSession).toBeInstanceOf(CodingSessionTracker)
      trackers.push(codingSession as CodingSessionTracker)
      throw captured
    } },
    primaryAgentProfile: profile,
    subAgentDispatcher: {
      bindAgentRunner: () => undefined,
      clearExecution: () => undefined,
      dispatch: async () => { throw captured },
      describeExecutionLimits: () => { throw captured },
    },
    configService: {
      systemConfig: {
        thinkingDepth: 'balanced', disabledToolNames: [], prompt: { segmentOverrides: [] },
        advancedRuntime: {}, modelRuntimeContext: {},
      },
      chatConfig: { modelSelection: {}, systemPromptAppend: '' },
    },
    codingSessionPolicy: { toolCategoryToolNames: {} },
    surfaceProfileProvider: {
      resolve: () => ({ id: 'probe', allowSubAgents: false, toolPolicy: {
        baseCategories: [], includePromptFeatureCategories: false, restoreApprovedCategories: false,
      } }),
      deriveRunPolicy: () => ({
        activeSpace: 'default', initialToolCategories: [], initialActiveToolCategories: [],
        initialPromptFeatures: [], restoredApprovedCategories: [], allowSubAgents: false,
      }),
    },
  })
  const captureTracker = async (): Promise<CodingSessionTracker> => {
    await expect(runner.streamSoloWorker([], { sessionId: 'task' }, new ExecutionEventBus()))
      .rejects.toBe(captured)
    return trackers[trackers.length - 1]!
  }
  return { runner, captureTracker }
}

test('deleting task approvals invalidates retained parent, child and continuation owners', async () => {
  const { runner, captureTracker } = createRunnerHarness()
  const parent = await captureTracker()
  const child = parent.forkForSubAgent()
  const continuation = await captureTracker()
  parent.grantConfirmedRiskScope('operation-A')
  expect(child.hasConfirmedRiskScope('operation-A')).toBe(true)
  expect(continuation.hasConfirmedRiskScope('operation-A')).toBe(true)
  const snapshots: number[] = []
  runner.subscribeTaskApprovals((sessionId) => snapshots.push(runner.getTaskApprovalRecords(sessionId).length))

  runner.clearTaskApprovals('task')

  expect(runner.getTaskApprovalRecords('task')).toEqual([])
  for (const tracker of [parent, child, continuation]) {
    expect(tracker.getTaskApprovalRecords()).toEqual([])
    expect(() => tracker.hasConfirmedRiskScope('operation-A')).toThrow(expect.objectContaining({ code: 'EXECUTION_ABORTED' }))
    expect(() => tracker.grantConfirmedRiskScope('operation-B')).toThrow(expect.objectContaining({ code: 'EXECUTION_ABORTED' }))
  }
  expect(snapshots).toEqual([0])
  runner.clearTaskApprovals('task')
  const fresh = await captureTracker()
  expect(fresh.hasConfirmedRiskScope('operation-A')).toBe(false)
  fresh.grantConfirmedRiskScope('operation-A')
  expect(fresh.hasConfirmedRiskScope('operation-A')).toBe(true)
  expect(snapshots).toEqual([0, 1])
})

test('a pending approval cannot restore the disposed task owner through a late decision', async () => {
  const { runner, captureTracker } = createRunnerHarness()
  const tracker = (await captureTracker()).forkForSubAgent()
  let decide!: (value: ApprovalDecision) => void
  let markWaiting!: () => void
  const waiting = new Promise<void>((resolve) => { markWaiting = resolve })
  const port = createTaskApprovalPort({
    awaitConfirmation: async () => { throw new Error('decision channel required') },
    awaitConfirmationDecision: async () => {
      markWaiting()
      return new Promise<ApprovalDecision>((resolve) => { decide = resolve })
    },
  }, tracker, { shouldAutoApprove: () => false })
  const approval = port.awaitConfirmationDecision('A', undefined, {
    operation: { key: 'operation-A', label: 'A' },
  })
  await waiting
  runner.clearTaskApprovals('task')
  decide({ approved: true, message: null })
  await expect(approval).rejects.toMatchObject({ code: 'EXECUTION_ABORTED' })
  expect(tracker.getTaskApprovalRecords()).toEqual([])
  await expect(port.awaitConfirmationDecision('B')).rejects.toMatchObject({ code: 'EXECUTION_ABORTED' })
})
