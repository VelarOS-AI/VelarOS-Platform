import { createHash } from 'node:crypto'

import { isArray, isNotNull, isNull, isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  canonicalStringifyV2,
  hashTreeBaseEventV2,
  hashTreeStateV2,
  isMemoryTreeNodeStructV2,
  type MemoryTreeNodeStructV2,
} from './DiffChain'

const MemoryTreeBaseManifestDomainV2 = 'velaros.memory.tree-base-manifest.v2'
export const MemoryTreeBaseStateFormatV2 = 'velaros.memory.tree-base-state.v2'

export interface MemoryTreeBaseManifestV2 {
  readonly format: 'velaros.memory.tree-base-manifest.v2'
  readonly baseVersion: number
  readonly nodeStableKeys: readonly string[]
  readonly blobRefs: readonly string[]
  readonly redactedStableKeys: readonly string[]
  readonly nodeCount: number
  readonly redactedCount: number
}

export interface MemoryTreeBaseStateV2 {
  readonly format: typeof MemoryTreeBaseStateFormatV2
  readonly baseVersion: number
  readonly nodes: readonly MemoryTreeNodeStructV2[]
  readonly manifest: MemoryTreeBaseManifestV2
}

export interface MemoryTreeBaseHashesV2 {
  readonly treeHash: string
  readonly manifestHash: string
  readonly baseEventHash: string
}

export function buildMemoryTreeBaseManifestV2(
  baseVersion: number,
  nodes: readonly MemoryTreeNodeStructV2[]
): MemoryTreeBaseManifestV2 {
  assertBaseVersionV2(baseVersion)
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

export function validateMemoryTreeBaseStateV2(state: MemoryTreeBaseStateV2): void {
  assertBaseVersionV2(state.baseVersion)
  const rebuilt = buildMemoryTreeBaseStateV2(state.baseVersion, state.nodes)
  if (canonicalStringifyV2(rebuilt) !== canonicalStringifyV2(state)) {
    throw new AppError('INVARIANT', '物化基点 manifest 与节点集合不一致或排序不规范。')
  }
}

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

function sortNodesV2(nodes: readonly MemoryTreeNodeStructV2[]): MemoryTreeNodeStructV2[] {
  return [...nodes].sort((left, right) => compareCodeUnitV2(left.stableKey, right.stableKey))
}

function compareCodeUnitV2(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertBaseVersionV2(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new AppError('VALIDATION', '物化基点版本必须是正整数。', undefined, {
      version,
    })
  }
}

function isStrictRecordV2(
  value: unknown,
  expectedKeys: readonly string[]
): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && isNotNull(prototype)) return false
  const actualKeys = Object.keys(value).sort()
  const sortedExpected = [...expectedKeys].sort()
  return (
    actualKeys.length === sortedExpected.length &&
    actualKeys.every((key, index) => key === sortedExpected[index])
  )
}
