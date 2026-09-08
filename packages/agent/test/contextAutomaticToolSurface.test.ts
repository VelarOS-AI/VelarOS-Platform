import { describe, expect, test } from 'bun:test'

import { createBuiltinAgentModPackage } from '../src/mods/BuiltinAgentMod'
import { createRuntimePromptSegments, type RuntimePromptSnapshot } from '../src/prompts'
import { contextDistillTools } from '../src/tool-library/builtin/ContextDistill.tool'
import { contextHandoffTools } from '../src/tool-library/builtin/ContextHandoff.tool'
import type { KernelToolContext } from '../src/tool-library/KernelToolContext'

function buildContextPrompt(): string {
  const toolNames = ['context:distill', 'context:recall', 'context:handoff']
  const snapshot: RuntimePromptSnapshot = {
    locale: 'zh-CN',
    roleId: 'chat',
    roleLabel: 'Chat',
    workflowType: 'chat',
    thinkingDepth: 'balanced',
    developerContext: null,
    agentSurfaceId: 'chat',
    contextPhase: 'operational',
    activeCapabilityScope: 'system',
    toolCategories: ['context'],
    toolSurfaceProfile: 'full',
    runProfile: 'balanced',
    toolCapabilityCategories: [
      {
        id: 'context',
        label: 'Context',
        description: 'Session context',
        enabled: true,
        toolOsDefaultState: 'resident',
        tools: toolNames.map((name) => ({ name, description: name })),
        hiddenToolCount: 0,
      },
    ],
    requestableToolCapabilityCategories: [],
    canUpdatePlan: false,
    userRequestedPlan: false,
    goalMode: false,
    selectedPromptFeatureLabels: [],
    enabledPromptFeatures: [],
    autoPromptFeatureLabels: [],
    availableSkills: [],
    customSubAgents: [],
    executionPlanPreview: null,
    currentExecutionAdvice: null,
    recentToolFailures: [],
    hasCompactedContext: false,
  }
  return createRuntimePromptSegments(snapshot)
    .map((segment) => segment.render({}))
    .join('\n')
}

/** The compatibility tool may only check cancellation; any host mutation fails the test. */
function createLegacyContext(abortSignal = new AbortController().signal): KernelToolContext {
  return new Proxy(
    { abortSignal },
    {
      get(target, property) {
        if (property === 'abortSignal') return target.abortSignal
        throw new Error(`Unexpected host access: ${String(property)}`)
      },
    }
  ) as KernelToolContext
}

describe('automatic context management tool surface', () => {
  test('default manifest and bindings expose recall and task state without manual compression', () => {
    const builtin = createBuiltinAgentModPackage()
    const names = builtin.manifest.contributes.tools?.map((tool) => tool.name) ?? []

    expect(names).not.toContain('context:distill')
    expect(builtin.bindings.tools).not.toHaveProperty('context:distill')
    for (const name of ['context:recall', 'context:handoff', 'goal:update', 'directive:upsert']) {
      expect(names).toContain(name)
      expect(builtin.bindings.tools).toHaveProperty(name)
    }
  })

  test('runtime and handoff prompts keep compression owned by the system for legacy hosts too', () => {
    const prompt = buildContextPrompt()

    expect(prompt).not.toContain('context:distill')
    expect(prompt).toContain('完整请求超出模型可用容量时')
    expect(prompt).toContain('context:recall')
    expect(contextHandoffTools['context:handoff'].description).not.toContain('context:distill')
    expect(contextHandoffTools['context:handoff'].description).toContain('自动整理')
  })

  test('the legacy export preserves facts without claiming or requesting compression', async () => {
    const result = await contextDistillTools['context:distill'].execute(
      {
        facts: ['The parser requires inputId.'],
        note: 'Validation is complete.',
      },
      createLegacyContext()
    )

    expect(result).toMatchObject({
      distilled: true,
      epochRequested: false,
      compactionStatus: 'automatic',
      facts: ['The parser requires inputId.'],
      note: 'Validation is complete.',
    })
    expect(result.effect).not.toMatch(/排队|下一个轮边界/u)
  })

  test('the legacy facts adapter observes cancellation', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))

    await expect(
      contextDistillTools['context:distill'].execute(
        { facts: ['fact'] },
        createLegacyContext(controller.signal)
      )
    ).rejects.toThrow('cancelled')
  })
})
