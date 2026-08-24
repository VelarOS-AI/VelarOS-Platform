import { describe, expect, test } from 'bun:test'

import type {
  ActiveContextArtifact,
  ActiveContextUpsertInput,
  ExecutionTaskPlanStep,
  ToolExecutionPlanUpdate,
} from '@velaros-ai/agent/protocol'

import { plansTools } from '../src/tool-library/builtin/Plans.tool'

function createPlanToolContext() {
  let artifact: ActiveContextArtifact | null = null
  let plan: ExecutionTaskPlanStep[] = []
  let now = 1_000

  const activeContext = {
    listActiveContextArtifacts: async () => (artifact ? [artifact] : []),
    upsertActiveContextArtifact: async (
      input: ActiveContextUpsertInput
    ): Promise<ActiveContextArtifact> => {
      now += 1
      artifact = {
        id: input.id ?? 'active-plan',
        kind: input.kind,
        scope: input.scope ?? 'session',
        status: input.status ?? 'active',
        sessionId: 'plan-lifecycle-test',
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
  const interaction = {
    executionId: 'plan-lifecycle-execution',
    getCurrentPlan: () => plan,
    updateCurrentPlan: (input: ToolExecutionPlanUpdate) => {
      plan = input.plan.map((step, index) => ({
        id: step.id ?? `plan-step-${index + 1}`,
        title: step.step,
        roleId: 'chat',
        objective: step.objective ?? step.step,
        kind: 'implement',
        mode: 'self',
        required: true,
        dependsOn: [],
        actionable: true,
        status: step.status === 'in_progress' ? 'running' : step.status,
        taskId: null,
        updatedAt: now,
        origin: 'manual',
      }))
      return plan
    },
    getCurrentTask: () => null,
    getCurrentRecommendedAction: () => null,
    getCurrentExecutionAdvice: () => null,
  }

  return {
    context: {
      abortSignal: new AbortController().signal,
      activeContext,
      interaction,
      codingSession: { enablePromptFeatures: () => undefined },
    } as never,
    readArtifact: () => artifact,
  }
}

describe('plan lifecycle tools', () => {
  test('lets the model create, pause, resume, complete, and read a plan lifecycle', async () => {
    const harness = createPlanToolContext()

    const created = await plansTools['plan:update'].execute(
      {
        plan: [
          { step: '实现生命周期', status: 'in_progress' },
          { step: '验证行为', status: 'pending' },
        ],
      },
      harness.context
    )
    expect(created.activeContextStatus).toBe('active')

    const paused = await plansTools['plan:update'].execute(
      { lifecycle: 'paused' },
      harness.context
    )
    expect(paused.activeContextStatus).toBe('paused')
    expect(harness.readArtifact()?.status).toBe('active')
    expect(harness.readArtifact()?.metadata?.planLifecycle).toBe('paused')

    const readPaused = await plansTools['plan:get'].execute({}, harness.context)
    expect(readPaused.lifecycle).toBe('paused')

    const resumed = await plansTools['plan:update'].execute(
      { lifecycle: 'active' },
      harness.context
    )
    expect(resumed.activeContextStatus).toBe('active')

    const completed = await plansTools['plan:update'].execute(
      {
        lifecycle: 'completed',
        plan: [
          { step: '实现生命周期', status: 'completed' },
          { step: '验证行为', status: 'completed' },
        ],
      },
      harness.context
    )
    expect(completed.activeContextStatus).toBe('completed')
    expect(harness.readArtifact()?.status).toBe('completed')
    expect(harness.readArtifact()?.metadata?.planLifecycle).toBe('completed')
  })
})
