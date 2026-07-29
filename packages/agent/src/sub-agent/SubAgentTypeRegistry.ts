import type {
  AgentRoleId,
  CustomSubAgentDefinition,
  SubAgentTypeId,
  TeamExecutionPhase,
  TeamModelRouteCategory,
  TeamWorkerType,
  ToolCategoryId,
} from '@velaros-ai/core/types'

/** Product-owned declaration of one delegatable agent shape. */
interface SubAgentTypeDescriptor {
  id: SubAgentTypeId
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
  if (!descriptor) throw new Error(`unknown injected sub-agent type: ${subagentType}`)
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
  SubAgentTypeDescriptor,
  SubAgentTypeProvider,
}
