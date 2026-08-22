import type { ToolAvailabilityScope } from '@velaros-ai/agent/protocol'
import { isObject, isString,toNullable } from '@velaros-ai/core'

/**
 * 单个 Agent turn 开始时捕获的只读注册表视图。
 *
 * 具体快照由宿主实现；Agent Runtime 只依赖这个消费侧端口。注册表变化因此只能在
 * 下一轮生效，不会改写已经开始构建的 provider request。
 */
type AgentTurnCapabilitySnapshot<TRegistry> = TRegistry

interface AgentTurnCapabilitySnapshotSource<TRegistry> {
  captureTurnCapabilitySnapshot(): AgentTurnCapabilitySnapshot<TRegistry>
}

interface AgentTurnCapabilityContextView {
  listTools(scope?: ToolAvailabilityScope): unknown[]
  listToolCategories(scope?: ToolAvailabilityScope): unknown[]
  listCapabilityPages?(): unknown[]
  describeToolInputSchema?(toolName: string): unknown
}

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
    ...(capabilityPages
      ? {
          listCapabilityPages: {
            value: () => [...capabilityPages],
          },
        }
      : {}),
    ...(context.describeToolInputSchema
      ? {
          describeToolInputSchema: {
            value: (toolName: string) => toNullable(inputSchemas.get(toolName)),
          },
        }
      : {}),
  })
  return snapshot
}

export { captureAgentTurnCapabilityContext, captureAgentTurnCapabilitySnapshot }
export type { AgentTurnCapabilitySnapshot, AgentTurnCapabilitySnapshotSource }
