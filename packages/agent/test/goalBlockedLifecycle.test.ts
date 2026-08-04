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

  const activeContext = {
    listActiveContextArtifacts: async () => (artifact ? [artifact] : []),
    upsertActiveContextArtifact: async (
      input: ActiveContextUpsertInput
    ): Promise<ActiveContextArtifact> => {
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
  }
}

describe('goal blocked lifecycle', () => {
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

  test('teaches the model that it may mark a genuinely blocked goal itself', () => {
    const segment = createTaskRuntimePromptSegments({
      goalMode: true,
      proposalMode: false,
      executionPlanPreview: null,
    } as never).find((candidate) => candidate.id === 'runtime.goal-mode')
    const prompt = segment?.render({})

    expect(prompt).toContain('可以自行调用 goal:update({status:"blocked"})')
    expect(prompt).toContain('不需要等待多轮审计')
  })
})
