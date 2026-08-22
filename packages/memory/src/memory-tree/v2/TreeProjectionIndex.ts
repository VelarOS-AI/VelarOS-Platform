import { isArray, isNotNull, isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { readCurrentGenerationV2 } from './storage/GenerationPointer'
import {
  openCurrentMemoryIndexGenerationV2,
  pruneMemoryIndexGenerationsV2,
  sealMemoryIndexGenerationV2,
} from './storage/IndexGenerationStore'
import type { MemoryKeyringStoreV2 } from './storage/Keyring'
import {
  assertForwardReplayResultForPersistenceV2,
  canonicalStringifyV2,
  hashTreeStateV2,
  isMemoryTreeNodeStructV2,
  type MemoryTreeNodeStructV2,
  type MemoryTreeReplayResultV2,
} from './DiffChain'

const TreeProjectionArtifactFormatV2 = 'velaros.memory.tree-projection-index.v2'
export const MemoryTreeCheckpointIntervalV2 = 64

export interface MemoryTreeCheckpointV2 {
  readonly version: number
  readonly replay: MemoryTreeReplayResultV2
}

interface PersistedMemoryTreeCheckpointV2 {
  readonly version: number
  readonly treeHash: string
  readonly nodes: readonly MemoryTreeNodeStructV2[]
}

interface MemoryTreeProjectionArtifactV2 {
  readonly format: typeof TreeProjectionArtifactFormatV2
  readonly treeVersion: number
  readonly treeHash: string
  readonly nodes: readonly MemoryTreeNodeStructV2[]
  readonly checkpoints: readonly PersistedMemoryTreeCheckpointV2[]
}

export interface MemoryTreeProjectionInspectionV2 {
  readonly generation: number
  readonly matchesAuthority: boolean
  readonly checkpointCount: number
}

/**
 * 当前树物化视图与 checkpoint cache 的派生存储 owner。
 * authority 正向链永远是事实源；本层损坏、缺失或落后只触发重建。
 */
export class MemoryTreeProjectionIndexV2 {
  constructor(
    private readonly indexDir: string,
    private readonly keyring: MemoryKeyringStoreV2
  ) {}

  public persist(
    treeVersion: number,
    current: MemoryTreeReplayResultV2,
    checkpoints: readonly MemoryTreeCheckpointV2[]
  ): number {
    assertTreeVersionV2(treeVersion)
    assertForwardReplayResultForPersistenceV2(current)
    for (const checkpoint of checkpoints) {
      assertTreeVersionV2(checkpoint.version)
      assertForwardReplayResultForPersistenceV2(checkpoint.replay)
    }

    const artifact: MemoryTreeProjectionArtifactV2 = {
      format: TreeProjectionArtifactFormatV2,
      treeVersion,
      treeHash: current.stateHash,
      nodes: current.nodes,
      checkpoints: [...checkpoints]
        .sort((left, right) => left.version - right.version)
        .map((checkpoint) => ({
          version: checkpoint.version,
          treeHash: checkpoint.replay.stateHash,
          nodes: checkpoint.replay.nodes,
        })),
    }
    const currentGeneration = readCurrentGenerationV2(this.indexDir)
    const nextGeneration = (currentGeneration ?? 0) + 1
    sealMemoryIndexGenerationV2(
      this.indexDir,
      nextGeneration,
      Buffer.from(canonicalStringifyV2(artifact), 'utf8'),
      this.keyring
    )
    pruneMemoryIndexGenerationsV2(this.indexDir, this.keyring)
    return nextGeneration
  }

  public inspect(
    treeVersion: number,
    authority: MemoryTreeReplayResultV2
  ): Nullable<MemoryTreeProjectionInspectionV2> {
    assertTreeVersionV2(treeVersion)
    assertForwardReplayResultForPersistenceV2(authority)
    const opened = openCurrentMemoryIndexGenerationV2(this.indexDir, this.keyring)
    if (!opened) return null
    try {
      const artifact = parseTreeProjectionArtifactV2(opened.plaintextArtifact)
      const matchesAuthority =
        artifact.treeVersion === treeVersion &&
        artifact.treeHash === authority.stateHash &&
        canonicalStringifyV2(artifact.nodes) === canonicalStringifyV2(authority.nodes)
      return {
        generation: opened.generation,
        matchesAuthority,
        checkpointCount: artifact.checkpoints.length,
      }
    } finally {
      opened.plaintextArtifact.fill(0)
    }
  }
}

function parseTreeProjectionArtifactV2(raw: Buffer): MemoryTreeProjectionArtifactV2 {
  const source = raw.toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new AppError('VALIDATION', '树投影派生代不是合法 JSON。', error)
  }
  if (
    !isStrictRecordV2(parsed, ['checkpoints', 'format', 'nodes', 'treeHash', 'treeVersion']) ||
    parsed['format'] !== TreeProjectionArtifactFormatV2 ||
    !Number.isSafeInteger(parsed['treeVersion']) ||
    (parsed['treeVersion'] as number) < 1 ||
    !isString(parsed['treeHash']) ||
    !/^[0-9a-f]{64}$/.test(parsed['treeHash']) ||
    !isArray(parsed['nodes']) ||
    !parsed['nodes'].every(isMemoryTreeNodeStructV2) ||
    !isArray(parsed['checkpoints'])
  ) {
    throw new AppError('VALIDATION', '树投影派生代不符合 v2 严格格式。')
  }
  const checkpoints: PersistedMemoryTreeCheckpointV2[] = []
  for (const candidate of parsed['checkpoints']) {
    if (
      !isStrictRecordV2(candidate, ['nodes', 'treeHash', 'version']) ||
      !Number.isSafeInteger(candidate['version']) ||
      (candidate['version'] as number) < 1 ||
      !isString(candidate['treeHash']) ||
      !/^[0-9a-f]{64}$/.test(candidate['treeHash']) ||
      !isArray(candidate['nodes']) ||
      !candidate['nodes'].every(isMemoryTreeNodeStructV2)
    ) {
      throw new AppError('VALIDATION', '树投影 checkpoint 不符合 v2 严格格式。')
    }
    if (hashTreeStateV2(candidate['nodes']) !== candidate['treeHash']) {
      throw new AppError('INVARIANT', '树投影 checkpoint 状态哈希失配。')
    }
    checkpoints.push({
      version: candidate['version'] as number,
      treeHash: candidate['treeHash'],
      nodes: candidate['nodes'],
    })
  }
  if (hashTreeStateV2(parsed['nodes']) !== parsed['treeHash']) {
    throw new AppError('INVARIANT', '树投影派生代当前状态哈希失配。')
  }
  if (source !== canonicalStringifyV2(parsed)) {
    throw new AppError('INVARIANT', '树投影派生代不是规范 canonical 字节。')
  }
  return {
    format: TreeProjectionArtifactFormatV2,
    treeVersion: parsed['treeVersion'] as number,
    treeHash: parsed['treeHash'],
    nodes: parsed['nodes'],
    checkpoints,
  }
}

function assertTreeVersionV2(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new AppError('VALIDATION', '树投影版本必须是正整数。', undefined, {
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
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
