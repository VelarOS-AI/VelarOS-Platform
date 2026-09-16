/**
 * 技能可见性判定：`AgentSkillRepository` 那条「角色 → 启用 → 作用域 → 资源根 → prompt feature」
 * 漏斗上的几道闸，各自只看一条技能自己的声明，不碰仓库状态，所以放在这里当纯函数。
 */

import { isEmpty } from '@velaros-ai/core'

import type { ChatPromptFeatureId } from '../../types/agent'
import type { CapabilityScopeId } from '../../types/agent.js'
import type { AgentSkillDefinition } from '../../types/guidance.js'

/**
 * 带 `autoInjectPromptFeatures` 的 Skill 是已启用插件的操作手册：插件未启用时不进入当前 Skills 索引。
 * 没声明依赖、或者用户已显式选中这条技能时一律放行；否则要求本轮 prompt feature 至少命中一个。
 * 插件是否存在、如何申请由宿主注入的 plugin prompt 段说明。
 */
export function isSkillVisibleForPromptFeatures(
  skill: AgentSkillDefinition,
  selectedSkillIds: ReadonlySet<string>,
  promptFeatures: ReadonlySet<ChatPromptFeatureId>
): boolean {
  const requiredFeatures = skill.autoInjectPromptFeatures ?? []
  if (isEmpty(requiredFeatures) || selectedSkillIds.has(skill.id)) return true
  return requiredFeatures.some((feature) => promptFeatures.has(feature))
}

/**
 * 项目级技能的资源根精筛：技能没绑来源项目根时对谁都可见；绑了就只在会话活跃根与它逐字相等时可见，
 * 会话没带根则一律不可见。这道闸保证多个项目的技能互不泄漏，是权限性质的，选中也绕不过去。
 */
export function isSkillVisibleForResource(
  skill: AgentSkillDefinition,
  resourceId?: LooseOptional<string>
): boolean {
  if (!skill.sourceResourceId) return true
  if (!resourceId?.trim()) return false
  return resourceId.trim() === skill.sourceResourceId.trim()
}

/**
 * 空间作用域过滤：技能的 `capabilityScopes` 里列了当前空间才进这个空间的泛化索引。
 * 调用方没给空间时一律不可见——宁可少列也不要把别的空间的技能漏进索引。
 * 它收敛的是索引面，不是权限：用户显式选中的技能走另一条逃生口，不经过这里。
 */
export function isSkillVisibleInScope(
  skill: AgentSkillDefinition,
  capabilityScope?: CapabilityScopeId
): boolean {
  if (!capabilityScope) return false
  return skill.capabilityScopes.includes(capabilityScope)
}

/**
 * 这条技能是不是靠「本轮某个 prompt feature 开着」自动命中的。
 * 用在注入侧：没被用户选中但命中了依赖的插件特性，也要往提示词里挂一条 `skill:<id>` 链接。
 */
export function hasAutoInjectPromptFeature(
  skill: AgentSkillDefinition,
  promptFeatures: ReadonlySet<ChatPromptFeatureId>
): boolean {
  return !!skill.autoInjectPromptFeatures?.some((feature) => promptFeatures.has(feature))
}
