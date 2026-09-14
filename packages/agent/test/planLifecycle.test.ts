import { describe, expect, test } from 'bun:test'

import type {
  ActiveContextArtifact,
  ActiveContextUpsertInput,
  ChatPromptFeatureId,
  ExecutionModeId,
  ExecutionTaskPlanStep,
  ToolExecutionPlanUpdate,
} from '@velaros-ai/agent/protocol'

import { CodingSessionTracker } from '../src/agent/CodingSessionTracker'
import { PromptStateBuilder } from '../src/agent/PromptState'
import type { RuntimePromptSnapshot } from '../src/prompts'
import { plansTools } from '../src/tool-library/builtin/Plans.tool'

function createPlanToolContext(features: ChatPromptFeatureId[] = []) {
  const codingSession = new CodingSessionTracker([], features)
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
      codingSession,
    } as never,
    codingSession,
    readNextPrompt: async (executionModes: ExecutionModeId[] = []) => {
      let snapshot: RuntimePromptSnapshot | undefined
      const state = await new PromptStateBuilder().build({
        toolContext: {
          locale: 'zh-CN', codingSession, execution: interaction, listToolCategories: () => [],
          capabilityPorts: { promptContributors: [{
            id: 'plan-mode-probe', getSegments: (value) => { snapshot = value as RuntimePromptSnapshot; return [] },
          }] },
        },
        roleResolution: { id: 'assistant', label: 'Assistant', workflowType: 'chat', allowedTools: ['plan:update'] },
        messages: [{ role: 'user', content: 'Implement this change and test it.' }],
        preparedToolCategories: { enabled: [], all: [] }, executionModes,
      })
      return { snapshot: snapshot!, state }
    },
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


describe('internal plan maintenance respects user execution mode', () => {
  test('an authorized multi-step task keeps execution mode through plan creation, progress and completion', async () => {
    const harness = createPlanToolContext(['office'])
    expect((await harness.readNextPrompt()).snapshot.userRequestedPlan).toBe(false)
    await plansTools['plan:update'].execute({ plan: [
      { step: 'Implement the change', status: 'in_progress' },
      { step: 'Run verification', status: 'pending' },
    ] }, harness.context)
    const created = await harness.readNextPrompt()
    expect(created.state.facts.hasExecutionPlan).toBe(true)
    expect(created.snapshot.executionPlanPreview).toContain('Implement the change')
    expect(created.snapshot.userRequestedPlan).toBe(false)
    const progress = await plansTools['plan:update'].execute({ complete_step: 1 }, harness.context)
    expect(progress.steps[1]?.status).toBe('running')
    expect((await harness.readNextPrompt()).snapshot.userRequestedPlan).toBe(false)
    await plansTools['plan:update'].execute({ complete_step: 2 }, harness.context)
    expect(harness.readArtifact()?.status).toBe('completed')
    expect((await harness.readNextPrompt()).snapshot.userRequestedPlan).toBe(false)
    expect(harness.codingSession.getEnabledPromptFeatures()).toEqual(['office'])
  })

  test.each(['execution-modes', 'legacy-feature'] as const)('keeps explicit user plan mode via %s', async (selection) => {
    const harness = createPlanToolContext(selection === 'legacy-feature' ? ['plan'] : [])
    const modes: ExecutionModeId[] = selection === 'execution-modes' ? ['plan'] : []
    expect((await harness.readNextPrompt(modes)).snapshot.userRequestedPlan).toBe(true)
    await plansTools['plan:update'].execute({ plan: [{ step: 'Review the proposed solution', status: 'pending' }] }, harness.context)
    expect((await harness.readNextPrompt(modes)).snapshot.userRequestedPlan).toBe(true)
    await plansTools['plan:update'].execute({ explanation: 'Waiting for the requested review', lifecycle: 'paused' }, harness.context)
    expect((await harness.readNextPrompt(modes)).snapshot.userRequestedPlan).toBe(true)
    expect(harness.readArtifact()?.metadata?.planLifecycle).toBe('paused')
  })
})
