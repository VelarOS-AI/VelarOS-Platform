import { AppError } from '@velaros-ai/core/error'

import type { SubAgentTypeProvider } from '../../contract/requires.js'
import type {CustomSubAgentDefinition, SubAgentTypeId } from '../../types/agent.js'
import type { ResolvedSubAgentTypeConfig } from '../../types/delegation.js'

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
