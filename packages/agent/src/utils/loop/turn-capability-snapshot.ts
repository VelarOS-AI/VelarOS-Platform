import { isObject, isString,toNullable } from '@velaros-ai/core'

import type { AgentTurnCapabilitySnapshotSource } from '../../contract/requires.js'
import type { ToolAvailabilityScope } from '../../types/agent.js'
import type { AgentTurnCapabilityContextView,AgentTurnCapabilitySnapshot } from '../../types/loop.js'


const ToolAvailabilityScopes: readonly ToolAvailabilityScope[] = [
  'enabled',
  'all',
  'system-enabled',
  'catalog',
]

/** 兼容尚未实现快照端口的 headless/test adapter；产品宿主必须提供真实快照。 */
function captureAgentTurnCapabilitySnapshot<TRegistry>(
  source: TRegistry & Partial<AgentTurnCapabilitySnapshotSource<TRegistry>>
): AgentTurnCapabilitySnapshot<TRegistry> {
  return source.captureTurnCapabilitySnapshot?.() ?? source
}

/**
 * 冻结 Query turn 构建提示词时读取的 descriptor/catalog 投影。
 *
 * 可变执行状态和 visible-signature setter 继续委托原始 context，只冻结能力视图。
 */
function captureAgentTurnCapabilityContext<
  TContext extends AgentTurnCapabilityContextView,
>(context: TContext): TContext {
  const toolsByScope = new Map(
    ToolAvailabilityScopes.map((scope) => [scope, [...context.listTools(scope)]])
  )
  const categoriesByScope = new Map(
    ToolAvailabilityScopes.map((scope) => [scope, [...context.listToolCategories(scope)]])
  )
  const capabilityPages = context.listCapabilityPages
    ? [...context.listCapabilityPages()]
    : undefined
  const inputSchemas = new Map<string, unknown>()
  if (context.describeToolInputSchema) {
    for (const entry of toolsByScope.get('catalog') ?? []) {
      if (
        isObject(entry) &&
        'name' in entry &&
        isString(entry.name)
      ) {
        inputSchemas.set(entry.name, context.describeToolInputSchema(entry.name))
      }
    }
  }

  const snapshot = Object.create(context) as TContext
  Object.defineProperties(snapshot, {
    listTools: {
      value: (scope: ToolAvailabilityScope = 'enabled') => [
        ...(toolsByScope.get(scope) ?? []),
      ],
    },
    listToolCategories: {
      value: (scope: ToolAvailabilityScope = 'enabled') => [
        ...(categoriesByScope.get(scope) ?? []),
      ],
    },
  })
  // 描述符表里不能出现 undefined：宿主没提供的能力就不定义，读到的仍是原型上的缺席。
  if (capabilityPages) {
    Object.defineProperty(snapshot, 'listCapabilityPages', {
      value: () => [...capabilityPages],
    })
  }
  if (context.describeToolInputSchema) {
    Object.defineProperty(snapshot, 'describeToolInputSchema', {
      value: (toolName: string) => toNullable(inputSchemas.get(toolName)),
    })
  }
  return snapshot
}

export { captureAgentTurnCapabilityContext, captureAgentTurnCapabilitySnapshot }
