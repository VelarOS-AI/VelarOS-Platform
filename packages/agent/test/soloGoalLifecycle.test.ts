import { describe, expect, test } from 'bun:test'

import type {
  ActiveContextArtifact,
  ActiveContextUpsertInput,
} from '@velaros-ai/agent/protocol'

import { runSoloFinishingGate } from '../src/agent/SoloFinishingGate'
import { SoloGoalLifecycle } from '../src/agent/SoloGoalLifecycle'
import { ExecutionGuidanceQueue } from '../src/execution/GuidanceQueue'
import { buildGoalStateUpsertInput } from '../src/tool-library/builtin/Goals'

function createActiveContextHarness() {
  let artifact: ActiveContextArtifact | null = null
  let now = 1_000
  let writes = 0
  const activeContext = {
    listActiveContextArtifacts: async () => (artifact ? [artifact] : []),
    upsertActiveContextArtifact: async (
      input: ActiveContextUpsertInput
    ): Promise<ActiveContextArtifact> => {
      writes += 1
      now += 1
      artifact = {
        id: input.id ?? 'active-goal',
        kind: input.kind,
        scope: input.scope ?? 'session',
        status: input.status ?? 'active',
        sessionId: 'solo-goal-lifecycle-test',
        resourceId: input.resourceId,
        title: input.title,
        content: input.content,
        sourceMessageId: input.sourceMessageId,
        metadata: input.metadata,
        createdAt: artifact?.createdAt ?? now,
        updatedAt: now,
      }
      return artifact
    },
  }

  return {
    activeContext,
    readArtifact: () => artifact,
    readWrites: () => writes,
  }
}

describe('SoloGoalLifecycle explicit goal control plane', () => {
  test('creates the explicit goal and completes it only through an explicit completion call', async () => {
    const harness = createActiveContextHarness()
    const lifecycle = new SoloGoalLifecycle(harness.activeContext)

    const initial = await lifecycle.ensureExplicitGoal('读取真实文件并核验标记')
    expect(initial.status).toBe('active')
    expect(harness.readArtifact()?.content).toBe('读取真实文件并核验标记')

    expect(await lifecycle.recordSuccessfulCompletion()).toBe(true)
    expect((await lifecycle.inspect()).status).toBe('complete')
    expect(harness.readArtifact()?.status).toBe('completed')
    expect(harness.readWrites()).toBe(2)
  })

  test('preserves an already active goal instead of replacing its objective', async () => {
    const harness = createActiveContextHarness()
    const lifecycle = new SoloGoalLifecycle(harness.activeContext)

    await lifecycle.ensureExplicitGoal('原始目标')
    await lifecycle.ensureExplicitGoal('后续措辞')

    expect(harness.readArtifact()?.content).toBe('原始目标')
    expect(harness.readWrites()).toBe(1)
  })

  for (const status of ['pending', 'in_progress', 'failed'] as const) {
    test(`explicit completion preserves ${status} steps and rejects unresolved work`, async () => {
      const harness = createActiveContextHarness()
      const lifecycle = new SoloGoalLifecycle(harness.activeContext)
      await lifecycle.ensureExplicitGoal('真实完成每个交付项')
      await harness.activeContext.upsertActiveContextArtifact(buildGoalStateUpsertInput({
        artifact: harness.readArtifact()!, steps: [{ step: '交付文件', status }],
      }))
      const before = harness.readWrites()
      await expect(lifecycle.recordSuccessfulCompletion()).rejects.toThrow('unresolved goal steps')
      expect(harness.readWrites()).toBe(before)
      expect(harness.readArtifact()?.metadata?.steps).toEqual([{ step: '交付文件', status }])
      expect((await lifecycle.inspect()).status).toBe('active')
    })
  }

  test('failed goal steps keep the actual finishing lane open without writing completion', async () => {
    const harness = createActiveContextHarness()
    const lifecycle = new SoloGoalLifecycle(harness.activeContext)
    await lifecycle.ensureExplicitGoal('修复并验证功能')
    const goal = harness.readArtifact()!
    await harness.activeContext.upsertActiveContextArtifact(buildGoalStateUpsertInput({
      artifact: goal,
      steps: [{ step: '验证功能', status: 'failed' }],
    }))
    const writesBeforeInspection = harness.readWrites()
    expect(harness.readWrites()).toBe(writesBeforeInspection)

    const queue = new ExecutionGuidanceQueue()
    const runtimeInput = queue.port('failed-goal-guidance')
    const result = await runSoloFinishingGate({
      turn: 1, history: [], toolContext: {}, goalMode: true,
      events: { emitRuntime: () => undefined },
      abortSignal: new AbortController().signal,
      emitAbort: () => undefined,
      tickLoopReminders: async () => [],
      runAutomaticVerification: async () => ({}) as never,
      runtimeInput,
      inspectGoalState: () => lifecycle.inspect(),
      recordGoalCompletionAttempt: () => lifecycle.recordCompletionAttempt(),
      log: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    })

    expect(result).toEqual({ status: 'continue', reason: 'goal-status-required' })
    expect((await lifecycle.inspect()).status).toBe('active')
    expect(harness.readArtifact()?.metadata?.steps).toEqual([{ step: '验证功能', status: 'failed' }])
    const guidance = { role: 'user' as const, content: '先排查失败原因' }
    expect(queue.enqueue('failed-goal-guidance', guidance)).toEqual({ status: 'accepted' })
    expect(runtimeInput.take()).toEqual(guidance)
  })
})
