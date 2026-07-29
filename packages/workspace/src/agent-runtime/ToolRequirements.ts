import { isPlainObject } from '@velaros-ai/core'

import type { ToolContext } from './Types'
import type { AgentWorkspaceCommandToolRequirement } from './WorkspaceCapabilityPort'

interface RequirementResult {
  toolRequirements?: AgentWorkspaceCommandToolRequirement[]
  systemToolSuggestion?: any
}

export function attachSystemToolSuggestion<T>(result: T, ctx: ToolContext): T {
  if (!isObjectRecord(result)) return result

  const target = result as T & RequirementResult
  if (target.systemToolSuggestion || !ctx.system.createSystemToolInstallSuggestion) return result

  const requirement = target.toolRequirements?.find(
    (item) => item.kind === 'missing-command' && !!item.command.trim()
  )
  if (!requirement) return result

  const suggestion = ctx.system.createSystemToolInstallSuggestion({
    command: requirement.command,
    reason: requirement.reason ?? `${requirement.command} 当前不在 shell PATH 中。`,
    scope: 'workspace',
  })
  if (!suggestion) return result

  return {
    ...target,
    systemToolSuggestion: suggestion,
  }
}

function isObjectRecord(value: any): value is Record<string, any> {
  return isPlainObject(value)
}
