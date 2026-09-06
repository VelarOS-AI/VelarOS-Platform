import { describe, expect, test } from 'bun:test'

import { SubAgentGuidanceRelayRegistry } from '../src/execution'
import { SubAgentDispatcher } from '../src/kernel/dispatch/SubAgentDispatcher'
import { ExecutionEventBus } from '../src/kernel/execution/ExecutionEventBus'
import type { SubAgentTypeDescriptor } from '../src/sub-agent'
import { parseSubAgentToolResult } from '../src/sub-agent'
import { TeamModelRouter, WriteLeaseCoordinator } from '../src/team'
import { dispatchAgentSchema } from '../src/tool-library/builtin/DispatchAgent'
import { dispatchAgentTools } from '../src/tool-library/builtin/DispatchAgent.tool'

describe('agent dispatch input contract', () => {
  test('adds identity defaults only when creating a worker', async () => {
    const forwarded: unknown[] = []
    const context = {
      dispatchSubAgent: async (input: unknown) => {
        forwarded.push(input)
        return 'ok'
      },
    } as never

    const created = dispatchAgentSchema.parse({
      agent_name: 'Scout',
      prompt: 'Inspect the target module.',
    })
    expect(created).toMatchObject({
      subagent_type: 'general',
      tool_scope: 'type_default',
      tool_categories: [],
    })
    await dispatchAgentTools['agent:dispatch'].execute(created, context)
    expect(forwarded[0]).toMatchObject({
      agentName: 'Scout',
      prompt: 'Inspect the target module.',
      subagentType: 'general',
      toolScope: 'type_default',
      toolCategories: [],
    })

    const resumed = dispatchAgentSchema.parse({
      thread_id: 'subagent:explore-thread',
      prompt: 'Continue from the previous findings.',
    })
    expect(resumed.subagent_type).toBeUndefined()
    expect(resumed.tool_scope).toBeUndefined()
    expect(resumed.tool_categories).toBeUndefined()
    expect(dispatchAgentSchema.safeParse({
      thread_id: 'subagent:custom-thread',
      prompt: 'Continue.',
      tool_scope: 'custom',
    }).success).toBe(true)
    expect(dispatchAgentSchema.safeParse({
      thread_id: 'subagent:custom-thread',
      prompt: 'Continue.',
      tool_scope: 'custom',
      tool_categories: [],
    }).success).toBe(false)

    await dispatchAgentTools['agent:dispatch'].execute(resumed, context)
    expect(forwarded[1]).toMatchObject({
      threadId: 'subagent:explore-thread',
      prompt: 'Continue from the previous findings.',
    })
    expect((forwarded[1] as { subagentType?: string }).subagentType).toBeUndefined()
    expect((forwarded[1] as { toolScope?: string }).toolScope).toBeUndefined()
    expect((forwarded[1] as { toolCategories?: string[] }).toolCategories).toBeUndefined()
  })

  test('accepts thread_id plus interrupt without unrelated creation fields', async () => {
    const parsed = dispatchAgentSchema.parse({
      thread_id: 'subagent:running-thread',
      interrupt: true,
      prompt: 'This must not leak into the interrupt request.',
      agent_name: 'Ignored',
      readonly: true,
    })
    expect(parsed).toEqual({
      thread_id: 'subagent:running-thread',
      mode: 'sync',
      interrupt: true,
    })
    let forwarded: unknown
    await dispatchAgentTools['agent:dispatch'].execute(parsed, {
      dispatchSubAgent: async (input: unknown) => {
        forwarded = input
        return 'interrupted'
      },
    } as never)

    expect(forwarded).toMatchObject({
      threadId: 'subagent:running-thread',
      interrupt: true,
      prompt: '',
    })
    expect(dispatchAgentSchema.safeParse({ interrupt: true }).success).toBe(false)
    expect(dispatchAgentSchema.safeParse({ prompt: 'Create without a name.' }).success).toBe(false)
  })

  test('the dispatcher inherits the stored worker identity on an omitted resume override', async () => {
    const descriptors: SubAgentTypeDescriptor[] = ['general', 'explore'].map((id) => ({
      id,
      workerType: id,
      roleId: 'operator',
      routeCategory: id,
      workerPhase: 'implementation',
      toolCategories: id === 'explore' ? ['project-files'] : ['general'],
      toolNames: [],
      resourceLeaseScope: null,
      readonlyDefault: id === 'explore',
      promptAppend: null,
    }))
    const dispatcher = new SubAgentDispatcher(
      new TeamModelRouter({
        resolve: () => ({
          runtimeOverride: {
            provider: (() => undefined) as never,
            providerId: 'probe',
            model: 'probe',
          },
          trace: null,
        }),
      }),
      new WriteLeaseCoordinator(),
      {
        systemConfig: {
          thinkingDepth: 'balanced',
          disabledToolNames: [],
          prompt: { segmentOverrides: [] },
          advancedRuntime: {},
          modelRuntimeContext: { host: 'probe' },
        },
        chatConfig: { modelSelection: { hostModel: 'probe' }, systemPromptAppend: '' },
      },
      new SubAgentGuidanceRelayRegistry(),
      {
        defaultTypeId: 'general',
        getDescriptor: (id) => descriptors.find((descriptor) => descriptor.id === id) ?? null,
        listDescriptors: () => descriptors,
      }
    )
    const queryCalls: Array<{ task: string; toolCategories?: readonly string[] }> = []
    dispatcher.bindAgentRunner({
      query: async (task, _parentContext, options) => {
        queryCalls.push({ task, toolCategories: options.toolCategories })
        options.onHistoryUpdate?.([])
        return `worker result ${queryCalls.length}`
      },
    })
    const parentContext = {
      abortSignal: new AbortController().signal,
      sessionId: 'parent-session',
      codingSession: {
        getEnabledToolCategories: () => ['general'],
        enableToolCategories: (categories: string[]) => categories,
      },
      execution: null,
    } as never
    const config = {} as never

    const first = await dispatcher.dispatch({
      input: {
        agentName: 'Scout',
        subagentType: 'explore',
        toolScope: 'custom',
        toolCategories: ['project-files'],
        prompt: 'Inspect the project.',
      },
      parentCtx: parentContext,
      events: new ExecutionEventBus(),
      config,
    })
    const threadId = parseSubAgentToolResult(first)?.thread_id
    expect(threadId).toStartWith('subagent:')

    const resumed = await dispatcher.dispatch({
      input: {
        threadId: threadId!,
        prompt: 'Continue the inspection.',
      },
      parentCtx: parentContext,
      events: new ExecutionEventBus(),
      config,
    })

    expect(resumed).toContain('worker result 2')
    expect(resumed).not.toContain('不能续跑子智能体')
    expect(queryCalls).toHaveLength(2)
    expect(queryCalls[1]?.task).toContain('类型：explore')
    expect(queryCalls[1]?.toolCategories).toEqual(['project-files'])
    dispatcher.clearExecution('parent-session')
  })
})
