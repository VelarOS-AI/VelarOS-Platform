// 域：内置 mod 清单的三条投影——把内置工具、提示词段与执行模式各自翻成 manifest 的贡献条目。
//
// 清单由既有单源派生，不另立一份名单，所以不可能与实现漂移；这里只做形状转换，不做取舍。
import { optionalWhen, toOptional } from '@velaros-ai/core'

import type { AgentModExecutionModeContribution, AgentModPromptSegmentContribution, AgentModToolContribution } from '../../types/agent.js'
import type { VelaTool } from '../../types/builtin.js'
import type { PromptSegmentDefinition } from '../../types/guidance.js'
import type { ExecutionModeDescriptor } from '../../types/runner.js'
import { resolvePromptSegmentStability } from '../guidance/prompt-stability'
import { resolveToolReadOnly } from '../toolkit/define-tool-contract'

/** 一个内置工具 → manifest 的工具贡献条目：只留名字、类别、摘要与只读标记。 */
export function toToolContribution(
  name: string,
  tool: VelaTool<any>
): AgentModToolContribution {
  return {
    name,
    categoryId: optionalWhen(!!tool.category, tool.category),
    summary: optionalWhen(!!tool.summary, tool.summary),
    readOnly: resolveToolReadOnly(tool),
  }
}

/** 一个内置提示词段 → manifest 的段贡献条目；稳定性由它所在的层派生，段自己不自报。 */
export function toPromptSegmentContribution(
  definition: PromptSegmentDefinition
): AgentModPromptSegmentContribution {
  return {
    id: definition.id,
    label: toOptional(definition.label),
    stability: resolvePromptSegmentStability(definition.tier),
    priority: definition.priority,
    retention: toOptional(definition.retention),
  }
}

/** 一个官方执行模式 → manifest 的执行模式贡献条目。 */
export function toExecutionModeContribution(
  descriptor: ExecutionModeDescriptor
): AgentModExecutionModeContribution {
  return {
    id: descriptor.id,
    label: descriptor.label,
    promptFeatureId: descriptor.prompt.legacyPromptFeatureId,
    sessionSticky: descriptor.stickiness.sessionSticky,
  }
}
