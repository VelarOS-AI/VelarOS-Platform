// 域：会话树结构与派生（宪章 §6 会话树 entry 类型学；parentId 树形指针 + CompactionEntry 边界）。
//
// 账本是一串带 parentId 的 entry；本文件把它投影成可查询的树，并从任一叶子回溯到根，尊重
// CompactionEntry 边界拼出发给 provider 的上下文序列。纯函数、无 IO——供引擎 handle 与 harness 共用。
import { isEmpty, isNotNull, isNull } from '@velaros-ai/core'

import type { CompactionEntry, SessionEntry } from '../../types/agent.js'
import type { SessionEntryClass, SessionTree,SessionTreeNode } from '../../types/ledgers.js'


/** entry → 分类（判别联合穷举，新增 entry 类型时此处编译期强制补分类）。 */
export function classifySessionEntry(entry: SessionEntry): SessionEntryClass {
  switch (entry.type) {
    case 'message':
    case 'custom-message':
      return 'transcript'
    case 'compaction':
    case 'branch-summary':
      return 'governance'
    case 'session-info':
    case 'model-change':
    case 'custom':
      return 'metadata'
  }
}

/**
 * 是否进 provider 上下文序列（transcript + governance）。
 *
 * governance 走 buildContextEntries 的折叠/顶替逻辑；metadata（session-info / model-change / custom）一律不进。
 */
export function isProviderContextEntry(entry: SessionEntry): boolean {
  return classifySessionEntry(entry) !== 'metadata'
}

/**
 * 是否参与「与 renderer 快照直投的逐字节对照」（= 快照投影能产出的形状）。
 *
 * 快照投影只产 transcript（message）与 custom（非 wire 块，归 metadata 类里的 custom）——即**非 governance**：
 * 排除 compaction/branch-summary（账本对快照的超集增补）与 session-info/model-change（账本独有的会话头/元数据）。
 * 剩 message / custom-message / custom 与快照投影产物同集，可对齐比较。
 */
export function isSnapshotComparableEntry(entry: SessionEntry): boolean {
  const cls = classifySessionEntry(entry)
  if (cls === 'governance') return false
  // metadata 里只有 custom 是快照投影会产出的（thinking/html-artifact 等非 wire 块）；session-info/model-change 是账本独有。
  if (cls === 'metadata') return entry.type === 'custom'
  return true
}

/** 从 entry 序列构建树投影。 */
export function buildSessionTree(entries: readonly SessionEntry[]): SessionTree {
  const nodesById: Record<string, SessionTreeNode> = {}
  for (const entry of entries) nodesById[entry.id] = { entry, childIds: [] }

  let rootId: Nullable<string> = null
  for (const entry of entries) {
    if (isNull(entry.parentId)) {
      rootId = rootId ?? entry.id
      continue
    }
    const parent = nodesById[entry.parentId]
    if (parent) parent.childIds.push(entry.id)
  }

  const leafIds = entries.filter((entry) => isEmpty(nodesById[entry.id].childIds)).map((e) => e.id)
  return { rootId, nodesById, leafIds }
}

/**
 * 当前叶子 = 最后追加的 entry。
 *
 * append-only 账本里，文件末尾那条 entry 之后没有任何 entry 以它为父，故必是叶子，且是「当前位置」。
 * 空账本返回 null。
 */
export function resolveCurrentLeafId(entries: readonly SessionEntry[]): Nullable<string> {
  if (isEmpty(entries)) return null
  return entries[entries.length - 1].id
}

/**
 * 从叶子回溯到根的路径，返回**根→叶**有序序列。
 *
 * parentId 断链（指向不存在的 entry）或成环时提前收束——账本理应无环，此处只做防御性收束不抛错，
 * 让上层拿到尽力而为的路径而非崩溃。
 */
export function pathRootToLeaf(entries: readonly SessionEntry[], leafId: Nullable<string>): SessionEntry[] {
  if (isNull(leafId)) return []
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const reversed: SessionEntry[] = []
  const seen = new Set<string>()
  let cursor: Nullable<string> = leafId
  while (isNotNull(cursor) && !seen.has(cursor)) {
    const entry = byId.get(cursor)
    if (!entry) break
    seen.add(cursor)
    reversed.push(entry)
    cursor = entry.parentId
  }
  return reversed.reverse()
}

/**
 * 从当前叶子回溯到根，拼出发给 provider 的上下文 entry 序列，尊重 CompactionEntry 边界。
 *
 * 被某条路径上 CompactionEntry `replacedEntryIds` 命中的 entry 从上下文剔除，其摘要在**最早一条被替换
 * entry 的位置**顶上（压缩通常压前缀，故摘要自然落在序列前部，时序自洽）。路径外的 CompactionEntry
 * 不影响本上下文（只收集路径上的压缩边界）。
 */
export function buildContextEntries(
  entries: readonly SessionEntry[],
  leafId: Nullable<string>
): SessionEntry[] {
  const path = pathRootToLeaf(entries, leafId)

  const replacedToCompaction = new Map<string, CompactionEntry>()
  for (const entry of path) {
    if (entry.type !== 'compaction') continue
    for (const replacedId of entry.replacedEntryIds) replacedToCompaction.set(replacedId, entry)
  }

  const emittedCompactionIds = new Set<string>()
  const context: SessionEntry[] = []
  for (const entry of path) {
    const owningCompaction = replacedToCompaction.get(entry.id)
    if (owningCompaction) {
      if (!emittedCompactionIds.has(owningCompaction.id)) {
        context.push(owningCompaction)
        emittedCompactionIds.add(owningCompaction.id)
      }
      continue // 被压缩的 entry 从上下文剔除，由摘要顶上
    }
    if (entry.type === 'compaction') {
      if (emittedCompactionIds.has(entry.id)) continue // 已在最早被替换位置顶上，勿重复
      context.push(entry)
      emittedCompactionIds.add(entry.id)
      continue
    }
    // 分类单源（P1-5）：metadata（session-info 头 / model-change / custom）不进 provider 上下文——
    // 堵住 session-info 头 entry 漏进转录序列的洞。transcript + 其余 governance 照进。
    if (!isProviderContextEntry(entry)) continue
    context.push(entry)
  }
  return context
}
