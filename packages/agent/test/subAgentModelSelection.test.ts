import { describe, expect, test } from 'bun:test'

import { SubAgentGuidanceRelayRegistry } from '../src/execution'
import { SubAgentDispatcher } from '../src/kernel/dispatch/SubAgentDispatcher'
import { ExecutionEventBus } from '../src/kernel/execution/ExecutionEventBus'
import type { SubAgentTypeDescriptor } from '../src/sub-agent'
import { parseSubAgentToolResult } from '../src/sub-agent'
import { TeamModelRouter, type TeamSelectableModel, WriteLeaseCoordinator } from '../src/team'

const MainModelSelection = { provider: 'velar-dev', model: 'velar-dev/gpt-5.6-sol' }
const SelectableModels: TeamSelectableModel[] = [
  { id: 'velar-dev/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'velar-dev/gpt-5.6-mini', label: 'GPT-5.6 Mini' },
]

function createDispatcher(options: { selectable?: TeamSelectableModel[] | null } = {}) {
  const descriptor: SubAgentTypeDescriptor = {
    id: 'explore',
    workerType: 'scout',
    roleId: 'operator',
    routeCategory: 'scout',
    workerPhase: 'researching',
    toolCategories: ['project-files'],
    toolNames: [],
    resourceLeaseScope: null,
    readonlyDefault: true,
    promptAppend: null,
  }
  const routedSelections: unknown[] = []
  const queriedModels: string[] = []
  const dispatcher = new SubAgentDispatcher(
    new TeamModelRouter({
      resolve: ({ selection }) => {
        routedSelections.push(selection)
        const record = selection as { provider: string; model: string }
        return {
          runtimeOverride: {
            provider: (() => undefined) as never,
            providerId: record.provider,
            model: record.model,
          },
          trace: null,
        }
      },
      ...(options.selectable === undefined
        ? { listSelectableModels: () => SelectableModels }
        : { listSelectableModels: () => options.selectable ?? null }),
    }),
    new WriteLeaseCoordinator(),
    {
      systemConfig: {
        thinkingDepth: 'balanced',
        disabledToolNames: [],
        prompt: { segmentOverrides: [] },
        advancedRuntime: {},
        modelRuntimeContext: {},
      },
      chatConfig: {
        modelSelection: { provider: 'stale-default', model: 'stale' },
        systemPromptAppend: '',
      },
    },
    new SubAgentGuidanceRelayRegistry(),
    {
      defaultTypeId: 'explore',
      getDescriptor: (id) => (id === 'explore' ? descriptor : null),
      listDescriptors: () => [descriptor],
    }
  )
  dispatcher.bindAgentRunner({
    query: async (_task, _parentContext, runOptions) => {
      queriedModels.push(runOptions.runtimeOverride?.model ?? '')
      return 'worker done'
    },
  })
  const parentCtx = {
    abortSignal: new AbortController().signal,
    sessionId: 'parent-session',
    codingSession: {
      getEnabledToolCategories: () => ['project-files'],
      enableToolCategories: (categories: string[]) => categories,
    },
    execution: null,
  } as never
  const dispatch = (model?: string) =>
    dispatcher.dispatch({
      input: {
        agentName: 'Scout',
        subagentType: 'explore',
        toolScope: 'type_default',
        prompt: 'Inspect the project.',
        ...(model ? { model } : {}),
      },
      parentCtx,
      events: new ExecutionEventBus(),
      config: { modelSelection: MainModelSelection } as never,
    })
  return { dispatch, routedSelections, queriedModels }
}

describe('sub-agent model selection', () => {
  test('routes with the main model selection itself and inherits it by default', async () => {
    const harness = createDispatcher()
    const result = parseSubAgentToolResult(await harness.dispatch())

    // 路由端口拿到的是主模型的模型选择，而不是整份 chatConfig，也不是全局默认配置。
    expect(harness.routedSelections).toEqual([MainModelSelection])
    expect(harness.queriedModels).toEqual(['velar-dev/gpt-5.6-sol'])
    expect(result?.model_trace?.reason).toBe('inherited-main-model')
    expect(result?.model_trace?.metadata?.selectableModels).toEqual(
      SelectableModels.map((m) => m.id)
    )
  })

  test('uses a requested model from the same provider, matched by label', async () => {
    const harness = createDispatcher()
    const result = parseSubAgentToolResult(await harness.dispatch('gpt-5.6 mini'))

    expect(harness.queriedModels).toEqual(['velar-dev/gpt-5.6-mini'])
    expect(result?.model_trace?.reason).toBe('requested-model')
  })

  test('falls back to the main model when the requested model is not selectable', async () => {
    const harness = createDispatcher()
    const text = await harness.dispatch('claude-opus-5')
    const result = parseSubAgentToolResult(text)

    expect(harness.queriedModels).toEqual(['velar-dev/gpt-5.6-sol'])
    expect(result?.model_trace?.reason).toBe('requested-model-unavailable')
    expect(result?.model_trace?.metadata?.requestedModel).toBe('claude-opus-5')
    expect(text).toContain('本次沿用主模型「velar-dev/gpt-5.6-sol」')
  })

  test('passes the requested model through when the host publishes no catalog', async () => {
    const harness = createDispatcher({ selectable: null })
    const result = parseSubAgentToolResult(await harness.dispatch('any-custom-model'))

    expect(harness.queriedModels).toEqual(['any-custom-model'])
    expect(result?.model_trace?.reason).toBe('requested-model')
  })
})
