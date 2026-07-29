// 域：注册表快照 → 各领域消费面的投影。
//
// 装配链只读快照投影，不直接遍历注册表（保证「每回合固定 generation」的消费纪律）。
// 投影是纯函数：同一快照恒得同一结果，且**保持载荷对象同一性**——装载不复制、不包装、
// 不改写运行态载荷，这是「官方内置经同一 Loader 装载后行为零变化」的结构性保证。
import type {
  AgentModSpaceContribution,
  AgentModTurnContextSourceContribution,
} from '@velaros-ai/agent-protocol'
import type { ToolCategoryDefinition } from '@velaros-ai/core/types'

import type { ExecutionModeDescriptor } from '../execution-modes'
import type { PromptSegmentDefinition } from '../prompts'
import type { AgentSkillDefinition } from '../skills'
import type { SubAgentTypeDescriptor } from '../sub-agent'
import type { VelaTool } from '../tool-library'

import type { AgentModRegistrySnapshot } from './AgentModRegistry'

/** 工具名 → 工具实体（主键即工具名，全宿主唯一由 Loader 保证）。 */
function projectAgentModTools(
  snapshot: AgentModRegistrySnapshot
): Record<string, VelaTool<any>> {
  const tools: Record<string, VelaTool<any>> = {}
  for (const record of snapshot.tools) {
    if (!record.payload) continue
    tools[record.key] = record.payload
  }
  return tools
}

/**
 * 提示词段定义清单。
 *
 * 有运行态绑定的原样返回（同一性保持）；只有 `text` 的声明段在此物化成定义，
 * `source` 统一打上 `mod:<modId>` 便于调试面板解释「这段从哪来」。
 */
function projectAgentModPromptSegments(
  snapshot: AgentModRegistrySnapshot
): PromptSegmentDefinition[] {
  const segments: PromptSegmentDefinition[] = []
  for (const record of snapshot.promptSegments) {
    if (record.payload) {
      segments.push(record.payload)
      continue
    }
    const declaration = record.declaration
    const text = declaration.text ?? ''
    segments.push({
      id: declaration.id,
      label: declaration.label,
      stability: declaration.stability,
      source: `mod:${record.modId}`,
      priority: declaration.priority,
      retention: declaration.retention,
      render: () => text,
    })
  }
  return segments
}

function projectAgentModToolCategories(
  snapshot: AgentModRegistrySnapshot
): Record<string, ToolCategoryDefinition> {
  const categories: Record<string, ToolCategoryDefinition> = {}
  for (const record of snapshot.toolCategories) {
    if (!record.payload) continue
    categories[record.key] = record.payload
  }
  return categories
}

function projectAgentModSkills(
  snapshot: AgentModRegistrySnapshot
): AgentSkillDefinition[] {
  return snapshot.skills
    .map((record) => record.payload)
    .filter((payload): payload is AgentSkillDefinition => payload !== null)
}

function projectAgentModSubAgentTypes(
  snapshot: AgentModRegistrySnapshot
): SubAgentTypeDescriptor[] {
  return snapshot.subAgentTypes
    .map((record) => record.payload)
    .filter((payload): payload is SubAgentTypeDescriptor => payload !== null)
}

function projectAgentModExecutionModes(
  snapshot: AgentModRegistrySnapshot
): ExecutionModeDescriptor[] {
  return snapshot.executionModes
    .map((record) => record.payload)
    .filter((payload): payload is ExecutionModeDescriptor => payload !== null)
}

/** 纯数据轴：直接返回声明（无运行态载荷）。 */
function projectAgentModSpaces(
  snapshot: AgentModRegistrySnapshot
): AgentModSpaceContribution[] {
  return snapshot.spaces.map((record) => record.declaration)
}

function projectAgentModTurnContextSources(
  snapshot: AgentModRegistrySnapshot
): AgentModTurnContextSourceContribution[] {
  return snapshot.turnContextSources.map((record) => record.declaration)
}

export {
  projectAgentModExecutionModes,
  projectAgentModPromptSegments,
  projectAgentModSkills,
  projectAgentModSpaces,
  projectAgentModSubAgentTypes,
  projectAgentModToolCategories,
  projectAgentModTools,
  projectAgentModTurnContextSources,
}
