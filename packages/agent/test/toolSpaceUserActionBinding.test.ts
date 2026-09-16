import { describe, expect, test } from 'bun:test'

import type { AgentRuntimeCapabilityPorts } from '../src/contract/requires'
import {
  buildToolActivationGuide,
  buildToolDiscoveryCards,
  resolveToolActivationHostBindings,
} from '../src/utils/builtin/tool-space-activation'
import { mapToolDiscoveryCards } from '../src/utils/builtin/tool-space-queries'

/** 被外部连接挡住、只能靠一次用户侧动作解开的目标工具。 */
const BlockedToolName = 'connector:sync'
/** 宿主声明为「请求用户动作」角色的那个工具；没有任何一层内核代码认得这个名字。 */
const HostUserActionToolName = 'host:ask_for_action'

function createToolSpaceContext(capabilityPorts?: AgentRuntimeCapabilityPorts) {
  const descriptors = [
    {
      name: BlockedToolName,
      description: 'Sync an external connector.',
      role: 'execute',
      permissions: [],
      categoryId: 'alpha',
      systemEnabled: true,
    },
    {
      name: HostUserActionToolName,
      description: 'Ask the user to complete something.',
      role: 'execute',
      permissions: [],
      categoryId: 'alpha',
      systemEnabled: true,
    },
  ]
  const capabilityPages = [
    {
      id: `tool:${BlockedToolName}`,
      kind: 'tool',
      name: BlockedToolName,
      categoryId: 'alpha',
      descriptor: descriptors[0],
      permissions: [],
      availability: 'requires_user_action',
      schemaState: 'hidden',
      schemaPolicy: 'preview',
      nextAction: 'request_user_action',
      resident: false,
      reasons: [{ layer: 'plugin', code: 'user_action_required', message: '该能力依赖外部连接。' }],
    },
    {
      id: `tool:${HostUserActionToolName}`,
      kind: 'tool',
      name: HostUserActionToolName,
      categoryId: 'alpha',
      descriptor: descriptors[1],
      permissions: [],
      availability: 'loadable',
      schemaState: 'preview',
      schemaPolicy: 'preview',
      nextAction: 'page_in_tool',
      resident: false,
      reasons: [{ layer: 'resident', code: 'loadable', message: '已授权但未驻留。' }],
    },
  ]

  return {
    capabilityPorts,
    codingSession: {
      hasToolCategoryAccess: () => true,
      isToolCategoryAllowed: () => true,
      getEnabledPromptFeatures: () => [],
    },
    getCurrentVisibleToolNames: () => [],
    listCapabilityPages: () => capabilityPages,
    listToolCategories: () => [
      {
        category: {
          id: 'alpha',
          label: 'alpha tools',
          description: 'Tools in alpha.',
          toolOs: { domain: 'alpha-domain', defaultState: 'loadable' },
        },
        enabled: true,
        tools: descriptors,
      },
    ],
  } as never
}

function blockedToolActivation(capabilityPorts?: AgentRuntimeCapabilityPorts) {
  const ctx = createToolSpaceContext(capabilityPorts)
  const card = buildToolDiscoveryCards(ctx).find((entry) => entry.name === BlockedToolName)
  expect(card).toBeDefined()
  return buildToolActivationGuide(card!, resolveToolActivationHostBindings(ctx))
}

const MapInput = {
  op: 'map' as const,
  kind: 'tool' as const,
  categoryIds: [],
  domainIds: [],
  toolOsStates: [],
  categoryLimit: 12,
  maxToolsPerCategory: 8,
}

function userActionDependencyRule(capabilityPorts?: AgentRuntimeCapabilityPorts) {
  const result = mapToolDiscoveryCards(createToolSpaceContext(capabilityPorts), MapInput)
  return result.guide.dependencyRules.find((rule) => rule.id === 'plugin-before-plugin-tools')
}

describe('请求用户动作的工具由宿主声明', () => {
  test('宿主声明了就点名它：页 id / pageIn / nextTool 三件套都指向声明的那个工具', () => {
    const activation = blockedToolActivation({
      userActionRequestToolName: HostUserActionToolName,
    })

    expect(activation.method).toBe('request_user_action')
    expect(activation.pageIn).toEqual([`tool:${HostUserActionToolName}`])
    expect(activation.nextTool).toBe(HostUserActionToolName)
    const dependency = activation.dependencies.find((entry) => entry.id === 'plugin_user_action')
    expect(dependency?.pageId).toBe(`tool:${HostUserActionToolName}`)
    expect(dependency?.pageIn).toEqual([`tool:${HostUserActionToolName}`])
    expect(dependency?.nextTool).toBe(HostUserActionToolName)
    expect(activation.activationFlow.join('\n')).toContain(HostUserActionToolName)
  })

  test('宿主没声明就不点名任何工具，但指引仍然完整可执行', () => {
    const activation = blockedToolActivation()

    expect(activation.method).toBe('request_user_action')
    expect(activation.pageIn).toEqual([])
    expect(activation.nextTool).toBeNull()
    const dependency = activation.dependencies.find((entry) => entry.id === 'plugin_user_action')
    expect(dependency?.pageId).toBeNull()
    expect(dependency?.pageIn).toEqual([])
    expect(dependency?.nextTool).toBeNull()
    // 不变量③：每条出口至少一条可执行指令，空流程会让模型反复 page-in 同一张不可用页。
    expect(activation.activationFlow.length).toBeGreaterThan(0)
    for (const step of activation.activationFlow) expect(step.trim().length).toBeGreaterThan(0)
    const modelFacingText = [
      activation.summary,
      ...activation.notes,
      ...activation.activationFlow,
      ...activation.dependencies.map((entry) => `${entry.summary}\n${entry.activationHint}`),
    ].join('\n')
    expect(modelFacingText).not.toContain(HostUserActionToolName)
    expect(modelFacingText).not.toContain('tool:')
  })

  test('map 的前置规则同样跟着声明走，没声明时改判「直接找用户」', () => {
    const declared = userActionDependencyRule({
      userActionRequestToolName: HostUserActionToolName,
    })
    expect(declared?.status).toBe('load_tool_entry')
    expect(declared?.prerequisite.pageId).toBe(`tool:${HostUserActionToolName}`)
    expect(declared?.prerequisite.pageIn).toEqual([`tool:${HostUserActionToolName}`])
    expect(declared?.prerequisite.nextTool).toBe(HostUserActionToolName)

    const undeclared = userActionDependencyRule()
    expect(undeclared?.status).toBe('ask_user_directly')
    expect(undeclared?.prerequisite.pageId).toBeNull()
    expect(undeclared?.prerequisite.pageIn).toEqual([])
    expect(undeclared?.prerequisite.nextTool).toBeNull()
  })

  test('扩展也能声明，顶层声明优先', () => {
    const fromExtension = blockedToolActivation({
      extensions: [
        {
          descriptor: { id: 'alpha-capability' },
          userActionRequestToolName: HostUserActionToolName,
        },
      ],
    })
    expect(fromExtension.nextTool).toBe(HostUserActionToolName)

    const topLevelWins = blockedToolActivation({
      extensions: [
        {
          descriptor: { id: 'alpha-capability' },
          userActionRequestToolName: HostUserActionToolName,
        },
      ],
      userActionRequestToolName: 'host:other_ask',
    })
    expect(topLevelWins.nextTool).toBe('host:other_ask')
  })
})
