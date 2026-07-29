// 域：执行 span 树结构与派生（宪章 §11 span 模型的读侧；parentSpanId 树形指针）。
//
// 账本是一串带 parentSpanId 的已完成 span；本文件把它投影成可查询的执行树（run → turn → tool/model/
// capability/policy），供 get_debug / agent-lab / 未来 UI 执行时间线三消费面装配。纯函数、无 IO——引擎读回与
// harness 共用。**孤儿容忍**：活读时父 span（如尚未收敛的 run）可能还没落盘，其子 span 暂列 orphanIds
// 而非丢弃，让消费面拿到尽力而为的部分树而非崩溃。
import { isNotNull, isNull } from '@velaros-ai/core'

import type { ExecutionSpan } from '../../protocol'

/** 树节点：一条 span + 其子 span id（按 startedAt 升序，tie-break spanId）。 */
export interface ExecutionSpanTreeNode {
  span: ExecutionSpan
  childIds: string[]
}

/** 执行 span 树投影：根集合、按 id 索引的节点、孤儿集合。 */
export interface ExecutionSpanTree {
  /** parentSpanId 为 null 的顶层 span（通常是 run span），按 startedAt 升序。 */
  rootIds: string[]
  nodesById: Record<string, ExecutionSpanTreeNode>
  /** parentSpanId 指向账本中不存在 span 的孤儿（活读时父未落盘），按 startedAt 升序。 */
  orphanIds: string[]
}

/** 稳定比较器：先 startedAt 升序，等值按 spanId 字典序，保证投影确定性。 */
function compareSpans(
  nodesById: Record<string, ExecutionSpanTreeNode>,
  aId: string,
  bId: string
): number {
  const a = nodesById[aId].span
  const b = nodesById[bId].span
  if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt
  return a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0
}

/** 从 span 序列构建执行树投影。 */
export function buildExecutionSpanTree(spans: readonly ExecutionSpan[]): ExecutionSpanTree {
  const nodesById: Record<string, ExecutionSpanTreeNode> = {}
  for (const span of spans) nodesById[span.spanId] = { span, childIds: [] }

  const rootIds: string[] = []
  const orphanIds: string[] = []
  for (const span of spans) {
    if (isNull(span.parentSpanId)) {
      rootIds.push(span.spanId)
      continue
    }
    const parent = nodesById[span.parentSpanId]
    if (parent) {
      parent.childIds.push(span.spanId)
      continue
    }
    orphanIds.push(span.spanId)
  }

  for (const node of Object.values(nodesById)) {
    node.childIds.sort((a, b) => compareSpans(nodesById, a, b))
  }
  rootIds.sort((a, b) => compareSpans(nodesById, a, b))
  orphanIds.sort((a, b) => compareSpans(nodesById, a, b))

  return { rootIds, nodesById, orphanIds }
}

/** 从任一 span 回溯到其根的路径（根→叶有序），断链时防御性收束。 */
export function spanPathToRoot(
  tree: ExecutionSpanTree,
  spanId: string
): ExecutionSpan[] {
  const reversed: ExecutionSpan[] = []
  const seen = new Set<string>()
  let cursor: Nullable<string> = spanId
  while (isNotNull(cursor) && !seen.has(cursor)) {
    const node: ExecutionSpanTreeNode | undefined = tree.nodesById[cursor]
    if (!node) break
    seen.add(cursor)
    reversed.push(node.span)
    cursor = node.span.parentSpanId
  }
  return reversed.reverse()
}
