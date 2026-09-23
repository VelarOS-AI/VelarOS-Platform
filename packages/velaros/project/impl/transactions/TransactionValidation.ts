/**
 * 事务校验：`TransactionValidation`。接口 `TransactionValidationApi` 与注入回调 `TransactionValidationDependencies` 在本文件的类上方。
 * 在事务的未来内容上跑已登记的 validator 和文件 adapter 的校验；validator 看到的只读视图由 `utils/transactions/validation-views.ts` 构造。
 */

import { isEmpty, isNull, isString, optionalWhen } from '@velaros-ai/core'

import type { CommandProvider, FileAdapter, ProjectProviders } from '../../contract/requires.js'
import type { CorePolicy } from '../../types/policy.js'
import type { FileSnapshot } from '../../types/snapshot.js'
import type {
  StagedFileContent,
  StoredTransaction,
  TransactionContentOverlay,
} from '../../types/transaction.js'
import type {
  ProjectValidationContext,
  ValidateInput,
  ValidationResult,
} from '../../types/validation.js'
import {
  validationPolicyView,
  validationProvidersView,
  validationTransactionView,
} from '../../utils/transactions/validation-views.js'

/** 事务校验要内核注入的东西：根目录、策略、宿主能力，以及读事务、重放暂存内容、跑登记的 validator、造快照与 adapter 的回调。 */
export interface TransactionValidationDependencies {
  /** 项目根目录的绝对路径，原样放进校验上下文。 */
  readonly root: string
  /** 内核策略；给 validator 的是冻结后的副本。 */
  readonly policy: CorePolicy
  /** 宿主能力（命令能力一定在）；给 validator 的是只读代理。 */
  readonly providers: ProjectProviders & { command: CommandProvider }
  /** 按事务号取内存里的事务；没有返回 undefined。 */
  readonly getTransaction: (transactionId: string) => StoredTransaction | undefined
  /** 把事务的补丁按顺序重放成未来内容（没给事务号时是空视图），带重放失败的诊断。 */
  readonly buildOverlay: (transactionId?: string) => Promise<TransactionContentOverlay>
  /** 造一个读文件函数：暂存内容优先，暂存为删除读成 undefined，没暂存的读工作区。 */
  readonly createReader: (
    contentByPath: ReadonlyMap<string, StagedFileContent>
  ) => (path: string) => Promise<string | undefined>
  /** 在给定上下文里跑全部已登记、被本次 checks 选中的 validator，汇总结果。 */
  readonly validateRegistered: (
    input: ValidateInput,
    context: ProjectValidationContext
  ) => Promise<ValidationResult>
  /** 为一个文件快照创建能处理它的 adapter，按优先级排好。 */
  readonly createAdapters: (snapshot: FileSnapshot) => Promise<readonly FileAdapter[]>
  /** 用暂存正文造该路径的快照（revision 带 staged: 前缀）。 */
  readonly snapshotStaged: (path: string, content: string) => Promise<FileSnapshot>
  /** 读工作区里该路径的当前快照。 */
  readonly snapshotWorkspace: (path: string) => Promise<FileSnapshot>
}

/**
 * 在事务未来视图（无事务时为当前工作区）上组合 validator 与文件 adapter 校验。
 *
 * 只负责计算 ValidationResult，不推进事务状态、不做权限决策，也不发布 hook、审计或 ChangeFeed；事务生命周期由内核统一控制。
 * 实例由内核持有，一个内核一份。
 */
export interface TransactionValidationApi {
  /**
   * 跑一次校验：先在只读上下文里跑登记的 validator，事务重放失败时追加 core.transaction-replay 检查，
   * 再对 paths（缺省为事务的改动文件）逐个用 adapter 校验暂存内容（没暂存的用工作区内容，暂存为删除的跳过）。
   * ok 要求 validator、全部检查都通过且没有 error 级诊断；validator、adapter 抛出的错误原样抛出。
   */
  run(input: ValidateInput): Promise<ValidationResult>
}

export class TransactionValidation implements TransactionValidationApi {
  public constructor(private readonly dependencies: TransactionValidationDependencies) {}

  public async run(input: ValidateInput): Promise<ValidationResult> {
    const overlay = await this.dependencies.buildOverlay(input.transactionId)
    const context: ProjectValidationContext = Object.freeze({
      root: this.dependencies.root,
      policy: validationPolicyView(this.dependencies.policy),
      providers: validationProvidersView(this.dependencies.providers),
      getTransaction: (transactionId: string) =>
        validationTransactionView(this.dependencies.getTransaction(transactionId)),
      readFile: this.dependencies.createReader(overlay.contentByPath),
    })
    const result = await this.dependencies.validateRegistered(input, context)
    let allPassed = result.ok

    if (!isEmpty(overlay.diagnostics)) {
      result.diagnostics.push(...overlay.diagnostics)
      result.checks.push({
        id: 'core.transaction-replay',
        ok: false,
        diagnostics: overlay.diagnostics,
      })
    }

    const paths =
      input.paths ??
      (input.transactionId
        ? (this.dependencies.getTransaction(input.transactionId)?.changedFiles ?? [])
        : [])
    for (const path of paths) {
      const hasStagedContent = overlay.contentByPath.has(path)
      const stagedContent = optionalWhen(hasStagedContent, overlay.contentByPath.get(path))
      if (isNull(stagedContent)) continue
      const snapshot = isString(stagedContent)
        ? await this.dependencies.snapshotStaged(path, stagedContent)
        : await this.dependencies.snapshotWorkspace(path)
      for (const adapter of await this.dependencies.createAdapters(snapshot)) {
        if (!adapter.validate) continue
        const adapterResult = await adapter.validate({
          snapshot,
          transactionId: input.transactionId,
          changedContent: stagedContent,
        })
        allPassed = allPassed && adapterResult.ok
        result.diagnostics.push(...adapterResult.diagnostics)
        result.checks.push(...adapterResult.checks)
      }
    }

    return {
      ...result,
      ok:
        allPassed &&
        result.checks.every((check) => check.ok) &&
        result.diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    }
  }
}
