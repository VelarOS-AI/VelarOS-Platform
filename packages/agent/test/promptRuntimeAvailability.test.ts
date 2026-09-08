import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import { ContextBuilder } from '../src/agent/ContextBuilder'
import { createInternalFollowUpMessage } from '../src/agent/history/internalMessages'
import { PrimaryAgentProfile } from '../src/agent/PrimaryAgentProfile'
import type { RunContextToolContext } from '../src/agent/run-context/host-ports'
import { RunContext } from '../src/agent/run-context/RunContext'
import type { AgentSystemRuntimeConfig } from '../src/agent/RuntimeConfiguration'
import { createBuiltInPromptRegistry } from '../src/prompts'
import type { ChatPromptFeatureId, ToolCategoryOverview } from '../src/protocol'
import type { AgentSkillProvider } from '../src/skills/AgentSkillProvider'
import { createSkillDefinition } from '../src/skills/AgentSkillProvider'
import { AgentSkillRepository } from '../src/skills/AgentSkillRepository'
import { defaultRuntimePromptFeaturePolicy } from '../src/tools/prompt-feature-policy'

const VisualRequest: ModelMessage = {
  role: 'user',
  content: '做一个简单 HTML 卡片页面，实时预览。',
}
const ToolReceipt: ModelMessage = {
  role: 'tool',
  content: [
    {
      type: 'tool-result',
      toolName: 'tooling:read',
      toolCallId: 'read-1',
      output: { type: 'json', value: { text: 'current data' } },
    },
  ],
}
const SystemConfig: AgentSystemRuntimeConfig = {
  thinkingDepth: 'balanced',
  disabledToolNames: [],
  prompt: { segmentOverrides: [] },
  advancedRuntime: {},
}

function createPromptHarness() {
  let skillsEnabled = true
  let canReadSkills = true
  let promptFeatures: ChatPromptFeatureId[] = ['widget', 'html-artifact']
  const provider: AgentSkillProvider = {
    id: 'bundled-skills',
    kind: 'builtin',
    label: 'Bundled skills',
    getVersion: () => String(skillsEnabled),
    listSkills: () =>
      ['widget-visual-output', 'html-artifact-output'].map((id) =>
        createSkillDefinition({
          id,
          label: id,
          provider,
          roleIds: ['primary-agent'],
          markdown: 'Current capability usage',
          capabilityScopes: ['system'],
          enabled: skillsEnabled,
        })
      ),
  }
  const repository = new AgentSkillRepository([provider])
  const toolNames = () => (canReadSkills ? ['tooling:read', 'ui:show_widget'] : ['ui:show_widget'])
  const categories = (): ToolCategoryOverview[] => [
    {
      category: {
        id: 'interaction',
        label: 'Interaction',
        description: 'Current tools',
        toolOs: { domain: 'runtime', defaultState: 'resident' },
      },
      enabled: true,
      tools: toolNames().map((name) => ({
        name,
        description: name,
        permissions: [],
        categoryId: 'interaction',
        systemEnabled: true,
      })),
    },
  ]
  const profile = new PrimaryAgentProfile(
    {
      getSkillMarkdownForRole: (...args) => repository.getSkillMarkdownForRole(...args),
      listSkillsForRole: (role, selected, scope, features) =>
        repository.listSkillsForRole(role, selected, scope, undefined, features),
    },
    { getToolCategoryId: () => 'interaction' }
  )
  const context: RunContextToolContext = {
    locale: 'zh-CN',
    sessionId: 'prompt-availability',
    codingSession: {
      getEnabledPromptFeatures: () => [...promptFeatures],
      getActiveCapabilityScope: () => 'system',
      getToolSurfaceProfile: () => 'default',
      getRunProfile: () => null,
      getActiveToolCategories: () => ['interaction'],
    },
    interaction: { getCurrentPlan: () => [], getCurrentExecutionAdvice: () => null },
    skills: {
      listRoleSkills: () =>
        repository.listSkillsForRole('primary-agent', [], 'system', undefined, promptFeatures),
    },
    listToolCategories: categories,
    listTools: () => toolNames().map((name) => ({ name })),
  }
  const run = new RunContext(
    new ContextBuilder(createBuiltInPromptRegistry()),
    defaultRuntimePromptFeaturePolicy
  )
  return {
    repository,
    setSkillsEnabled: (enabled: boolean) => {
      skillsEnabled = enabled
    },
    setCanReadSkills: (enabled: boolean) => {
      canReadSkills = enabled
    },
    setPromptFeatures: (features: ChatPromptFeatureId[]) => {
      promptFeatures = features
    },
    build: (messages: ModelMessage[]) =>
      run.buildPrimaryAgentSystemPrompt({
        chatConfig: { modelSelection: {}, systemPromptAppend: '' },
        systemConfig: SystemConfig,
        roleResolution: profile.resolve({
          knownToolNames: toolNames(),
          promptFeatures,
          activeCapabilityScope: 'system',
          allowSubAgents: false,
        }),
        toolContext: context,
        promptFeatures,
        messages,
        contextPhase: 'operational',
      }),
  }
}

describe('runtime prompt follows current skill and task availability', () => {
  test('disabled bundled skills do not become mandatory reading prerequisites', async () => {
    const harness = createPromptHarness()
    harness.setSkillsEnabled(false)
    const built = await harness.build([VisualRequest])

    assert.equal(
      harness.repository.readSkillForRole('primary-agent', 'widget-visual-output', [], 'system'),
      null
    )
    assert.doesNotMatch(built.systemPrompt, /skill:(?:widget-visual-output|html-artifact-output)/u)
    assert.ok(built.promptSegments.some((segment) => segment.id === 'runtime.visual-widget-tools'))
    assert.ok(
      built.promptSegments.some((segment) => segment.id === 'runtime.html-artifact-protocol')
    )
  })

  test('skill hints follow enable and disable changes in an existing run', async () => {
    const harness = createPromptHarness()
    const enabled = await harness.build([VisualRequest])
    assert.match(enabled.systemPrompt, /先读取 skill:widget-visual-output/u)
    assert.match(enabled.systemPrompt, /先读取 skill:html-artifact-output/u)

    harness.setSkillsEnabled(false)
    const disabled = await harness.build([VisualRequest])
    assert.doesNotMatch(
      disabled.systemPrompt,
      /skill:(?:widget-visual-output|html-artifact-output)/u
    )
  })

  test('readable descriptors do not direct a role to a missing skill reading tool', async () => {
    const harness = createPromptHarness()
    harness.setCanReadSkills(false)
    const built = await harness.build([VisualRequest])

    assert.doesNotMatch(built.systemPrompt, /skill:(?:widget-visual-output|html-artifact-output)/u)
  })

  test('HTML protocol and rendering choice survive tool receipts and assistant progress', async () => {
    const harness = createPromptHarness()
    const built = await harness.build([
      VisualRequest,
      { role: 'assistant', content: '正在读取所需数据。' },
      ToolReceipt,
    ])

    assert.ok(
      built.promptSegments.some((segment) => segment.id === 'runtime.html-artifact-protocol')
    )
    assert.ok(
      built.promptSegments.some((segment) => segment.id === 'runtime.visual-rendering-routing')
    )
  })

  test('new user intent and capability changes replace earlier visual routing', async () => {
    const harness = createPromptHarness()
    await harness.build([VisualRequest])
    const textOnly = await harness.build([
      VisualRequest,
      ToolReceipt,
      { role: 'user', content: '改为纯文字总结。' },
      createInternalFollowUpMessage('Continue using the current HTML data evidence.'),
    ])
    assert.ok(
      !textOnly.promptSegments.some((segment) => segment.id === 'runtime.html-artifact-protocol')
    )

    harness.setPromptFeatures(['widget'])
    const featureOff = await harness.build([VisualRequest, ToolReceipt])
    assert.ok(
      !featureOff.promptSegments.some((segment) => segment.id === 'runtime.html-artifact-protocol')
    )
  })
})
