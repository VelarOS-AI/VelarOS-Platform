import { createHash } from 'node:crypto'

import { isObject, isString,toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { MemoryTreeNodeRecord } from './Types'

export type MemoryTreeDiffOp =
  | { type: 'add' | 'update' | 'move'; node: MemoryTreeDiffNode; previousParentId?: LooseOptional<string> }
  | { type: 'remove'; stableKey: string }

export type MemoryTreeDiffNode = Omit<MemoryTreeNodeRecord, 'projectionVersion'>

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function comparableTreeNode(node: MemoryTreeNodeRecord): MemoryTreeDiffNode {
  return {
    id: node.id,
    stableKey: node.stableKey,
    parentId: node.parentId,
    nodeType: node.nodeType,
    namespace: node.namespace,
    title: node.title,
    summary: node.summary,
    subjectType: node.subjectType,
    subjectId: node.subjectId,
    mainlineScore: Number(node.mainlineScore.toFixed(6)),
    confidence: Number(node.confidence.toFixed(6)),
    firstSeenAt: node.firstSeenAt,
    lastActiveAt: node.lastActiveAt,
    activation: Number(node.activation.toFixed(6)),
    visibilityState: node.visibilityState,
  }
}

export function hashTreeNodes(nodes: readonly MemoryTreeNodeRecord[]): string {
  const canonical = nodes
    .map(comparableTreeNode)
    .sort((left, right) => left.stableKey.localeCompare(right.stableKey))
  return sha256(JSON.stringify(canonical))
}

export function hashTreeEvent(input: {
  previousEventHash: string
  version: number
  ops: readonly MemoryTreeDiffOp[]
}): string {
  return sha256(
    JSON.stringify({
      domain: 'velaros.memory.tree-diff.v1',
      previousEventHash: input.previousEventHash,
      version: input.version,
      ops: input.ops,
    })
  )
}

export function buildTreeOps(
  previous: readonly MemoryTreeNodeRecord[],
  next: readonly MemoryTreeNodeRecord[]
): MemoryTreeDiffOp[] {
  const previousByKey = new Map(previous.map((node) => [node.stableKey, node]))
  const nextByKey = new Map(next.map((node) => [node.stableKey, node]))
  const ops: MemoryTreeDiffOp[] = []

  for (const node of next) {
    const before = previousByKey.get(node.stableKey)
    if (!before) {
      ops.push({ type: 'add', node: comparableTreeNode(node) })
      continue
    }
    const beforeComparable = comparableTreeNode(before)
    const afterComparable = comparableTreeNode(node)
    if (JSON.stringify(beforeComparable) !== JSON.stringify(afterComparable)) {
      ops.push({
        type: before.parentId === node.parentId ? 'update' : 'move',
        node: afterComparable,
        previousParentId: before.parentId,
      })
    }
  }
  for (const node of previous) {
    if (!nextByKey.has(node.stableKey)) ops.push({ type: 'remove', stableKey: node.stableKey })
  }
  return ops
}

export function applyTreeOps(
  current: readonly MemoryTreeNodeRecord[],
  ops: readonly MemoryTreeDiffOp[],
  version: number
): MemoryTreeNodeRecord[] {
  const byKey = new Map(current.map((node) => [node.stableKey, node]))
  for (const op of ops) {
    if (op.type === 'remove') {
      byKey.delete(op.stableKey)
      continue
    }
    byKey.set(op.node.stableKey, { ...op.node, projectionVersion: version })
  }
  return [...byKey.values()].sort((left, right) => left.stableKey.localeCompare(right.stableKey))
}

export function validateTreeProjection(
  nodes: readonly MemoryTreeNodeRecord[],
  anchors: { rootNodeId: string; globalMainlineNodeId: string }
): void {
  const ids = new Set<string>()
  const stableKeys = new Set<string>()
  const byId = new Map<string, MemoryTreeNodeRecord>()
  let rootCount = 0
  let trunkCount = 0

  for (const node of nodes) {
    if (ids.has(node.id)) throw new AppError('INTERNAL', `记忆树存在重复节点 id：${node.id}`)
    if (stableKeys.has(node.stableKey)) {
      throw new AppError('INTERNAL', `记忆树存在重复稳定键：${node.stableKey}`)
    }
    ids.add(node.id)
    stableKeys.add(node.stableKey)
    byId.set(node.id, node)
    if (node.nodeType === 'root') rootCount += 1
    if (node.nodeType === 'trunk') trunkCount += 1
  }
  if (rootCount !== 1 || trunkCount !== 1) {
    throw new AppError('INTERNAL', `记忆树必须恰好包含一个根和一个主干；当前 ${rootCount}/${trunkCount}`)
  }
  if (!byId.has(anchors.rootNodeId) || !byId.has(anchors.globalMainlineNodeId)) {
    throw new AppError('INTERNAL', '记忆树快照锚点未出现在投影节点中。')
  }

  for (const node of nodes) {
    if (node.parentId && !byId.has(node.parentId)) {
      throw new AppError('INTERNAL', `记忆树节点缺少父节点：${node.stableKey}`)
    }
    const visited = new Set<string>()
    let cursor: Nullable<MemoryTreeNodeRecord> = node
    while (cursor?.parentId) {
      if (visited.has(cursor.id)) {
        throw new AppError('INTERNAL', `记忆树存在环：${node.stableKey}`)
      }
      visited.add(cursor.id)
      cursor = toNullable(byId.get(cursor.parentId))
    }
  }
}

export function isMemoryTreeDiffOp(value: unknown): value is MemoryTreeDiffOp {
  if (!isObject(value)) return false
  const record = value as Record<string, unknown>
  if (!isString(record.type)) return false
  if (record.type === 'remove') return isString(record.stableKey)
  if (!['add', 'update', 'move'].includes(record.type) || !isObject(record.node)) return false
  const node = record.node as Record<string, unknown>
  return isString(node.id) && isString(node.stableKey) && isString(node.nodeType)
}
