/**
 * 四个操作用的记忆规则：缺省隐私级、工作区根推断、跨作用域读门，以及过读门地读一条。执行在 `impl/MemoryOperations.ts`。
 */

import { AppError } from '@velaros-ai/core/error'

import type { MemoryOperationContext } from '../contract/requires.js'
import type { MemoryKind, MemoryPrivacyClass, MemoryRecallItem } from '../types/memory.js'

import { isMemoryVisibleInScope, MemoryScopePrefixes } from './scope.js'

/** 默认落 personal 隐私级的类别：这几类天然是关于用户本人的。 */
const PersonalCategories: readonly string[] = ['preference', 'feedback']

/** 这个类别缺省落哪个隐私级。 */
export function defaultPrivacyClassFor(category: MemoryKind): MemoryPrivacyClass {
  return PersonalCategories.includes(category) ? 'personal' : 'standard'
}

/** 推断这次调用的工作区根：显式给的优先，否则从当前项目作用域反解。 */
export function inferWorkspaceRoot(
  explicitRoot: LooseOptional<string>,
  memoryScope: LooseOptional<string>,
): string {
  const explicit = explicitRoot?.trim()
  if (explicit) return explicit
  const scope = memoryScope?.trim() ?? ''
  return scope.startsWith(MemoryScopePrefixes.project)
    ? scope.slice(MemoryScopePrefixes.project.length)
    : ''
}

// @arch-guard:suspend code-style/require-chinese-comments 理由：本块为中文说明，反引号内技术标识符密度触发启发式误报。
/**
 * 跨作用域读门 —— **全仓唯一一处**。
 *
 * 召回本身已按当前空间收敛（search 传 scopeId）；get 收的是模型手里的一个
 * id，没有这道门就等于「拿到任何 id 都能跨项目/跨站点读全文」。global 作用域的记忆按设计
 * 处处可读，`global` 记忆管理面（memoryScope = global）则代表「全部」，两者都放行。
 *
 * 判据本身住 `isMemoryVisibleInScope`（两轴单源），这里只把操作的上下文喂进去：读门与后端
 * 过滤必须是同一条真值表，否则「search 看不见但 get 读得到」就是一个可利用的越界口。
 * get 只有会话身份轴（模型给的是 id，不是根），因此不传 workspaceRoot。
 */
export function isMemoryReadableInScope(
  item: MemoryRecallItem,
  memoryScope: LooseOptional<string>,
): boolean {
  return isMemoryVisibleInScope(item, { scopeId: memoryScope })
}

/** 按 id 读一条，过跨作用域读门：越界与不存在回同一个 NOT_FOUND——分开回等于把「这条存在但不属于你」泄漏出去。 */
export async function readVisibleMemory(id: string, ctx: MemoryOperationContext): Promise<MemoryRecallItem> {
  const memory = await ctx.memory.getMemory(id)
  if (!memory || !isMemoryReadableInScope(memory, ctx.memoryScope)) throw new AppError('NOT_FOUND', `记忆不存在：${id}`)
  return memory
}
