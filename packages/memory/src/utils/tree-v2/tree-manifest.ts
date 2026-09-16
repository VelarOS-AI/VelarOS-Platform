import { createHash } from 'node:crypto'

import { isArray, isNull, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { MemoryTreeNodeStructV2 } from '../../types/tree-v2/diff'
import type {
  MemoryTreeBaseHashesV2,
  MemoryTreeBaseManifestV2,
  MemoryTreeBaseStateV2,
} from '../../types/tree-v2/store'

import { assertPositiveSafeIntegerV2, compareCodeUnitV2, isStrictRecordV2 } from './checks'
import {
  canonicalStringifyV2,
  hashTreeBaseEventV2,
  hashTreeStateV2,
  isMemoryTreeNodeStructV2,
} from './diff-chain'

/** 基点清单哈希的域分隔串。 */
const MemoryTreeBaseManifestDomainV2 = 'velaros.memory.tree-base-manifest.v2'
/** 基点状态 blob 的格式身份。 */
export const MemoryTreeBaseStateFormatV2 = 'velaros.memory.tree-base-state.v2'

/** 由一组节点算出基点清单：节点键、去重的 blob 引用、redact 名册与两个计数。 */
export function buildMemoryTreeBaseManifestV2(
  baseVersion: number,
  nodes: readonly MemoryTreeNodeStructV2[]
): MemoryTreeBaseManifestV2 {
  assertPositiveSafeIntegerV2(baseVersion, '物化基点版本')
  const sortedNodes = sortNodesV2(nodes)
  const nodeStableKeys = sortedNodes.map((node) => node.stableKey)
  if (new Set(nodeStableKeys).size !== nodeStableKeys.length) {
    throw new AppError('VALIDATION', '物化基点 manifest 存在重复 stableKey。')
  }
  const blobRefs = [
    ...new Set(
      sortedNodes.flatMap((node) => (isNull(node.content.blobRef) ? [] : [node.content.blobRef]))
    ),
  ].sort(compareCodeUnitV2)
  const redactedStableKeys = sortedNodes
    .filter((node) => node.content.redacted || node.visibilityState === 'redacted')
    .map((node) => node.stableKey)

  return {
    format: 'velaros.memory.tree-base-manifest.v2',
    baseVersion,
    nodeStableKeys,
    blobRefs,
    redactedStableKeys,
    nodeCount: nodeStableKeys.length,
    redactedCount: redactedStableKeys.length,
  }
}

/** 对基点清单算 sha256（带域分隔）。 */
export function hashMemoryTreeBaseManifestV2(manifest: MemoryTreeBaseManifestV2): string {
  return createHash('sha256')
    .update(
      canonicalStringifyV2({
        domain: MemoryTreeBaseManifestDomainV2,
        manifest,
      })
    )
    .digest('hex')
}

/** 把一组节点整理成基点状态 blob 的内容（节点排序 + 配套清单）。 */
export function buildMemoryTreeBaseStateV2(
  baseVersion: number,
  nodes: readonly MemoryTreeNodeStructV2[]
): MemoryTreeBaseStateV2 {
  const sortedNodes = sortNodesV2(nodes)
  return {
    format: MemoryTreeBaseStateFormatV2,
    baseVersion,
    nodes: sortedNodes,
    manifest: buildMemoryTreeBaseManifestV2(baseVersion, sortedNodes),
  }
}

/** 算基点的三个哈希锚点，算之前先自检状态与清单一致。 */
export function computeMemoryTreeBaseHashesV2(
  state: MemoryTreeBaseStateV2,
  priorSegmentEventHead: string
): MemoryTreeBaseHashesV2 {
  validateMemoryTreeBaseStateV2(state)
  const treeHash = hashTreeStateV2(state.nodes)
  const manifestHash = hashMemoryTreeBaseManifestV2(state.manifest)
  return {
    treeHash,
    manifestHash,
    baseEventHash: hashTreeBaseEventV2({
      baseVersion: state.baseVersion,
      treeHash,
      priorSegmentEventHead,
      manifestHash,
    }),
  }
}

/** 严格解析基点状态 blob：格式、内容自洽与 canonical 字节三关都要过。 */
export function parseMemoryTreeBaseStateV2(raw: Buffer | string): MemoryTreeBaseStateV2 {
  const source = isString(raw) ? raw : raw.toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new AppError('VALIDATION', '物化基点 state blob 不是合法 JSON。', error)
  }
  if (!isMemoryTreeBaseStateV2(parsed)) {
    throw new AppError('VALIDATION', '物化基点 state blob 不符合 v2 严格格式。')
  }
  validateMemoryTreeBaseStateV2(parsed)
  if (source !== canonicalStringifyV2(parsed)) {
    throw new AppError('INVARIANT', '物化基点 state blob 不是规范 canonical 字节。')
  }
  return parsed
}

/** 自检基点状态：按它的节点重建一遍，字节必须完全一致。 */
export function validateMemoryTreeBaseStateV2(state: MemoryTreeBaseStateV2): void {
  assertPositiveSafeIntegerV2(state.baseVersion, '物化基点版本')
  const rebuilt = buildMemoryTreeBaseStateV2(state.baseVersion, state.nodes)
  if (canonicalStringifyV2(rebuilt) !== canonicalStringifyV2(state)) {
    throw new AppError('INVARIANT', '物化基点 manifest 与节点集合不一致或排序不规范。')
  }
}

/** 基点状态 blob 的运行时守卫：顶层与清单的键集、类型都要对上。 */
function isMemoryTreeBaseStateV2(value: unknown): value is MemoryTreeBaseStateV2 {
  if (!isStrictRecordV2(value, ['baseVersion', 'format', 'manifest', 'nodes'])) return false
  if (
    value['format'] !== MemoryTreeBaseStateFormatV2 ||
    !Number.isSafeInteger(value['baseVersion']) ||
    (value['baseVersion'] as number) < 1 ||
    !isArray(value['nodes']) ||
    !value['nodes'].every(isMemoryTreeNodeStructV2) ||
    !isStrictRecordV2(value['manifest'], [
      'baseVersion',
      'blobRefs',
      'format',
      'nodeCount',
      'nodeStableKeys',
      'redactedCount',
      'redactedStableKeys',
    ])
  )
    return false
  const manifest = value['manifest']
  return (
    manifest['format'] === 'velaros.memory.tree-base-manifest.v2' &&
    manifest['baseVersion'] === value['baseVersion'] &&
    isArray(manifest['blobRefs']) &&
    manifest['blobRefs'].every((entry) => isString(entry)) &&
    isArray(manifest['nodeStableKeys']) &&
    manifest['nodeStableKeys'].every((entry) => isString(entry)) &&
    isArray(manifest['redactedStableKeys']) &&
    manifest['redactedStableKeys'].every((entry) => isString(entry)) &&
    Number.isSafeInteger(manifest['nodeCount']) &&
    Number.isSafeInteger(manifest['redactedCount'])
  )
}

/** 把节点按 stableKey 的码元序排好。 */
function sortNodesV2(nodes: readonly MemoryTreeNodeStructV2[]): MemoryTreeNodeStructV2[] {
  return [...nodes].sort((left, right) => compareCodeUnitV2(left.stableKey, right.stableKey))
}



