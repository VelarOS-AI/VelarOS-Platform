/**
 * 记忆包自持序列化作用域身份；宿主决定哪个产品上下文映射到哪个作用域，经适配器把解析
 * 好的值传进来。
 */
import { isFalse } from '@velaros-ai/core'

export type MemoryScopeId = string

export const GLOBAL_MEMORY_SCOPE = 'global'
export const SYSTEM_MEMORY_SCOPE = 'system'

export function scopeTypeForScopeId(
  scopeId: LooseOptional<string>
): 'global' | 'workspace' | 'site' | 'system' {
  const normalized = scopeId?.trim() ?? ''
  if (normalized.startsWith('project:')) return 'workspace'
  if (normalized.startsWith('site:')) return 'site'
  if (normalized === SYSTEM_MEMORY_SCOPE) return 'system'
  return 'global'
}

export function buildProjectMemoryScope(
  root: LooseOptional<string>
): MemoryScopeId {
  const normalized = root?.trim()
  return normalized ? `project:${normalized}` : SYSTEM_MEMORY_SCOPE
}

export function buildSiteMemoryScope(
  origin: LooseOptional<string>
): MemoryScopeId {
  const normalized = origin?.trim()
  return normalized ? `site:${normalized}` : SYSTEM_MEMORY_SCOPE
}

/**
 * 作用域的**两根轴**：会话身份轴与工作区根轴。
 *
 * - 轴一 `scopeId` = 会话身份（空间实体）派生出的作用域：`system` / `project:<root>` /
 *   `site:<origin>`。宿主每次调用都算得出它，因此它**在场即权威**。
 * - 轴二 `workspaceRoot` = 当前工作区根。它不是第二个候选作用域，而是轴一缺席时
 *   **把项目作用域物化出来**的那个参数。
 *
 * 两轴正交但不并列：同时给两根轴时按轴一裁决。这一条必须写死，否则「浏览器空间的会话
 * 恰好也有活动项目根」就会同时命中站点池与项目池——那正是跨空间泄漏。
 */
export interface MemoryScopeSelectorInput {
  scopeId?: LooseOptional<string>
  workspaceRoot?: LooseOptional<string>
}

/**
 * 两轴 → 唯一作用域。返回空串 = 两轴皆缺席 = **不过滤**（管理面全量读）。
 *
 * 全仓唯一实现：文件后端、向量索引与 `memory:get` 的越界门都必须经过这里，不许各自
 * 再写一遍匹配式。历史上它们写过三份不一样的（后缀匹配 / 并集 / 精确），于是
 * 「同一个查询在不同后端看见不同的记忆」——作用域是隔离语义，不是检索偏好。
 */
export function resolveMemoryScopeSelector(
  input: MemoryScopeSelectorInput
): MemoryScopeId {
  const scopeId = input.scopeId?.trim()
  if (scopeId) return scopeId
  const workspaceRoot = input.workspaceRoot?.trim()
  return workspaceRoot ? buildProjectMemoryScope(workspaceRoot) : ''
}

/** 可见性判定的目标读数：后端记录、文件根与召回条目共用这一格。 */
export interface MemoryScopeTarget {
  scopeType?: LooseOptional<string>
  scopeId?: LooseOptional<string>
}

export interface MemoryScopeVisibilityInput extends MemoryScopeSelectorInput {
  /**
   * 是否并入真正的 global 记忆。默认并入（通用召回的既有行为）；需要严格实体隔离的入口
   * 显式传 false。
   */
  includeGlobal?: LooseOptional<boolean>
}

/**
 * 「这条记忆在当前两轴下可不可见」—— **全仓唯一判据**。
 *
 * 真值表（自上而下短路）：
 *  1. 两轴皆空 → 可见（无过滤）；
 *  2. 选定作用域 = `global` → 可见（`global` 记忆管理面代表「全部」）；
 *  3. 作用域精确相等 → 可见（**精确**，不是前缀也不是后缀：`project:/a/b` 与
 *     `project:/backup/a/b` 是两个项目，后缀匹配会让它们互读）；
 *  4. `includeGlobal` 未关且目标是 global → 可见；
 *  5. 否则不可见。
 */
export function isMemoryVisibleInScope(
  target: MemoryScopeTarget,
  input: MemoryScopeVisibilityInput
): boolean {
  const selector = resolveMemoryScopeSelector(input)
  if (!selector || selector === GLOBAL_MEMORY_SCOPE) return true
  if (target.scopeId?.trim() === selector) return true
  if (isFalse(input.includeGlobal)) return false
  return target.scopeType === 'global' || target.scopeId?.trim() === GLOBAL_MEMORY_SCOPE
}
