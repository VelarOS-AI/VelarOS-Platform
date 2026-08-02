// 域：注册表快照 → 各领域消费面的投影。
//
// 装配链只读快照投影，不直接遍历注册表（保证「每回合固定 generation」的消费纪律）。
// 投影是纯函数：同一快照恒得同一结果，且**保持载荷对象同一性**——装载不复制、不包装、
// 不改写运行态载荷，这是「官方内置经同一 Loader 装载后行为零变化」的结构性保证。
import { isNotNull } from '@velaros-ai/core'
import type { ToolCategoryDefinition } from '@velaros-ai/core/types'

import type { ExecutionModeDescriptor } from '../execution-modes'
import type { PromptSegmentDefinition } from '../prompts'
import type { AgentModSpaceContribution, AgentModTurnContextSourceContribution } from '../protocol'
import type { AgentSkillDefinition } from '../skills'
import type { SubAgentTypeDescriptor } from '../sub-agent'
import type { VelaTool } from '../tool-library'

import type { AgentModRegistrySnapshot } from './AgentModRegistry'

/**
 * 一代 Mod 注册表对应的一份完整 Agent Surface。
 *
 * 宿主只消费这一份原子快照，不再分别读取九条贡献轴后自行拼接，避免同一回合混入
 * 不同 generation 的工具、空间或策略。
 */
interface AgentModSurfaceSnapshot {
  readonly generation: number
  readonly tools: Readonly<Record<string, VelaTool<any, any>>>
  readonly toolCategoryByName: Readonly<Record<string, string>>
  readonly toolCategories: Readonly<Record<string, ToolCategoryDefinition>>
  readonly promptSegments: readonly PromptSegmentDefinition[]
  readonly skills: readonly AgentSkillDefinition[]
  readonly spaces: readonly AgentModSpaceContribution[]
  readonly subAgentTypes: readonly SubAgentTypeDescriptor[]
  readonly turnContextSources: readonly AgentModTurnContextSourceContribution[]
  readonly executionModes: readonly ExecutionModeDescriptor[]
  readonly hooks: AgentModRegistrySnapshot['hooks']
}

/** 工具名 → 工具实体（主键即工具名，全宿主唯一由 Loader 保证）。 */
function projectAgentModTools(
  snapshot: AgentModRegistrySnapshot
): Record<string, VelaTool<any, any>> {
  const tools: Record<string, VelaTool<any, any>> = {}
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

function projectAgentModToolCategoryAssignments(
  snapshot: AgentModRegistrySnapshot
): Record<string, string> {
  return Object.fromEntries(
    snapshot.tools.flatMap((record) =>
      record.declaration.categoryId ? [[record.key, record.declaration.categoryId]] : []
    )
  )
}

function projectAgentModSkills(snapshot: AgentModRegistrySnapshot): AgentSkillDefinition[] {
  return snapshot.skills
    .map((record) => record.payload)
    .filter((payload): payload is AgentSkillDefinition => isNotNull(payload))
}

function projectAgentModSubAgentTypes(
  snapshot: AgentModRegistrySnapshot
): SubAgentTypeDescriptor[] {
  return snapshot.subAgentTypes
    .map((record) => record.payload)
    .filter((payload): payload is SubAgentTypeDescriptor => isNotNull(payload))
}

function projectAgentModExecutionModes(
  snapshot: AgentModRegistrySnapshot
): ExecutionModeDescriptor[] {
  return snapshot.executionModes
    .map((record) => record.payload)
    .filter((payload): payload is ExecutionModeDescriptor => isNotNull(payload))
}

/** 纯数据轴：直接返回声明（无运行态载荷）。 */
function projectAgentModSpaces(snapshot: AgentModRegistrySnapshot): AgentModSpaceContribution[] {
  return snapshot.spaces.map((record) => record.declaration)
}

/**
 * 把职责包声明的 `residentInSpaces` 汇入空间配方。
 *
 * 空间只拥有身份和基础策略；文件、执行、开发等职责包通过各自工具声明加入空间，因而
 * 不需要再复制一份 Desktop 专用工具清单。引用不存在的空间属于无效装配，直接报错。
 */
function composeAgentModSpaces(snapshot: AgentModRegistrySnapshot): AgentModSpaceContribution[] {
  const recipes = new Map(
    snapshot.spaces.map((record) => [record.key, {
      ...record.declaration,
      toolCategoryIds: new Set(record.declaration.toolCategoryIds ?? []),
      residentToolNames: new Set(record.declaration.residentToolNames ?? []),
    }])
  )

  for (const record of snapshot.tools) {
    for (const spaceId of record.declaration.residentInSpaces ?? []) {
      const recipe = recipes.get(spaceId)
      if (!recipe) {
        throw new Error(
          `Agent mod「${record.modId}」的工具「${record.key}」引用了不存在的空间「${spaceId}」。`
        )
      }
      recipe.residentToolNames.add(record.key)
      if (record.declaration.categoryId)
        recipe.toolCategoryIds.add(record.declaration.categoryId)
    }
  }

  const resolving = new Set<string>()
  const resolved = new Set<string>()
  const inherit = (spaceId: string): void => {
    if (resolved.has(spaceId)) return
    if (resolving.has(spaceId))
      throw new Error(`Agent space 配方继承成环：${[...resolving, spaceId].join(' -> ')}`)
    const recipe = recipes.get(spaceId)
    if (!recipe) throw new Error(`Agent space 配方不存在：${spaceId}`)
    resolving.add(spaceId)
    for (const parentId of recipe.inheritsSpaceIds ?? []) {
      inherit(parentId)
      const parent = recipes.get(parentId)
      if (!parent) continue
      for (const categoryId of parent.toolCategoryIds) recipe.toolCategoryIds.add(categoryId)
      for (const toolName of parent.residentToolNames) recipe.residentToolNames.add(toolName)
    }
    resolving.delete(spaceId)
    resolved.add(spaceId)
  }
  for (const spaceId of recipes.keys()) inherit(spaceId)

  return [...recipes.values()].map((recipe) => Object.freeze({
    ...recipe,
    toolCategoryIds: [...recipe.toolCategoryIds],
    residentToolNames: [...recipe.residentToolNames],
  }))
}

function projectAgentModTurnContextSources(
  snapshot: AgentModRegistrySnapshot
): AgentModTurnContextSourceContribution[] {
  return snapshot.turnContextSources.map((record) => record.declaration)
}

function createAgentModSurfaceSnapshot(
  snapshot: AgentModRegistrySnapshot
): AgentModSurfaceSnapshot {
  return Object.freeze({
    generation: snapshot.generation,
    tools: Object.freeze(projectAgentModTools(snapshot)),
    toolCategoryByName: Object.freeze(projectAgentModToolCategoryAssignments(snapshot)),
    toolCategories: Object.freeze(projectAgentModToolCategories(snapshot)),
    promptSegments: Object.freeze(projectAgentModPromptSegments(snapshot)),
    skills: Object.freeze(projectAgentModSkills(snapshot)),
    spaces: Object.freeze(composeAgentModSpaces(snapshot)),
    subAgentTypes: Object.freeze(projectAgentModSubAgentTypes(snapshot)),
    turnContextSources: Object.freeze(projectAgentModTurnContextSources(snapshot)),
    executionModes: Object.freeze(projectAgentModExecutionModes(snapshot)),
    hooks: snapshot.hooks,
  })
}

export {
  composeAgentModSpaces,
  createAgentModSurfaceSnapshot,
  projectAgentModExecutionModes,
  projectAgentModPromptSegments,
  projectAgentModSkills,
  projectAgentModSpaces,
  projectAgentModSubAgentTypes,
  projectAgentModToolCategories,
  projectAgentModTools,
  projectAgentModTurnContextSources,
}
export type { AgentModSurfaceSnapshot }
