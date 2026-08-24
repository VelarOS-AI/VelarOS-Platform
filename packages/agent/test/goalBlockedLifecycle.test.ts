import { describe, expect, test } from 'bun:test'

import type {
  ActiveContextArtifact,
  ActiveContextUpsertInput,
} from '@velaros-ai/agent/protocol'

import { createTaskRuntimePromptSegments } from '../src/prompts/segments/task'
import { goalTools } from '../src/tool-library/builtin/Goals.tool'

function createGoalToolContext() {
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
        sessionId: 'goal-blocked-test',
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
    context: {
      abortSignal: new AbortController().signal,
      activeContext,
    } as never,
    readArtifact: () => artifact,
    readWrites: () => writes,
  }
}

describe('goal blocked lifecycle', () => {
  test('treats a repeated create as an idempotent read without replacing the active goal', async () => {
    const harness = createGoalToolContext()

    await goalTools['goal:create'].execute(
      { objective: '完成完整项目交付' },
      harness.context
    )
    const repeated = await goalTools['goal:create'].execute(
      { objective: '模型重复创建的另一个目标' },
      harness.context
    )

    expect(repeated.status).toBe('active')
    expect(repeated.reused).toBe(true)
    expect(repeated.goal.objective).toBe('完成完整项目交付')
    expect(harness.readArtifact()?.content).toBe('完成完整项目交付')
    expect(harness.readWrites()).toBe(1)
  })

  test('allows the model to mark a fresh active goal blocked without a multi-turn audit', async () => {
    const harness = createGoalToolContext()

    const created = await goalTools['goal:create'].execute(
      { objective: '等待必要的外部授权后继续发布' },
      harness.context
    )
    expect(created.status).toBe('active')
    expect(created.goal.blockedAuditTurns).toBe(1)

    const blocked = await goalTools['goal:update'].execute(
      { status: 'blocked' },
      harness.context
    )

    expect(blocked.status).toBe('blocked')
    expect(blocked.goal.status).toBe('blocked')
    expect(harness.readArtifact()?.status).toBe('completed')
    expect(harness.readArtifact()?.metadata?.goalStatus).toBe('blocked')
  })

  test('lets the model pause, resume, and cancel its own goal without deleting the record', async () => {
    const harness = createGoalToolContext()

    await goalTools['goal:create'].execute(
      {
        objective: '完成跨轮次发布准备',
        steps: [{ step: '等待发布窗口', status: 'in_progress' }],
      },
      harness.context
    )

    const paused = await goalTools['goal:update'].execute(
      { status: 'paused' },
      harness.context
    )
    expect(paused.status).toBe('paused')
    expect(harness.readArtifact()?.status).toBe('active')
    expect(harness.readArtifact()?.metadata?.pausedAt).toBeNumber()

    const resumed = await goalTools['goal:update'].execute(
      { status: 'active' },
      harness.context
    )
    expect(resumed.status).toBe('active')
    expect(harness.readArtifact()?.metadata?.pausedAt).toBeNull()
    expect(harness.readArtifact()?.metadata?.resumedAt).toBeNumber()

    const cancelled = await goalTools['goal:update'].execute(
      { status: 'cancelled' },
      harness.context
    )
    expect(cancelled.status).toBe('cancelled')
    expect(harness.readArtifact()?.status).toBe('completed')
    expect(harness.readArtifact()?.metadata?.cancelledAt).toBeNumber()
  })

  test('keeps blocked transition details in the goal tool contract instead of duplicating them in the prompt', () => {
    const segment = createTaskRuntimePromptSegments({
      goalMode: true,
      executionPlanPreview: null,
    } as never).find((candidate) => candidate.id === 'runtime.goal-mode')
    const prompt = segment?.render({})

    expect(prompt).toContain('按 goal 工具契约更新状态')
    expect(prompt).not.toContain('不需要等待多轮审计')
    expect(goalTools['goal:update'].description).toContain('可以自行调用')
    expect(goalTools['goal:update'].description).toContain('不需要等待多轮审计')
  })
})
