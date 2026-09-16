import { AppError } from '@velaros-ai/core/error'

import type { SubAgentTypeProvider } from '../../contract/requires.js'
import type {CustomSubAgentDefinition, SubAgentTypeId } from '../../types/agent.js'
import type { ResolvedSubAgentTypeConfig } from '../../types/delegation.js'

/**
 * 按内置 sub-agent 类型 id 从注入的 provider 取出该类型的完整配置（工具分类、只读默认值、
 * promptAppend、route category 等），descriptor 的 `id` 落到 `subagentType` 字段。
 * 类型未注册时抛 `NOT_FOUND`——派发一个不存在的类型必须当场失败，不能静默回落到某个默认类型。
 */
function resolveSubAgentTypeConfig(
  provider: SubAgentTypeProvider,
  subagentType: SubAgentTypeId
): ResolvedSubAgentTypeConfig {
  const descriptor = provider.getDescriptor(subagentType)
  if (!descriptor) throw new AppError('NOT_FOUND', `未注册的子 Agent 类型：${subagentType}。宿主注入的类型表里没有它，请先登记这个类型再派发；这里不会静默回落到某个默认类型。`)
  const { id, ...faces } = descriptor
  return { subagentType: id, ...faces }
}

/**
 * 在自定义 agent 声明的 base 类型配置之上叠加它自己的定义：
 * toolCategories 与 readonly 给了就整体替换 base 的（不做并集，自定义 agent 说了算）；
 * promptMarkdown 则**追加**在 base 的 promptAppend 之后（空行隔开），两边都空时为 null。
 * 另外记下 customAgentId/customAgentName，供指令与线程续跑身份校验区分同 base 的不同自定义 agent。
 */
function resolveCustomSubAgentTypeConfig(
  provider: SubAgentTypeProvider,
  definition: CustomSubAgentDefinition
): ResolvedSubAgentTypeConfig {
  const base = resolveSubAgentTypeConfig(provider, definition.base)
  const promptAppend = [base.promptAppend, definition.promptMarkdown.trim() || null]
    .filter(Boolean)
    .join('\n\n')
  return {
    ...base,
    toolCategories: definition.toolCategories ?? base.toolCategories,
    readonlyDefault: definition.readonly ?? base.readonlyDefault,
    promptAppend: promptAppend || null,
    customAgentId: definition.id,
    customAgentName: definition.name,
  }
}

export { resolveCustomSubAgentTypeConfig, resolveSubAgentTypeConfig }
