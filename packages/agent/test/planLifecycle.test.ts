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
    beginExecution: (executionId: string) => {
      interaction.executionId = executionId
      plan = []
    },
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

  test('keeps paused and archived lifecycle whenever lifecycle is omitted', async () => {
    const harness = createPlanToolContext()

    await plansTools['plan:update'].execute(
      { plan: [{ step: '检查生命周期', status: 'in_progress' }] },
      harness.context
    )
    await plansTools['plan:update'].execute({ lifecycle: 'paused' }, harness.context)

    const paused = await plansTools['plan:update'].execute(
      { explanation: '等待外部条件' },
      harness.context
    )
    expect(paused.activeContextStatus).toBe('paused')
    expect(harness.readArtifact()?.metadata?.planLifecycle).toBe('paused')

    const maintained = await plansTools['plan:update'].execute(
      { plan: [{ step: '检查生命周期', status: 'in_progress', objective: '继续核对' }] },
      harness.context
    )
    expect(maintained.activeContextStatus).toBe('paused')

    const resolvedWhilePaused = await plansTools['plan:update'].execute(
      { complete_step: 1 },
      harness.context
    )
    expect(resolvedWhilePaused.allStepsResolved).toBe(true)
    expect(resolvedWhilePaused.activeContextStatus).toBe('paused')

    await plansTools['plan:update'].execute({ lifecycle: 'archived' }, harness.context)
    const archived = await plansTools['plan:update'].execute(
      { explanation: '用户已更换方案' },
      harness.context
    )
    expect(archived.activeContextStatus).toBe('archived')
    expect(harness.readArtifact()?.status).toBe('archived')
    expect(harness.readArtifact()?.metadata?.planLifecycle).toBe('archived')
  })

  test('automatically completes an active plan when all steps become terminal', async () => {
    const harness = createPlanToolContext()

    await plansTools['plan:update'].execute(
      { plan: [{ step: '完成验证', status: 'in_progress' }] },
      harness.context
    )
    const completed = await plansTools['plan:update'].execute(
      { complete_step: 1 },
      harness.context
    )

    expect(completed.allStepsResolved).toBe(true)
    expect(completed.activeContextStatus).toBe('completed')
    expect(harness.readArtifact()?.metadata?.planLifecycle).toBe('completed')
  })

  test('does not inherit a completed artifact from a previous execution', async () => {
    const harness = createPlanToolContext()

    await plansTools['plan:update'].execute(
      {
        lifecycle: 'completed',
        plan: [{ step: '旧执行已完成', status: 'completed' }],
      },
      harness.context
    )
    expect(harness.readArtifact()?.metadata?.executionId).toBe('plan-lifecycle-execution')

    harness.beginExecution('next-execution')
    const beforeCreate = await plansTools['plan:get'].execute({}, harness.context)
    expect(beforeCreate.lifecycle).toBe('active')

    const created = await plansTools['plan:update'].execute(
      { plan: [{ step: '新执行正在进行', status: 'in_progress' }] },
      harness.context
    )

    expect(created.isInitialPlan).toBe(true)
    expect(created.activeContextStatus).toBe('active')
    expect(harness.readArtifact()?.metadata?.executionId).toBe('next-execution')
    expect(harness.readArtifact()?.metadata?.planLifecycle).toBe('active')
  })
})
