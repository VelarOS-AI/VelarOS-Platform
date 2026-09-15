/**
 * 事务暂存视图：`TransactionOverlay`。接口 `TransactionOverlayApi` 与注入回调 `TransactionOverlayDependencies` 在本文件的类上方。
 * 把事务的补丁按顺序重放成「内存里的未来文件内容」，供 validator、fixer 在写盘前看到暂存态；补丁链的判定在 `utils/transactions/patch-chain.ts`。
 */

import { isNull } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { toOptional } from '@velaros-ai/core/utils/nullish'

import type { Diagnostic } from '../../types/common.js'
import type { PreparedPatch } from '../../types/edit.js'
import type { FileAttributes } from '../../types/snapshot.js'
import type { StagedFileContent, TransactionContentOverlay } from '../../types/transaction.js'
import { patchFileAttributes } from '../../utils/transactions/patch-attributes.js'
import { isCreatePatch, stagedContentAfter, withoutStagedOffsets } from '../../utils/transactions/patch-chain.js'

/** 暂存视图要内核注入的两个回调：语言感知的补丁重新推导，与工作区读取。 */
export interface TransactionOverlayDependencies {
  /** 基于前一补丁产出的暂存正文重新推导后继补丁；无法安全推导时返回 null。 */
  readonly rebasePatchAgainstContent: (
    patch: PreparedPatch,
    stagedContent: string,
  ) => Promise<Nullable<PreparedPatch>>
  /** overlay 未触碰路径时回退到工作区当前正文。 */
  readonly readWorkspaceFile: (path: string) => Promise<string | undefined>
}

/**
 * 事务补丁的纯暂存视图。
 *
 * 只负责补丁顺序语义与读取覆盖，不查询事务仓库、不执行文件 IO，也不决定 rebase 策略；
 * 内核注入的两个回调保留工作区读取与语言感知补丁推导边界。实例由内核持有，一个内核一份。
 */
export interface TransactionOverlayApi {
  /**
   * 把同一路径的后继补丁衔接到前一补丁的产出（staged）上：新建补丁直接重建路径，原样返回；前一补丁删掉了文件的返回 null；
   * 补丁原文正好等于暂存正文时原样返回；否则请内核基于暂存正文重新推导，推导不出返回 null，推导出的补丁去掉失效的策略坐标。
   * 重新推导抛出的错误原样抛出。
   */
  chainPatch(patch: PreparedPatch, staged: StagedFileContent): Promise<Nullable<PreparedPatch>>
  /**
   * 按补丁顺序构造事务的未来内容：每个路径的暂存正文（null 表示已删除）和文件属性。
   * 某个路径衔接失败或重放抛错时记一条 core.transaction-replay 诊断，继续检查其余路径，不抛出。
   */
  build(patches?: readonly PreparedPatch[]): Promise<TransactionContentOverlay>
  /** 造一个读文件函数：暂存内容优先，暂存为删除（null）读成 undefined 而不回退磁盘，没暂存的路径读工作区当前正文。 */
  createReader(contentByPath: ReadonlyMap<string, StagedFileContent>): (path: string) => Promise<string | undefined>
}

export class TransactionOverlay implements TransactionOverlayApi {
  public constructor(private readonly dependencies: TransactionOverlayDependencies) {}

  /**
   * 将同一路径的后继补丁衔接到前一补丁产出。创建补丁可以直接重建路径；删除后的其它补丁
   * 无法衔接。只有补丁链断开时才请求 Kernel 基于暂存正文重新推导。
   */
  public async chainPatch(
    patch: PreparedPatch,
    staged: StagedFileContent,
  ): Promise<Nullable<PreparedPatch>> {
    if (isCreatePatch(patch)) return patch
    if (isNull(staged)) return null
    if (patch.oldContent === staged) return patch
    const rebased = await this.dependencies.rebasePatchAgainstContent(patch, staged)
    return rebased ? withoutStagedOffsets(rebased) : null
  }

  /** 按补丁顺序构造事务未来内容；失败诊断归档后继续检查其余路径。 */
  public async build(patches: readonly PreparedPatch[] = []): Promise<TransactionContentOverlay> {
    const contentByPath = new Map<string, StagedFileContent>()
    const diagnostics: Diagnostic[] = []
    const attributesByPath = new Map<string, FileAttributes>()

    for (const patch of patches) {
      let chained: Nullable<PreparedPatch>
      try {
        chained = contentByPath.has(patch.path)
          ? await this.chainPatch(patch, contentByPath.get(patch.path)!)
          : patch
      } catch (error) {
        // arch-guard:silent-catch-ok 重放失败归档为 transaction diagnostic，由 validate / amend 统一报告。
        diagnostics.push({
          severity: 'error',
          path: patch.path,
          source: 'core.transaction-replay',
          message: `重放同一文件的后续补丁失败：${AppError.getMessage(error)}`,
        })
        continue
      }
      if (!chained) {
        diagnostics.push({
          severity: 'error',
          path: patch.path,
          source: 'core.transaction-replay',
          message: '同一文件的后续补丁无法衔接到前面补丁的结果上，事务不能按顺序重放。',
          data: { patchId: patch.patchId, operation: patch.metadata?.op },
        })
        continue
      }
      contentByPath.set(patch.path, stagedContentAfter(chained))
      attributesByPath.set(patch.path, patchFileAttributes(chained))
    }

    return { contentByPath, attributesByPath, diagnostics }
  }

  /** overlay 优先读取；null 表示事务已删除文件，必须读成 undefined 而不是回退磁盘。 */
  public createReader(
    contentByPath: ReadonlyMap<string, StagedFileContent>,
  ): (path: string) => Promise<string | undefined> {
    return async (path) => {
      if (contentByPath.has(path)) return toOptional(contentByPath.get(path))
      return this.dependencies.readWorkspaceFile(path)
    }
  }
}
