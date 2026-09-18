import type { MemoryTreeReplayResultV2 } from '../../types/tree-v2/diff.js'
import type {
  MemoryTreeCheckpointV2,
  MemoryTreeProjectionArtifactV2,
  MemoryTreeProjectionInspectionV2,
} from '../../types/tree-v2/store.js'
import { assertPositiveSafeIntegerV2 } from '../../utils/tree-v2/checks.js'
import { canonicalStringifyV2 } from '../../utils/tree-v2/diff-chain.js'
import { readCurrentGenerationV2 } from '../../utils/tree-v2/storage/generation-pointer.js'
import {
  openCurrentMemoryIndexGenerationV2,
  pruneMemoryIndexGenerationsV2,
  sealMemoryIndexGenerationV2,
} from '../../utils/tree-v2/storage/index-generation.js'
import {
  parseTreeProjectionArtifactV2,
  TreeProjectionArtifactFormatV2,
} from '../../utils/tree-v2/tree-store.js'

import type { MemoryKeyringStoreV2Api } from './storage/MemoryKeyringStoreV2.js'
import type { MemoryTreeReplayV2Api } from './MemoryTreeReplayV2.js'

/**
 * 当前树物化视图与检查点缓存的派生存储 owner：一个 index 目录一份实例。
 *
 * authority 的正向链永远是事实源；本层损坏、缺失或落后都只触发重建，绝不反向污染权威。
 * 实例归 `MemoryTreeStoreV2` 所有，与它共用同一份密钥环。
 */
export interface MemoryTreeProjectionIndexV2Api {
  /**
   * 把当前树与检查点封成新的一代派生索引，返回新代号，并清掉旧代。
   * 传进来的重放结果必须是本进程正向产出的（INV-BR），否则抛 INVARIANT。
   */
  persist(
    treeVersion: number,
    current: MemoryTreeReplayResultV2,
    checkpoints: readonly MemoryTreeCheckpointV2[]
  ): number
  /**
   * 解开当前派生代，核对它与权威链是否一致；一代都没有返回 null。
   * 派生代损坏会抛 VALIDATION / INVARIANT，调用方按"不匹配"处理即可。
   */
  inspect(
    treeVersion: number,
    authority: MemoryTreeReplayResultV2
  ): Nullable<MemoryTreeProjectionInspectionV2>
}

export class MemoryTreeProjectionIndexV2 implements MemoryTreeProjectionIndexV2Api {
  constructor(
    private readonly indexDir: string,
    private readonly keyring: MemoryKeyringStoreV2Api,
    private readonly replay: MemoryTreeReplayV2Api
  ) {}

  public persist(
    treeVersion: number,
    current: MemoryTreeReplayResultV2,
    checkpoints: readonly MemoryTreeCheckpointV2[]
  ): number {
    assertPositiveSafeIntegerV2(treeVersion, '树投影版本')
    this.replay.assertForwardResultForPersistence(current)
    for (const checkpoint of checkpoints) {
      assertPositiveSafeIntegerV2(checkpoint.version, '树投影版本')
      this.replay.assertForwardResultForPersistence(checkpoint.replay)
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
    assertPositiveSafeIntegerV2(treeVersion, '树投影版本')
    this.replay.assertForwardResultForPersistence(authority)
    const opened = openCurrentMemoryIndexGenerationV2(this.indexDir, this.keyring)
    if (!opened) return null
    try {
      const artifact = parseTreeProjectionArtifactV2(opened.plaintextArtifact)
      return {
        generation: opened.generation,
        matchesAuthority:
          artifact.treeVersion === treeVersion &&
          artifact.treeHash === authority.stateHash &&
          canonicalStringifyV2(artifact.nodes) === canonicalStringifyV2(authority.nodes),
        checkpointCount: artifact.checkpoints.length,
      }
    } finally {
      opened.plaintextArtifact.fill(0)
    }
  }
}
