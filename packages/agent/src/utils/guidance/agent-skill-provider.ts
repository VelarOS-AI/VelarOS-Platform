import { isEmpty, isNonBlankString, optionalWhen } from '@velaros-ai/core'

import type { AgentSkillProvider } from '../../contract/requires.js'
import type { ChatPromptFeatureId } from '../../types/agent'
import type { AgentRoleId,CapabilityScopeId } from '../../types/agent.js'
import type { AgentSkillDefinition,AgentSkillKind } from '../../types/guidance.js'

/** 非空时复制一份；空数组与缺席都不写入技能定义。 */
function copyNonEmpty<T>(values: Optional<readonly T[]>): Optional<T[]> {
  if (!values?.length) return undefined
  return [...values]
}

function createSkillDefinition(args: {
  id: string
  label: string
  description?: string
  provider: Pick<AgentSkillProvider, 'id' | 'kind'>
  roleIds: AgentRoleId[]
  priority?: number
  markdown: string
  /** 技能类型；省略默认 capability（指针 + 按需读取）。role 只应由内置角色供应方显式声明。 */
  skillKind?: AgentSkillKind
  autoInjectPromptFeatures?: readonly ChatPromptFeatureId[]
  capabilityScopes: readonly CapabilityScopeId[]
  enabled?: boolean
  userVisible?: boolean
  argumentHint?: LooseOptional<string>
  baseDir?: LooseOptional<string>
  resourcePaths?: readonly string[]
  sourceResourceId?: LooseOptional<string>
  allowedTools?: readonly string[]
}): AgentSkillDefinition {
  if (isEmpty(args.capabilityScopes)) {
    throw new TypeError(`Skill「${args.id}」必须显式声明至少一个 capabilityScopes`)
  }
  return {
    id: args.id,
    label: args.label,
    description: args.description,
    sourceKind: args.provider.kind,
    sourceId: args.provider.id,
    roleIds: args.roleIds,
    priority: args.priority ?? 100,
    userVisible: args.userVisible ?? true,
    argumentHint: optionalWhen(isNonBlankString, args.argumentHint?.trim()),
    baseDir: optionalWhen(isNonBlankString, args.baseDir?.trim()),
    resourcePaths: copyNonEmpty(args.resourcePaths),
    sourceResourceId: optionalWhen(isNonBlankString, args.sourceResourceId?.trim()),
    allowedTools: copyNonEmpty(args.allowedTools),
    enabled: args.enabled ?? true,
    markdown: args.markdown.trim(),
    skillKind: args.skillKind ?? 'capability',
    autoInjectPromptFeatures: args.autoInjectPromptFeatures
      ? [...args.autoInjectPromptFeatures]
      : [],
    capabilityScopes: [...args.capabilityScopes],
  }
}

export { createSkillDefinition }
