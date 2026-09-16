// ToolRegistry 用到的纯函数（不碰实例状态）。
import type { AgentRuntimeCapabilityPorts } from '../../contract/requires.js'
import type { ToolCategoryDefinition, ToolCategoryId } from '../../types/agent.js'
import { resolveCapabilityCategoryDefinitions } from '../../utils/capabilities'

/** 取一个工具类别的定义；能力包没登记过就给一份只有 id 的兜底定义。 */
export function resolveCategoryDefinition(
  categoryId: ToolCategoryId,
  ports?: AgentRuntimeCapabilityPorts
): ToolCategoryDefinition {
  return (
    resolveCapabilityCategoryDefinitions(ports)[categoryId] ?? {
      id: categoryId,
      label: categoryId,
      description: '',
      toolOs: { domain: 'injected', defaultState: 'loadable' },
    }
  )
}
