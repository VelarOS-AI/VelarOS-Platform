import { describe, expect, test } from 'bun:test'

import { CodingSessionTracker } from '../src/agent/CodingSessionTracker'
import { ContextBuilder } from '../src/agent/ContextBuilder'
import { PrimaryAgentProfile } from '../src/agent/PrimaryAgentProfile'
import type { RunContextToolContext } from '../src/agent/run-context/host-ports'
import { RunContext } from '../src/agent/run-context/RunContext'
import type { CustomSubAgentRegistry } from '../src/kernel/dispatch/host-ports'
import { SubAgentDispatcher } from '../src/kernel/dispatch/SubAgentDispatcher'
import { createBuiltInPromptRegistry } from '../src/prompts'
import type { CustomSubAgentDefinition, ExecutionModeId, ToolCategoryOverview } from '../src/protocol'
import type { SubAgentTypeDescriptor, SubAgentTypeProvider } from '../src/sub-agent'
import { agentWorkflowSchema } from '../src/tool-library/builtin/AgentWorkflow'
import { defaultRuntimePromptFeaturePolicy } from '../src/tools/prompt-feature-policy'

function descriptor(id: string, readonlyDefault = true): SubAgentTypeDescriptor {
  return {
    id, description: readonlyDefault ? '阅读并核验证据。' : '完成授权范围内的改动。',
    workerType: 'scout', roleId: 'operator', routeCategory: 'scout', workerPhase: 'researching',
    toolCategories: ['project-files'], toolNames: [], resourceLeaseScope: null,
    readonlyDefault, promptAppend: null,
  }
}

function createDispatcher(provider: SubAgentTypeProvider, custom?: CustomSubAgentRegistry) {
  return new SubAgentDispatcher(
    undefined as never, undefined as never, {} as never, undefined as never, provider,
    undefined, undefined, custom
  )
}

function customDefinition(id: string, base: string): CustomSubAgentDefinition {
  return {
    id, base, name: id, description: '检查已提供的安全证据。', toolCategories: null, model: null,
    effort: null, readonly: true, promptMarkdown: '', filePath: `${id}.md`, updatedAt: 1,
  }
}

describe('当前派发类型目录与执行解析共用同一供应方', () => {
  test('按实际解析优先级显示动态内置和自定义类型，不发布无效 base', () => {
    const descriptors = new Map([['inspect_only', descriptor('inspect_only')], ['repair_files', descriptor('repair_files', false)]])
    const provider: SubAgentTypeProvider = {
      defaultTypeId: 'inspect_only',
      listDescriptors: () => [...descriptors.values()],
      getDescriptor: (id) => descriptors.get(id) ?? null,
    }
    const customs = new Map([
      ['repair_files', customDefinition('repair_files', 'inspect_only')],
      ['security_scan', customDefinition('security_scan', 'inspect_only')],
      ['missing_base', customDefinition('missing_base', 'unavailable')],
    ])
    const dispatcher = createDispatcher(provider, {
      get: (id) => customs.get(id) ?? null,
      listDescriptors: () => [...customs.values()],
    })
    const first = dispatcher.describeDispatchCatalog()
    expect(first.defaultTypeId).toBe('inspect_only')
    expect(first.types.map(({ id }) => id)).toEqual(['inspect_only', 'repair_files', 'security_scan'])
    expect(first.types.find(({ id }) => id === 'repair_files')?.readonlyDefault).toBe(false)
    expect(first.types.find(({ id }) => id === 'security_scan')?.readonlyDefault).toBe(true)
    customs.delete('security_scan')
    descriptors.delete('repair_files')
    customs.delete('repair_files')
    expect(dispatcher.describeDispatchCatalog().types.map(({ id }) => id)).toEqual(['inspect_only'])
    expect(first.types).toHaveLength(3)
  })

  test('实际 RunContext 在首次与后续请求中展示当前 id/default，隐藏工具时不调用目录', async () => {
    const types = [descriptor('inspect_only'), descriptor('repair_files', false)]
    const dispatcher = createDispatcher({
      defaultTypeId: 'inspect_only', listDescriptors: () => types,
      getDescriptor: (id) => types.find((type) => type.id === id) ?? null,
    })
    const run = new RunContext(new ContextBuilder(createBuiltInPromptRegistry()), defaultRuntimePromptFeaturePolicy)
    const profile = new PrimaryAgentProfile(
      { getSkillMarkdownForRole: () => '', listSkillsForRole: () => [] },
      { getToolCategoryId: () => 'agent-control' }
    )
    for (const tool of ['agent:dispatch', 'agent:run_workflow']) {
      const category: ToolCategoryOverview = {
        category: { id: 'agent-control', label: 'Agent', description: '委派工具', toolOs: { domain: 'agent', defaultState: 'resident' } },
        enabled: true,
        tools: [{ name: tool, categoryId: 'agent-control', description: '委派', role: 'control', permissions: [], systemEnabled: true }],
      }
      let reads = 0
      const hostContext: RunContextToolContext = {
        locale: 'zh-CN', sessionId: 'catalog-probe',
        codingSession: new CodingSessionTracker(['agent-control'], []),
        interaction: { getCurrentPlan: () => [], getCurrentExecutionAdvice: () => null },
        listTools: () => category.tools, listToolCategories: () => [category],
        dispatchSubAgent: async () => 'unused',
        getSubAgentDispatchCatalog() {
          expect(this.sessionId).toBe('catalog-probe')
          reads += 1
          return dispatcher.describeDispatchCatalog()
        },
      }
      const inheritedContext = Object.freeze(Object.create(hostContext)) as RunContextToolContext
      for (const contextPhase of ['bootstrap', 'operational'] as const) {
        for (const executionModes of [[], ['plan'], ['goal'], ['plan', 'goal']] satisfies ExecutionModeId[][]) {
          const built = await run.buildPrimaryAgentSystemPrompt({
            chatConfig: { systemPromptAppend: '' },
            systemConfig: { thinkingDepth: 'balanced', disabledToolNames: [], prompt: { segmentOverrides: [] }, advancedRuntime: {} },
            toolContext: inheritedContext, messages: [], contextPhase, executionModes,
            roleResolution: profile.resolve({ knownToolNames: [tool], allowSubAgents: true }),
          })
          expect(built.systemPrompt).toContain('"inspect_only"：默认只读')
          expect(built.systemPrompt).toContain('"repair_files"：按授权工具执行')
          expect(built.systemPrompt).toContain('新建省略时使用 "inspect_only"')
          expect(built.systemPrompt).not.toContain('"general"')
          expect(built.systemPrompt).not.toContain('project-changes')
        }
      }
      expect(reads).toBe(8)
      const hidden = await run.buildPrimaryAgentSystemPrompt({
        chatConfig: { systemPromptAppend: '' },
        systemConfig: { thinkingDepth: 'balanced', disabledToolNames: [], prompt: { segmentOverrides: [] }, advancedRuntime: {} },
        toolContext: inheritedContext, messages: [], contextPhase: 'operational',
        roleResolution: profile.resolve({ knownToolNames: [], allowSubAgents: false }),
      })
      expect(reads).toBe(8)
      expect(hidden.systemPrompt).not.toContain('本轮可用 subagent_type')
      expect(hidden.systemPrompt).not.toContain('"inspect_only"')
    }
  })

  test('工作流 schema 省略类型时也交给宿主默认值', () => {
    const parsed = agentWorkflowSchema.parse({
      name: '核验', steps: [{ id: 'review', operation: 'parallel', calls: [{
        id: 'reviewer', prompt: 'Independently review the supplied evidence without changing files.',
        output_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      }] }],
    })
    expect(parsed.steps[0]).toMatchObject({ calls: [{ id: 'reviewer', readonly: true }] })
    expect(JSON.stringify(parsed)).not.toContain('subagent_type')
  })
})
