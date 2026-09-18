/**
 * 记忆包自持序列化作用域身份；宿主决定哪个产品上下文映射到哪个作用域，经适配器把解析
 * 好的值传进来。
 */
import { isFalse } from '@velaros-ai/core'

import { MemoryScopeIds, MemoryScopePrefixes } from '../contract/constants.js'
import type {
  MemoryScopeId,
  MemoryScopeSelectorInput,
  MemoryScopeTarget,
  MemoryScopeType,
  MemoryScopeVisibilityInput,
} from '../types/memory.js'

export { MemoryScopeIds, MemoryScopePrefixes } from '../contract/constants.js'
export type {
  MemoryScopeId,
  MemoryScopeSelectorInput,
  MemoryScopeTarget,
  MemoryScopeVisibilityInput,
} from '../types/memory.js'

/** 前缀 → 作用域种类。`session:` 与 `execution:` 是类型里一直有、函数从前从不返回的两种。 */
const ScopeTypeByPrefix: ReadonlyArray<readonly [string, MemoryScopeType]> = [
  [MemoryScopePrefixes.project, 'workspace'],
  [MemoryScopePrefixes.site, 'site'],
  [MemoryScopePrefixes.session, 'session'],
  [MemoryScopePrefixes.execution, 'execution'],
]

/**
 * 作用域 id 是哪一种作用域。
 *
 * **`global` 只认字面的 `global`（以及空串）**：从前除 `project:`、`site:`、`system` 之外一律
 * 判 `global`，而 `global` 在可见性判据里处处可见——宿主一传 `session:<id>`，那条记忆就对所有
 * 会话可见。隔离判据失败开放是最坏的一种失败，认不出的前缀因此按**独立池**处理：与 `system`
 * 一样自成一类，只有作用域精确相等才可见。
 */
export function scopeTypeForScopeId(
  scopeId: LooseOptional<string>
): MemoryScopeType {
  const normalized = scopeId?.trim() ?? ''
  for (const [prefix, scopeType] of ScopeTypeByPrefix) {
    if (normalized.startsWith(prefix)) return scopeType
  }
  if (!normalized || normalized === MemoryScopeIds.global) return 'global'
  return 'system'
}

/** 工作区根 → 项目作用域 id；根为空时回落到系统池（不落进别人的池子）。 */
export function buildProjectMemoryScope(
  root: LooseOptional<string>
): MemoryScopeId {
  const normalized = root?.trim()
  return normalized ? `${MemoryScopePrefixes.project}${normalized}` : MemoryScopeIds.system
}

/** 站点源 → 站点作用域 id；源为空时回落到系统池。 */
export function buildSiteMemoryScope(
  origin: LooseOptional<string>
): MemoryScopeId {
  const normalized = origin?.trim()
  return normalized ? `${MemoryScopePrefixes.site}${normalized}` : MemoryScopeIds.system
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

/**
 * 作用域过滤的**参数形态**：给按行过滤（SQL、索引扫描）的后端用。
 *
 * 空串 = 不加作用域条件。选定作用域是 `global` 时同样返回空串——`global` 在唯一判据里代表
 * 「全部」，而树后端的 SQL 自己写过一份 `scope_id = ? OR scope_type = 'global'`，选定 global
 * 时只剩 global 条目。判据分成两份写就一定会走偏，参数从这里取。
 */
export function resolveMemoryScopeFilterValue(
  input: MemoryScopeSelectorInput
): MemoryScopeId {
  const selector = resolveMemoryScopeSelector(input)
  return selector === MemoryScopeIds.global ? '' : selector
}

/**
 * 「这条记忆在当前两轴下可不可见」—— **全仓唯一判据**。
 *
 * 真值表（自上而下短路）：
 *  1. 两轴皆空 → 可见（无过滤）；
 *  2. 选定作用域 = `global` → 可见（`global` 记忆管理面代表「全部」）；
 *  3. 作用域精确相等 → 可见（**精确**，不是前缀也不是后缀：`project:/a/b` 与
 *     `project:/backup/a/b` 是两个项目，后缀匹配会让它们互读）；
 *  4. `includeGlobal` 未关且目标**就是** global 池 → 可见；
 *  5. 否则不可见。
 *
 * 第 4 条按 **scopeId** 裁决，不按 scopeType：scopeId 在场即权威（`inferEvidenceScope` 同此），
 * 而 scopeType 是从它派生出来的一格，历史上把认不出的前缀派生成了 `global`——按 scopeType 放行
 * 等于让一格派生错误直接变成跨空间泄漏。没有 scopeId 的目标才回落看 scopeType。
 */
export function isMemoryVisibleInScope(
  target: MemoryScopeTarget,
  input: MemoryScopeVisibilityInput
): boolean {
  const selector = resolveMemoryScopeSelector(input)
  if (!selector || selector === MemoryScopeIds.global) return true
  const targetScopeId = target.scopeId?.trim() ?? ''
  if (targetScopeId === selector) return true
  if (isFalse(input.includeGlobal)) return false
  return targetScopeId
    ? targetScopeId === MemoryScopeIds.global
    : target.scopeType === 'global'
}
