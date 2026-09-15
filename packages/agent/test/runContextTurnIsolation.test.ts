import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { AgentModSeamDispatcher } from '../src/impl/mods/AgentModSeamDispatcher'
import { ContextBuilder } from '../src/impl/runner/ContextBuilder'
import { PrimaryAgentProfile } from '../src/impl/runner/PrimaryAgentProfile'
import { RunContext } from '../src/impl/runner/RunContext'
import { CodingSessionTracker } from '../src/impl/session/CodingSessionTracker'
import { defaultRuntimePromptFeaturePolicy } from '../src/impl/tools/DefaultPromptFeaturePolicy'
import type { RunContextToolContext } from '../src/types/run-context-host-ports'
import type { AgentSystemRuntimeConfig } from '../src/types/runtime-configuration'
import { createBuiltInPromptRegistry } from '../src/utils/guidance/catalog'
import { createTextPromptSegment } from '../src/utils/guidance/shared'

const systemConfig: AgentSystemRuntimeConfig = {
  thinkingDepth: 'balanced', disabledToolNames: [],
  prompt: { segmentOverrides: [] }, advancedRuntime: {},
}
const chatConfig = { systemPromptAppend: '' }
const roleResolution = new PrimaryAgentProfile(
  { getSkillMarkdownForRole: () => '', listSkillsForRole: () => [] },
  { getToolCategoryId: () => 'probe' }
).resolve({ knownToolNames: [], allowSubAgents: false })

function createContext(readCurrentContribution: () => string): RunContextToolContext {
  return {
    locale: 'zh-CN',
    codingSession: new CodingSessionTracker([], []),
    interaction: { getCurrentPlan: () => [], getCurrentExecutionAdvice: () => null },
    listTools: () => [], listToolCategories: () => [],
    capabilityPorts: {
      promptContributors: [{
        id: 'runtime-probe', priority: 1,
        getSegments: () => {
          const text = readCurrentContribution()
          return text ? [createTextPromptSegment({
            id: `runtime.probe-${text}`, source: 'runtime', priority: 1_001, text,
          })] : []
        },
      }],
    },
  }
}

function createRun() {
  const seams = new AgentModSeamDispatcher()
  seams.register({
    modId: 'installed', id: 'append', event: 'turn-context:assemble',
    handler: () => ({ append: [{ id: 'configured-seam', text: '已安装接缝说明' }] }),
  })
  const builder = new ContextBuilder(createBuiltInPromptRegistry(), seams)
    .registerPromptSegment(createTextPromptSegment({
      id: 'host.permanent', source: 'host', priority: 1_002, text: '宿主固定配置',
    }))
  return { builder, run: new RunContext(builder, defaultRuntimePromptFeaturePolicy) }
}

void test('同一运行上下文下一轮不再注入已撤回的能力贡献与角色指导', async () => {
  const { builder, run } = createRun()
  let contribution = '当前浏览器处于页面 A'
  const toolContext = createContext(() => contribution)
  const first = await run.buildPrimaryAgentSystemPrompt({
    chatConfig, systemConfig, toolContext, messages: [], contextPhase: 'operational',
    roleResolution: { ...roleResolution, skillMarkdown: '当前角色专用指导' },
  })
  assert.ok(first.systemPrompt.includes(contribution))
  assert.ok(first.systemPrompt.includes('当前角色专用指导'))
  contribution = ''
  const next = await run.buildPrimaryAgentSystemPrompt({
    chatConfig, systemConfig, toolContext, messages: [], roleResolution, contextPhase: 'bootstrap',
  })
  assert.ok(!next.systemPrompt.includes('当前浏览器处于页面 A'))
  assert.ok(!next.systemPrompt.includes('当前角色专用指导'))
  assert.ok(next.systemPrompt.includes('宿主固定配置'))
  assert.ok(next.systemPrompt.includes('已安装接缝说明'))
  assert.ok(!builder.build().systemPrompt.includes('当前浏览器处于页面 A'))
})

void test('同一宿主并发装配的两份动态贡献互不混入，也不污染后续空贡献轮', async () => {
  const { run } = createRun()
  const [left, right] = await Promise.all(['任务甲的有效事实', '任务乙的有效事实'].map(async (text) => run.buildPrimaryAgentSystemPrompt({
    chatConfig, systemConfig, toolContext: createContext(() => text), messages: [], roleResolution, contextPhase: 'operational',
  })))
  assert.ok(left!.systemPrompt.includes('任务甲的有效事实'))
  assert.ok(!left!.systemPrompt.includes('任务乙的有效事实'))
  assert.ok(right!.systemPrompt.includes('任务乙的有效事实'))
  assert.ok(!right!.systemPrompt.includes('任务甲的有效事实'))
  const next = await run.buildPrimaryAgentSystemPrompt({
    chatConfig, systemConfig, toolContext: createContext(() => ''), messages: [], roleResolution, contextPhase: 'operational',
  })
  assert.ok(!next.systemPrompt.includes('任务甲的有效事实'))
  assert.ok(!next.systemPrompt.includes('任务乙的有效事实'))
})
