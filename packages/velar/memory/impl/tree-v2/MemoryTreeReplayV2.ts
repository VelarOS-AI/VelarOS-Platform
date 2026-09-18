import { isNotNull, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  MemoryTreeDiffV2,
  MemoryTreeNodeStructV2,
  MemoryTreeReplayResultV2,
  ReplayTreeDiffsBackwardOptionsV2,
  ReplayTreeDiffsForwardOptionsV2,
} from '../../types/tree-v2/diff.js'
import {
  applyTreeDiffOpV2,
  canonicalStringifyV2,
  cloneTreeNodeV2,
  hashTreeStateV2,
  invertTreeDiffV2,
  toSortedTreeNodesV2,
  validateTreeDiffOpV2,
} from '../../utils/tree-v2/diff-chain.js'

/**
 * TreeDiff 链的正反向重放，以及「这份状态能不能写回持久化」的裁决（INV-BR）。
 *
 * 重放结果本身是纯数据（`MemoryTreeReplayResultV2`）：能不能持久化不看它的字段，
 * 而看本类的登记表——只有本进程 `replayForward` 亲手产出、且起点可追溯到同样合格的
 * 正向结果的那些对象才在册。伪造 `direction: 'forward'`、展开复制、JSON 往返都不在册。
 * 登记表是 `WeakSet`，结果被回收时自动出表；整个进程共用一份，所以本类可以随建随用。
 */
export interface MemoryTreeReplayV2Api {
  /**
   * 从 initial 沿 diff 链正向重放，返回排好序的节点与状态哈希。
   * 链的 baseVersion 接不上抛 INTERNAL；strict 下现场与事件 before 不符也抛 INTERNAL。
   */
  replayForward(
    initial: readonly MemoryTreeNodeStructV2[],
    diffs: readonly MemoryTreeDiffV2[],
    options?: ReplayTreeDiffsForwardOptionsV2
  ): MemoryTreeReplayResultV2
  /**
   * 从当前视图沿链逆向重建历史状态；结果永远不具备持久化资格。
   * 求逆后的事件不再满足创作期语义不变量，所以只做现场一致性核对。
   */
  replayBackward(
    current: readonly MemoryTreeNodeStructV2[],
    diffs: readonly MemoryTreeDiffV2[],
    options?: ReplayTreeDiffsBackwardOptionsV2
  ): MemoryTreeReplayResultV2
  /**
   * INV-BR：物化视图、检查点、基点与候选写回都要先过这一关。
   * 不在登记表里（逆向重建、伪造、来源不明）一律抛 INVARIANT。
   */
  assertForwardResultForPersistence(result: MemoryTreeReplayResultV2): void
}

export class MemoryTreeReplayV2 implements MemoryTreeReplayV2Api {
  /**
   * 有持久化资格的正向重放结果登记表。进程级唯一，弱引用不拖住结果对象。
   * 品牌只进不出：登记发生在 `replayForward` 内部，没有别的写入口。
   */
  private static readonly EligibleForwardResults = new WeakSet<MemoryTreeReplayResultV2>()

  public replayForward(
    initial: readonly MemoryTreeNodeStructV2[],
    diffs: readonly MemoryTreeDiffV2[],
    options: ReplayTreeDiffsForwardOptionsV2 = {}
  ): MemoryTreeReplayResultV2 {
    const base = options.persistenceBase
    const eligible =
      initial.length === 0 ||
      (!isUndefined(base) &&
        base.direction === 'forward' &&
        MemoryTreeReplayV2.EligibleForwardResults.has(base) &&
        canonicalStringifyV2(initial) === canonicalStringifyV2(base.nodes))
    let state: ReadonlyMap<string, MemoryTreeNodeStructV2> = new Map(
      initial.map((node) => [node.stableKey, cloneTreeNodeV2(node)])
    )
    let expectedBase: Nullable<number> = null
    for (const diff of diffs) {
      if (isNotNull(expectedBase) && diff.baseVersion !== expectedBase) {
        throw new AppError(
          'INTERNAL',
          `TreeDiff v2 链断裂：v${diff.version} 基线为 ${diff.baseVersion}，期望 ${expectedBase}。`
        )
      }
      for (const op of diff.ops) {
        if (options.validateOps ?? true) validateTreeDiffOpV2(op)
        state = applyTreeDiffOpV2(state, op, { strict: options.strict })
      }
      expectedBase = diff.version
    }
    const nodes = toSortedTreeNodesV2(state)
    const result: MemoryTreeReplayResultV2 = {
      nodes,
      stateHash: hashTreeStateV2(nodes),
      direction: 'forward',
    }
    if (eligible) MemoryTreeReplayV2.EligibleForwardResults.add(result)
    return result
  }

  public replayBackward(
    current: readonly MemoryTreeNodeStructV2[],
    diffs: readonly MemoryTreeDiffV2[],
    options: ReplayTreeDiffsBackwardOptionsV2 = {}
  ): MemoryTreeReplayResultV2 {
    const inverted = [...diffs]
      .sort((left, right) => right.version - left.version)
      .map((diff) => invertTreeDiffV2(diff))
    const replayed = this.replayForward(current, inverted, {
      ...options,
      validateOps: false,
    })
    return { nodes: replayed.nodes, stateHash: replayed.stateHash, direction: 'backward' }
  }

  public assertForwardResultForPersistence(result: MemoryTreeReplayResultV2): void {
    if (
      result.direction !== 'forward' ||
      !MemoryTreeReplayV2.EligibleForwardResults.has(result)
    ) {
      throw new AppError('INVARIANT', 'INV-BR：逆向重建或来源不明的树状态禁止进入持久化写路径。')
    }
  }

}
