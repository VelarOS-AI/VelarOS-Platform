import type {
  AgentRoleId,
  CustomSubAgentDefinition,
  SubAgentTypeId,
  TeamExecutionPhase,
  TeamModelRouteCategory,
  TeamWorkerType,
  ToolCategoryId,
} from '@velaros-ai/agent/protocol'
import { AppError } from '@velaros-ai/core/error'

/** Product-owned declaration of one delegatable agent shape. */
interface SubAgentTypeDescriptor {
  id: SubAgentTypeId
  /** 给主 Agent 选择派发类型的一句话用途，与该类型的实际能力声明同源。 */
  description?: string
  workerType: TeamWorkerType
  roleId: AgentRoleId
  routeCategory: TeamModelRouteCategory
  workerPhase: TeamExecutionPhase
  toolCategories: readonly ToolCategoryId[]
  toolNames: readonly string[]
  resourceLeaseScope: Nullable<string>
  readonlyDefault: boolean
  promptAppend: Nullable<string>
}

/** 本轮可派发类型的轻量目录；不承载授权或工具能力声明。 */
interface SubAgentDispatchCatalog {
  defaultTypeId: SubAgentTypeId
  types: ReadonlyArray<{
    id: SubAgentTypeId
    description?: string
    readonlyDefault: boolean
  }>
}

/** Agent Runtime has no built-in worker taxonomy. Hosts inject a complete catalog. */
interface SubAgentTypeProvider {
  readonly defaultTypeId: SubAgentTypeId
  listDescriptors(): readonly SubAgentTypeDescriptor[]
  getDescriptor(id: SubAgentTypeId): Nullable<SubAgentTypeDescriptor>
}

interface ResolvedSubAgentTypeConfig extends Omit<SubAgentTypeDescriptor, 'id'> {
  subagentType: SubAgentTypeId
  customAgentId?: string
  customAgentName?: string
}

function resolveSubAgentTypeConfig(
  provider: SubAgentTypeProvider,
  subagentType: SubAgentTypeId
): ResolvedSubAgentTypeConfig {
  const descriptor = provider.getDescriptor(subagentType)
  if (!descriptor) throw new AppError('NOT_FOUND', `unknown injected sub-agent type: ${subagentType}`)
  const { id, ...faces } = descriptor
  return { subagentType: id, ...faces }
}

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
export type {
  ResolvedSubAgentTypeConfig,
  SubAgentDispatchCatalog,
  SubAgentTypeDescriptor,
  SubAgentTypeProvider,
}
