// 域：项目内核——把「一次编辑意图」变成「可预览、可校验、可回滚的磁盘写入」的事务机器。
//
// **为什么需要这份导览**：本文件是四条互相咬合的机制的交汇处（事务生命周期 / 写锁 / 多文件
// 原子性 / rebase），任一条单独读都会得出错误结论——比如只看 `applyEdit` 会以为写盘失败就
// 完了，实际它带一层逆序还原。
//
// ## 组织（读的顺序）
//  1. `prepareTransaction` → 意图 → 补丁，**不碰磁盘**；规模/受保护文件门在这里；
//  2. `buildTransactionContentOverlay` → 把已暂存补丁重放成"内存中的未来文件内容"，供
//     validator / fixer 在写盘前看到暂存态；
//  3. `applyEdit` → 取写锁 → 每个路径的首个补丁校验 base revision（不匹配则试 rebase，rebase
//     后在锁内复核校验）→ 写盘；
//  4. `rollback` → 逆序还原；`discardTransaction` → 丢弃未应用事务。
//
// ## 事务状态机（`StoredTransaction.status`）
// 事务从准备态进入已校验态，再进入已应用态；回滚后进入已回滚态，丢弃则从表中移除。
// `rolled_back` 可以再 `applyEdit` 一次（"重做"路径，见 `isRestoringRolledBackTransaction`）；
// `applied` 不能重复 apply，也不能 amend/discard。**终态事务不删，只按 LRU 淘汰**，因为
// rollback 需要它的 `patches[].oldContent`。
//
// ## 关键不变量（改这些会破什么）
//  - **同一路径的补丁首尾相接**：事务内对同一文件的后一个补丁以前一个补丁的 `newContent`
//    为 `oldContent`（prepare 在暂存快照上生成补丁，天然首尾相接；暂存重放与 apply 预检用
//    `chainPatch` 这唯一一条规则核对或重新推导），所以
//    校验看到的、写盘写下的、diff 描述的是同一份最终内容。若让每个补丁各自基于原文生成，
//    顺序整文件写入会让最后一个补丁覆盖前面的改动——静默丢改动。「同一路径」按规范化后的
//    根相对路径判定（`canonicalPath`），`./x`、绝对路径与 `x` 是同一个 key。
//  - **写锁覆盖 `tx.changedFiles` 全集，且 apply/rollback 全程持锁**：锁按路径粒度、公平排队
//    （见 lock-manager）。锁只在**进程内**有效——它防的是同一内核的并发事务互相踩，不防外部
//    编辑器；外部编辑靠 base revision 检查兜。
//  - **base revision 不匹配 → 先试 rebase，再失败才抛**：只有 `QueueRebaseFriendlyOperations`
//    里那些"靠锚点定位、不依赖绝对偏移"的操作允许 rebase。把 `create_file`/`delete_file`
//    放进这个集合会让"文件已被别人改过"被静默覆盖。
//  - **多文件写入原子化有两档**：宿主提供 `transactionStatePath` 时，写盘前先提交可恢复计划，
//    进程中断后由下一次 owner 启动恢复；不能完整捕获旧正文的事务在写前拒绝。无 durable state
//    的嵌入式调用仍靠 `captureApplyRestoreState` + 逆序还原，并保留旧的二进制/超限告警边界。
//  - **「能否恢复」只有一条判据 `canRevertToOriginal`**：写入前不存在的新建补丁（撤销 = 删除），
//    或补丁捕获到了原文 `oldContent`（撤销 = 写回原文）。回滚前置预检、风险分级、Desktop
//    PreviewCache 的按路径回退共用这一口径，改一处必须三处同改。它成立的前提是「字符串
//    `oldContent` 一定是真原文」：读不到正文的文件上的局部编辑由 `assertEditsReadOriginal` 在
//    prepare 拒绝，删除/重命名写回时沿用原文件的文本编码（`textEncoding`）。
//  - **`rollback` 有前置全量预检**：任何补丁不满足 `canRevertToOriginal` 就整体拒绝。少了这一步，
//    `patch.oldContent ?? ""` 会把文件截断成空——静默丢数据是这里最坏的失败模式。
//  - **回滚删文件只针对写入前不存在的路径**（`createsMissingFile`）：`create_file` 覆盖既有文件时
//    补丁记下原文与 base revision，回滚写回原文；把它当新建删掉会永久丢失原文。
//  - **风险按能否恢复划线，不按操作名**：能完整回滚的覆盖、删除、重命名都是日常写入，只按新建/规模
//    分 low/medium；只有回滚恢复不了原文的补丁（二进制、超限文件的覆盖/删除，删除符号链接）才是 high。
//    把可恢复写入重新划成 high，会让宿主按路径逐个文件打断用户审批。
//  - **`decide` 是唯一策略/审批门**：provider 可直接拒，也可要求审批；高风险补丁按
//    `policy.approval.requireForHighRiskPatch` 再走一次人审。绕过 `decide` 直接调 `store` = 无审批写盘。
//    `rollback` 本身不走高风险审批：它有外部修改保护，且回滚后可以重做，属于可恢复操作。
//
// ## 内存治理（为什么有一堆 Max* 常量）
// 内核在长会话里常驻，`targets` / `evidence` / `transactions` 都是只增 Map。四个上限按插入顺序
// 淘汰最旧项；正常 prepare→apply 流程永远不会淘汰到刚写入的事务。
import * as path from 'node:path'

import {
  isArray,
  isEmpty,
  isFalse,
  isNull,
  isPresent,
  isString,
  isUndefined,
  optionalWhen,
  toOptional,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { runBatch } from '../batch/runner.js'
import { ProjectError } from '../errors.js'
import { HookRegistry } from '../hooks/registry.js'
import { type AuditEvent, AuditJournal } from '../persistence/audit-journal.js'
import {
  MemoryProjectChangeFeed,
  type ProjectChangeFeed,
  type ProjectChangeFeedWriter,
  type ProjectChangeLifecycle,
  projectChangePatches,
  type ProjectChangeRecordInput,
  type ProjectChangeRevision,
} from '../persistence/change-feed.js'
import {
  FileProjectTransactionStateStore,
  type ProjectTransactionPendingOperation,
} from '../persistence/transaction-state.js'
import { PipelineRegistry } from '../pipeline/registry.js'
import { corePlugin } from '../plugins/core.js'
import { createNodeCommandProvider } from '../providers/index.js'
import { AdapterRegistry } from '../registry/adapter-registry.js'
import { FixerRegistry } from '../registry/fixer-registry.js'
import { PatchStrategyRegistry } from '../registry/patch-registry.js'
import { PluginRegistry, type RegistrySink } from '../registry/plugin-registry.js'
import { ValidatorRegistry } from '../registry/validator-registry.js'
import { patchFileAttributes, withPatchFileAttributes } from '../transactions/patch-attributes.js'
import { diagnosticsEnvelope } from '../transactions/transaction-errors.js'
import { TransactionPlanner } from '../transactions/transaction-planner.js'
import type { FileAdapterFactory, ProjectSymbol } from '../types/adapter.js'
import type { BatchInput, BatchMetrics, BatchResult } from '../types/batch.js'
import type { DiffResult, ProjectStatus } from '../types/common.js'
import type { BuildEvidencePackInput, EvidencePack, TaskContext } from '../types/context.js'
import type {
  AmendEditInput,
  ApplyEditInput,
  ApplyResult,
  EditIntent,
  PreparedTransaction,
  PrepareEditInput,
  RollbackInput,
  RollbackResult,
} from '../types/edit.js'
import type { FixInput, FixResult, ProjectFixer } from '../types/fix.js'
import type { ProjectHook } from '../types/hook.js'
import type {
  FileListEntry,
  FileStatInput,
  FileStatResult,
  ObserveInput,
  ReadInput,
  ReadResult,
  SearchInput,
  SearchResult,
} from '../types/io.js'
import type { PatchStrategy } from '../types/patch.js'
import type { PipelineStage } from '../types/pipeline.js'
import type { ProjectPlugin } from '../types/plugin.js'
import type { CorePolicy, PolicyDecisionInput } from '../types/policy.js'
import type { FileAttributes, FileSnapshot, ProjectSnapshot } from '../types/snapshot.js'
import type { ResolveTargetInput, ResolveTargetResult } from '../types/target.js'
import type { StoredTransaction } from '../types/transaction.js'
import type { ProjectValidator, ValidateInput, ValidationResult } from '../types/validation.js'
import { combineDiffs } from '../utils/diff.js'

export type { StoredTransaction } from '../types/transaction.js'

import { FileStore } from '../files/file-store.js'
import { ProjectGitIndex } from '../files/git-index.js'
import { ProjectQueries } from '../files/project-queries.js'
import { LockManager } from '../transactions/lock-manager.js'
import {
  canRevertToOriginal,
  createsMissingFile,
} from '../transactions/patch-ownership.js'
import { type ApplyRestoreState, durableRestorePlan } from '../transactions/recovery-plan.js'
import { TransactionCoordinator } from '../transactions/transaction-coordinator.js'
import { revisionMismatch, validationFailed } from '../transactions/transaction-errors.js'
import {
  isCreatePatch,
  isDeletePatch,
  stagedContentAfter,
  type StagedFileContent,
  TransactionOverlay,
} from '../transactions/transaction-overlay.js'
import { TransactionProjectionRepository } from '../transactions/transaction-projection-repository.js'
import { TransactionRecovery } from '../transactions/transaction-recovery.js'
import { TransactionRepository } from '../transactions/transaction-repository.js'
import { TransactionStateMachine } from '../transactions/transaction-state-machine.js'
import { TransactionValidation } from '../transactions/transaction-validation.js'
import type {
  CreateProjectKernelOptions,
  ProjectKernel,
  ProjectRuntimeProviders,
} from '../types/kernel.js'

import { DEFAULT_CORE_POLICY } from './defaults.js'

function cloneStoredTransaction(transaction: StoredTransaction): StoredTransaction {
  return structuredClone(transaction)
}
const MaxRetainedTerminalTransactions = 200
// 全部事务（含已准备未应用的）总量兜底；正常 prepare→apply 不受影响。
const MaxRetainedTransactions = 1000

/** 事务 metadata 里记下的 git 索引路径清单；它随事务状态持久化，读回时只认字符串项。 */
function metadataPaths(value: unknown): string[] {
  return isArray(value) ? value.filter(isString) : []
}

/** 事务安全的项目内核实现，统一协调 IO、适配器、校验和审计 hook。 */
class ProjectKernelImpl implements ProjectKernel, RegistrySink {
  readonly root: string
  readonly policy: CorePolicy
  readonly providers: ProjectRuntimeProviders
  readonly changeFeed: ProjectChangeFeed

  readonly journal = new AuditJournal()
  readonly hooks = new HookRegistry()
  readonly pipelines = new PipelineRegistry()
  readonly plugins = new PluginRegistry()
  readonly adapters = new AdapterRegistry()
  readonly patchStrategies = new PatchStrategyRegistry()
  readonly validators = new ValidatorRegistry()
  readonly fixers = new FixerRegistry()
  readonly locks = new LockManager()
  readonly transactionCoordinator = new TransactionCoordinator()
  readonly transactionStateMachine = new TransactionStateMachine()
  readonly transactionOverlay: TransactionOverlay
  readonly transactionValidation: TransactionValidation
  readonly transactionRepository = new TransactionRepository({
    maxTransactions: MaxRetainedTransactions,
    maxTerminalTransactions: MaxRetainedTerminalTransactions,
  })
  readonly transactionProjectionRepository = new TransactionProjectionRepository({
    maxProjections: MaxRetainedTransactions,
  })
  readonly store: FileStore
  private readonly planner: TransactionPlanner
  private readonly queries: ProjectQueries
  private readonly gitIndex: ProjectGitIndex
  private readonly transactionRecovery: TransactionRecovery
  private readonly changeFeedWriter: ProjectChangeFeedWriter
  private readonly transactionState?: FileProjectTransactionStateStore
  // 批处理工作池观测：当前在跑的批次数 + 最近一次批次的指标。
  private runningBatches = 0
  private lastBatchMetrics?: BatchMetrics

  constructor(options: CreateProjectKernelOptions) {
    this.root = path.resolve(options.root)
    this.policy = {
      ...DEFAULT_CORE_POLICY,
      ...(options.corePolicy ?? {}),
      approval: { ...DEFAULT_CORE_POLICY.approval, ...(options.corePolicy?.approval ?? {}) },
    }
    this.providers = {
      ...(options.providers ?? {}),
      command: options.providers?.command ?? createNodeCommandProvider(),
    }
    this.changeFeedWriter = options.changeFeed ?? new MemoryProjectChangeFeed()
    this.changeFeed = this.changeFeedWriter
    this.store = new FileStore(
      this.root,
      this.policy,
      this.providers.fileFilter,
      this.providers.command,
    )
    this.gitIndex = new ProjectGitIndex({ root: this.root, providers: this.providers })
    this.transactionRecovery = new TransactionRecovery({ store: this.store })
    this.queries = new ProjectQueries({
      root: this.root,
      policy: this.policy,
      providers: this.providers,
      store: this.store,
      journal: this.journal,
      decide: (action, paths, data) => this.decide(action, paths, data),
      enrichSnapshot: (snapshot) => this.enrichSnapshot(snapshot),
      createAdapters: (snapshot) => this.adapters.createAdapters(snapshot, this),
      emit: (event, data) => this.hooks.emit(event, this, data),
      transform: (phase, input) => this.pipelines.run(phase, input, this),
    })
    this.planner = new TransactionPlanner({
      root: this.root,
      policy: this.policy,
      store: this.store,
      enrichSnapshot: (snapshot) => this.enrichSnapshot(snapshot),
      getTarget: (targetId) => this.queries.getTarget(targetId),
      transform: (input) => this.pipelines.run('prepare.input', input, this),
      createAdapters: (snapshot) => this.adapters.createAdapters(snapshot, this),
      selectStrategy: (input) => this.patchStrategies.select(input),
    })
    this.transactionOverlay = new TransactionOverlay({
      rebasePatchAgainstContent: async (patchValue, stagedContent) =>
        this.planner.tryRebasePatch(
          patchValue,
          await this.planner.snapshotWithContent(patchValue.path, stagedContent),
        ),
      readWorkspaceFile: async (pathValue) => (await this.read({ path: pathValue })).content,
    })
    this.transactionValidation = new TransactionValidation({
      root: this.root,
      policy: this.policy,
      providers: this.providers,
      getTransaction: (transactionId) => this.transactionRepository.get(transactionId),
      buildOverlay: (transactionId) => this.buildTransactionContentOverlay(transactionId),
      createReader: (contentByPath) => this.transactionOverlay.createReader(contentByPath),
      validateRegistered: (input, context) => this.validators.validate(input, context),
      createAdapters: (snapshot) => this.adapters.createAdapters(snapshot, this),
      snapshotStaged: (pathValue, content) => this.planner.snapshotWithContent(pathValue, content),
      snapshotWorkspace: async (pathValue) =>
        this.enrichSnapshot(await this.store.snapshot(pathValue, true)),
    })
    if (options.transactionStatePath) {
      this.transactionState = new FileProjectTransactionStateStore({
        path: options.transactionStatePath,
        root: this.root,
      })
      const durable = this.transactionState.snapshot()
      this.transactionRepository.hydrate(durable.transactions, (transaction) =>
        this.transactionStateMachine.isTerminal(transaction.status),
      )
      this.transactionProjectionRepository.hydrate(durable.projections)
    }
  }

  private transactionStateValues(): StoredTransaction[] {
    return [...this.transactionRepository.values()]
  }

  private transactionProjectionValues(): ProjectChangeRecordInput[] {
    return [...this.transactionProjectionRepository.values()]
  }

  /** 事务淘汰必须同步删除 durable 投影；ChangeFeed 自身仍保留独立审计历史。 */
  private deleteEvictedTransactionProjections(transactionIds: readonly string[]): void {
    for (const transactionId of transactionIds) {
      this.transactionProjectionRepository.delete(transactionId)
    }
  }

  private addTransaction(transaction: StoredTransaction): void {
    this.deleteEvictedTransactionProjections(this.transactionRepository.add(transaction))
  }

  private retainTerminalTransaction(transactionId: string): void {
    this.deleteEvictedTransactionProjections(
      this.transactionRepository.retainTerminal(transactionId),
    )
  }

  private persistTransactionState(pending?: ProjectTransactionPendingOperation): void {
    this.transactionState?.commit({
      transactions: this.transactionStateValues(),
      projections: this.transactionProjectionValues(),
      pending,
    })
  }

  /**
   * apply/rollback 的文件与主状态已经提交后，Git 元数据或内存淘汰只属于附带治理。
   * 它们的二次快照失败不能把一个已经成功落盘的事务伪装成失败。
   */
  private persistCommittedTransactionState(transactionId: string, reason: string): void {
    try {
      this.persistTransactionState()
    } catch (error) {
      this.providers.logger?.warn?.('project.transactionState.postCommit.failed', {
        transactionId,
        reason,
        error: AppError.getMessage(error),
      })
    }
  }

  private transactionChangeProjection(
    tx: StoredTransaction,
    lifecycle: ProjectChangeLifecycle,
    newIntents: readonly EditIntent[] = [],
    revisions?: readonly ProjectChangeRevision[],
  ): ProjectChangeRecordInput {
    const previous =
      this.transactionProjectionRepository.get(tx.transactionId) ??
      this.changeFeedWriter.get(tx.transactionId)
    const intents = [...(previous?.intents ?? []), ...newIntents]
    const reasons = [...new Set(intents.map((intent) => intent.reason?.trim()).filter(isPresent))]
    return {
      transactionId: tx.transactionId,
      lifecycle,
      reason: optionalWhen(!isEmpty(reasons), reasons.join('; ')),
      intents,
      patches: projectChangePatches(tx.patches),
      changedFiles: [...tx.changedFiles],
      diff: tx.diff,
      changedLines: tx.changedLines,
      risk: tx.risk,
      revisions:
        revisions ??
        previous?.revisions ??
        tx.baseSnapshots.map((snapshot) => ({
          path: snapshot.path,
          before: snapshot.revision,
        })),
      createdAt: tx.createdAt,
      appliedAt: tx.appliedAt,
    }
  }

  /**
   * 先把事务与最新投影提交到唯一 durable state，再把审计投影追加到 ChangeFeed。
   * feed 故障只降级审计面，不能让它领先于或否定已经提交的事务状态。
   */
  private publishTransactionChange(
    tx: StoredTransaction,
    lifecycle: ProjectChangeLifecycle,
    newIntents: readonly EditIntent[] = [],
    revisions?: readonly ProjectChangeRevision[],
    removeTransaction = false,
  ): void {
    const projection = this.transactionChangeProjection(tx, lifecycle, newIntents, revisions)
    const transactionSnapshot = this.transactionRepository.snapshot()
    const projectionSnapshot = this.transactionProjectionRepository.snapshot()
    this.transactionProjectionRepository.set(projection)
    if (removeTransaction) this.transactionRepository.delete(tx.transactionId)
    this.transactionProjectionRepository.cap((transactionId) =>
      this.transactionRepository.has(transactionId),
    )
    try {
      this.persistTransactionState()
    } catch (error) {
      this.transactionRepository.restore(transactionSnapshot)
      this.transactionProjectionRepository.restore(projectionSnapshot)
      throw error
    }
    try {
      this.changeFeedWriter.record(projection)
    } catch (error) {
      this.providers.logger?.warn?.('project.changeFeed.record.failed', {
        transactionId: tx.transactionId,
        lifecycle,
        error: AppError.getMessage(error),
      })
    }
  }

  private reconcileDurableChangeFeed(): void {
    for (const projection of this.transactionProjectionRepository.values()) {
      const current = this.changeFeedWriter.get(projection.transactionId)
      if (
        current?.lifecycle === projection.lifecycle &&
        current.diff === projection.diff &&
        current.appliedAt === projection.appliedAt
      ) {
        continue
      }
      try {
        this.changeFeedWriter.record(projection)
      } catch (error) {
        this.providers.logger?.warn?.('project.changeFeed.reconcile.failed', {
          transactionId: projection.transactionId,
          lifecycle: projection.lifecycle,
          error: AppError.getMessage(error),
        })
      }
    }
  }

  /** 安装插件，并记录插件接入事件。 */
  public async install(plugin: ProjectPlugin): Promise<void> {
    await this.plugins.install(plugin, this)
    this.journal.record({ actor: 'system', action: 'plugin.install', outputSummary: plugin.name })
  }

  public registerAdapterFactory(factory: FileAdapterFactory): void {
    this.adapters.register(factory)
  }

  public registerPatchStrategy(strategy: PatchStrategy): void {
    this.patchStrategies.register(strategy)
  }

  public registerValidator(validator: ProjectValidator): void {
    this.validators.register(validator)
  }

  public registerFixer(fixer: ProjectFixer): void {
    this.fixers.register(fixer)
  }

  public registerHook(hook: ProjectHook): void {
    this.hooks.register(hook)
  }

  public registerPipelineStage(stage: PipelineStage): void {
    this.pipelines.register(stage)
  }

  private async decide(
    action: PolicyDecisionInput['action'],
    paths?: string[],
    data?: unknown,
    risk: 'low' | 'medium' | 'high' = 'low',
    options?: { skipHighRiskUserApproval?: boolean },
  ): Promise<void> {
    // 策略 provider 可以直接拒绝，也可以要求再走一次审批。
    const providerDecision = await this.providers.policy?.decide({ action, paths, risk, data })
    if (providerDecision && !providerDecision.allow) {
      this.journal.record({
        actor: 'system',
        action: `policy.${action}`,
        inputSummary: paths?.join(','),
        outputSummary: providerDecision.reason,
        permissionDecision: 'deny',
        risk,
      })
      throw new ProjectError(
        'PERMISSION_DENIED',
        providerDecision.reason ?? `策略拒绝执行 ${action}`,
      )
    }
    const needsHighRiskApproval =
      risk === 'high' &&
      this.policy.approval.requireForHighRiskPatch &&
      !options?.skipHighRiskUserApproval
    if (providerDecision?.requireApproval || needsHighRiskApproval) {
      if (!this.providers.approval) {
        throw new ProjectError(
          'PERMISSION_DENIED',
          `${action} 需要审批，但宿主没有提供审批通道`,
          { action, paths, risk },
          '请在有用户审批上下文的宿主中重试，或缩小为非破坏性操作。',
        )
      }
      const approved = await this.providers.approval.approve({
        action,
        paths,
        risk,
        reason: providerDecision?.reason ?? `${action} 需要审批`,
        data,
      })
      if (isFalse(approved)) throw new ProjectError('PERMISSION_DENIED', `${action} 的审批被拒绝`)
    }
  }

  private async authorizePaths(
    paths: LooseOptional<readonly string[]>,
    action: 'read' | 'write' | 'search' | 'observe',
    deniedActionLabel: string,
  ): Promise<LooseOptional<string[]>> {
    if (!paths) return undefined
    const authorized: string[] = []
    for (const pathValue of paths) {
      const access = await this.store.authorize(pathValue, action, deniedActionLabel)
      authorized.push(access.rel)
    }
    return [...new Set(authorized)]
  }

  private async enrichSnapshot(snapshot: FileSnapshot): Promise<FileSnapshot> {
    if (!snapshot.exists || snapshot.isDirectory) return snapshot
    const adapters = await this.adapters.createAdapters(snapshot, this)
    return { ...snapshot, adapterIds: adapters.map((a) => a.id) }
  }
  private async restoreDurableOperation(
    pending: ProjectTransactionPendingOperation,
  ): Promise<void> {
    const tx = this.transactionRepository.get(pending.transactionId)
    if (!tx)
      throw new ProjectError('TRANSACTION_RECOVERY_CONFLICT', '恢复操作引用了不存在的事务', {
        transactionId: pending.transactionId,
      })
    await this.transactionRecovery.restore(pending, tx)
    tx.status = this.transactionStateMachine.restore(pending.previousStatus)
    this.persistTransactionState()
  }

  private beginDurableOperation(
    tx: StoredTransaction,
    kind: ProjectTransactionPendingOperation['kind'],
    restoreByPath: Map<string, ApplyRestoreState>,
  ): ProjectTransactionPendingOperation | undefined {
    if (!this.transactionState) return undefined
    const pending: ProjectTransactionPendingOperation = {
      kind,
      transactionId: tx.transactionId,
      previousStatus: tx.status,
      restore: durableRestorePlan(tx, kind, restoreByPath),
    }
    this.persistTransactionState(pending)
    return pending
  }

  public async initializeTransactionState(): Promise<void> {
    const pending = this.transactionState?.snapshot().pending
    if (pending) await this.restoreDurableOperation(pending)
    this.reconcileDurableChangeFeed()
  }

  /** 查询事务身份仍由 Kernel 负责；补丁顺序重放完全委托给 TransactionOverlay。 */
  private async buildTransactionContentOverlay(transactionId?: string) {
    const transaction = transactionId ? this.transactionRepository.get(transactionId) : undefined
    return this.transactionOverlay.build(transaction?.patches)
  }

  private async prepareTransaction(
    input: PrepareEditInput,
    options: {
      contentOverlay?: Map<string, StagedFileContent>
      attributeOverlay?: Map<string, FileAttributes>
      forcePatchBaseRevision?: 'none'
      store?: boolean
    } = {},
  ): Promise<PreparedTransaction> {
    const transaction = await this.planner.prepareTransaction(input, options)
    if (options.store ?? true) this.addTransaction(transaction)
    return transaction
  }

  private refreshTransactionSummary(tx: StoredTransaction): void {
    Object.assign(tx, this.planner.summarizePatches(tx.patches))
  }

  /** 根据编辑意图生成待应用事务，但不修改磁盘文件。 */
  public async prepareEdit(input: PrepareEditInput): Promise<PreparedTransaction> {
    await this.hooks.emit('BeforePrepareEdit', this, input)
    await this.decide('prepare_edit', undefined, input)
    const transactionsBeforePrepare = this.transactionRepository.snapshot()
    const projectionsBeforePrepare = this.transactionProjectionRepository.snapshot()
    const tx = await this.prepareTransaction(input)
    try {
      this.publishTransactionChange(tx, 'prepared', input.operations)
    } catch (error) {
      this.transactionRepository.restore(transactionsBeforePrepare)
      this.transactionProjectionRepository.restore(projectionsBeforePrepare)
      throw error
    }
    await this.hooks.emit('AfterPrepareEdit', this, tx)
    this.journal.record({
      actor: 'system',
      action: 'prepare_edit',
      transactionId: tx.transactionId,
      outputSummary: `${tx.changedFiles.length} 个文件，${tx.changedLines} 行变更`,
      risk: tx.risk,
    })
    return tx
  }

  private async runTransactionCommand<T>(
    transactionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.transactionCoordinator.run(transactionId, action)
  }

  /**
   * 丢弃一个尚未应用的已暂存事务，把它从内存事务表移除。
   * 用于 dryRun 预览：预览只想看 diff，不该留下可被 commit 或污染 `diff()` 合并的暂存事务。
   * 已应用的事务不能用本方法（应走 rollback）。
   */
  public discardTransaction(transactionId: string): { discarded: boolean } {
    if (this.transactionCoordinator.isBusy(transactionId)) {
      throw new ProjectError(
        'INVALID_INPUT',
        `事务正在执行，不能丢弃：${transactionId}`,
        { transactionId },
        '请等待当前事务操作完成后，再根据最新事务状态决定是否丢弃。',
      )
    }
    const tx = this.transactionRepository.get(transactionId)
    if (!tx) return { discarded: false }
    this.transactionStateMachine.assertDiscardable(tx)
    this.publishTransactionChange(tx, 'discarded', [], undefined, true)
    return { discarded: true }
  }

  /** 在尚未应用的事务上追加编辑操作并刷新事务摘要。 */
  public async amendEdit(input: AmendEditInput): Promise<PreparedTransaction> {
    return this.runTransactionCommand(input.transactionId, () => this.amendEditSerialized(input))
  }

  private async amendEditSerialized(input: AmendEditInput): Promise<PreparedTransaction> {
    await this.hooks.emit('BeforePrepareEdit', this, input)
    const tx = this.transactionRepository.get(input.transactionId)
    if (!tx) throw new ProjectError('INVALID_INPUT', `未知事务：${input.transactionId}`)
    const amendedStatus = this.transactionStateMachine.amend(tx)
    // 同一个 Map value 的两种视图：`tx` 带终态字段用于上面的守卫，`preparedTx` 是收窄后的对外形状。
    const preparedTx = this.getTransaction(input.transactionId)!
    await this.decide('amend_edit', tx.changedFiles, input, tx.risk)
    const overlay = await this.buildTransactionContentOverlay(input.transactionId)
    if (!isEmpty(overlay.diagnostics)) {
      const envelope = diagnosticsEnvelope(overlay.diagnostics)
      throw new ProjectError(
        'INVALID_INPUT',
        `无法 amend 该事务：当前暂存补丁不能干净重放：${envelope.headline}`,
        { transactionId: input.transactionId, ...envelope.details },
      )
    }

    const amendment = await this.prepareTransaction(
      {
        operations: input.operations,
        evidenceId: input.evidenceId,
        metadata: input.metadata,
      },
      {
        contentOverlay: overlay.contentByPath,
        attributeOverlay: overlay.attributesByPath,
        store: false,
      },
    )

    const transactionBeforeAmend = cloneStoredTransaction(tx)
    try {
      preparedTx.patches.push(
        ...amendment.patches.map((patchValue) => ({
          ...patchValue,
          metadata: {
            ...(patchValue.metadata ?? {}),
            amendedFromTransactionId: preparedTx.transactionId,
          },
        })),
      )
      preparedTx.baseSnapshots.push(...amendment.baseSnapshots)
      preparedTx.metadata = {
        ...(preparedTx.metadata ?? {}),
        amendmentMetadata: toOptional(input.metadata),
        amendedAt: Date.now(),
        amendmentCount: Number(preparedTx.metadata?.amendmentCount ?? 0) + 1,
      }
      preparedTx.status = amendedStatus
      this.refreshTransactionSummary(preparedTx)
      this.planner.assertScopeWithinPolicy(preparedTx.changedFiles, preparedTx.changedLines)
      this.publishTransactionChange(tx, 'amended', input.operations)
    } catch (error) {
      this.transactionRepository.set(input.transactionId, transactionBeforeAmend)
      throw error
    }
    await this.hooks.emit('AfterPrepareEdit', this, preparedTx)
    this.journal.record({
      actor: 'system',
      action: 'amend_edit',
      transactionId: preparedTx.transactionId,
      outputSummary: `${input.operations.length} amendment operation(s)`,
      risk: preparedTx.risk,
    })
    return preparedTx
  }

  /** 在事务暂存内容上运行修复器，并把修复转成事务修订。 */
  public async fixTransaction(input: FixInput): Promise<FixResult> {
    return this.runTransactionCommand(input.transactionId, () =>
      this.fixTransactionSerialized(input),
    )
  }

  /** 已位于 transactionId 队列内的修复实现；最终 amendment 复用私有串行入口。 */
  private async fixTransactionSerialized(input: FixInput): Promise<FixResult> {
    const tx = this.getTransaction(input.transactionId)
    if (!tx) throw new ProjectError('INVALID_INPUT', `未知事务：${input.transactionId}`)
    await this.decide('amend_edit', tx.changedFiles, input, tx.risk)
    const originalOverlay = await this.buildTransactionContentOverlay(input.transactionId)
    if (!isEmpty(originalOverlay.diagnostics))
      return {
        ok: false,
        changed: false,
        transactionId: input.transactionId,
        changedFiles: [],
        fixes: [],
        diagnostics: originalOverlay.diagnostics,
      }

    const mutableContent = new Map(originalOverlay.contentByPath)
    // fixer 在事务暂存态上工作，最后只把真实变化转成 amendment。
    const ctx = {
      getTransaction: (idValue: string) => this.getTransaction(idValue),
      root: this.root,
      providers: this.providers,
      readFile: this.transactionOverlay.createReader(mutableContent),
    }

    const paths = input.paths ?? tx.changedFiles
    let result: FixResult = {
      ok: true,
      changed: false,
      transactionId: input.transactionId,
      changedFiles: [],
      fixes: [],
      diagnostics: [],
    }

    const maxPasses = Math.max(1, input.maxPasses ?? 1)
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const passResult = await this.fixers.fix({ ...input, paths }, ctx)
      result = {
        ok: result.ok && passResult.ok,
        changed: result.changed || passResult.changed,
        transactionId: input.transactionId,
        changedFiles: [...new Set([...result.changedFiles, ...passResult.changedFiles])],
        fixes: [...result.fixes, ...passResult.fixes],
        diagnostics: [...result.diagnostics, ...passResult.diagnostics],
        toolRequirements: optionalWhen(
          [...(result.toolRequirements ?? []), ...(passResult.toolRequirements ?? [])].length,
          [...(result.toolRequirements ?? []), ...(passResult.toolRequirements ?? [])],
        ),
      }
      if (!passResult.changed) break
      for (const fix of passResult.fixes) {
        mutableContent.set(fix.path, fix.content)
      }
    }

    const operations = [...mutableContent.entries()].flatMap(([pathValue, finalContent]) => {
      if (isNull(finalContent)) return []
      const originalContent = originalOverlay.contentByPath.get(pathValue)
      if (!isString(originalContent) || originalContent === finalContent) return []
      return [
        {
          operation:
            originalContent.length > 0
              ? {
                  type: 'replace_text' as const,
                  path: pathValue,
                  oldText: originalContent,
                  newText: finalContent,
                }
              : {
                  type: 'append_text' as const,
                  path: pathValue,
                  text: finalContent,
                },
          reason: '自动修复暂存事务',
        },
      ]
    })

    if (!isEmpty(operations)) {
      await this.amendEditSerialized({
        transactionId: input.transactionId,
        operations,
        metadata: {
          autoFix: true,
          fixerIds: this.fixers.listIds(),
        },
      })
    }

    this.journal.record({
      actor: 'validator',
      action: 'fix_transaction',
      transactionId: input.transactionId,
      outputSummary: `${result.changedFiles.length} 个文件已修复`,
    })
    return result
  }

  /** 应用已准备好的事务，并记录新旧 revision。 */
  public async applyEdit(input: ApplyEditInput): Promise<ApplyResult> {
    return this.runTransactionCommand(input.transactionId, () => this.applyEditSerialized(input))
  }

  private async applyEditSerialized(input: ApplyEditInput): Promise<ApplyResult> {
    await this.hooks.emit('BeforeApplyEdit', this, input)
    const tx = this.transactionRepository.get(input.transactionId)
    if (!tx) throw new ProjectError('INVALID_INPUT', `未知事务：${input.transactionId}`)
    const isRestoringRolledBackTransaction = tx.status === 'rolled_back'
    this.transactionStateMachine.assertApplicable(tx)
    const validation = await this.validateSerialized({ transactionId: tx.transactionId })
    if (!validation.ok) throw validationFailed(tx.transactionId, validation)
    // validate 会把可变事务推进到 validated；execution token 必须从校验后的稳定状态开始，
    // 这样 apply 后续失败时仍恢复到现有语义下的 validated，而不是调用前的 prepared。
    const execution = this.transactionStateMachine.beginApply(tx)
    const authorizedChangedFiles = await this.authorizePaths(tx.changedFiles, 'write', '写入')
    await this.decide('apply_edit', toOptional(authorizedChangedFiles), input, tx.risk)
    const lock = await this.locks.lock(tx.changedFiles, tx.transactionId)
    try {
      const oldRevisions: Record<string, string> = {}
      const newRevisions: Record<string, string> = {}
      const rebasedFiles = new Set<string>()
      const createdFiles: string[] = []
      const transactionBeforePreflight = cloneStoredTransaction(tx)
      let restoreByPath: Map<string, ApplyRestoreState>
      let pending: ProjectTransactionPendingOperation | undefined

      try {
        // 在 durable write-ahead plan 之前完成全部 revision/rebase 判定，保证计划里记录的
        // owned state 就是后面实际可能写入磁盘的内容。只有每个路径的首个补丁对照磁盘；后继补丁
        // 经 `chainPatch` 衔接到前一补丁的产出，首个补丁被 rebase 时随之在 rebase 结果上重新推导。
        const stagedByPath = new Map<string, StagedFileContent>()
        const attributesByPath = new Map<string, FileAttributes>()
        for (let patchIndex = 0; patchIndex < tx.patches.length; patchIndex += 1) {
          let patch = tx.patches[patchIndex]
          let attributes = attributesByPath.get(patch.path)
          const staged = stagedByPath.get(patch.path)
          if (!isUndefined(staged)) {
            const chained = await this.transactionOverlay.chainPatch(patch, staged)
            if (!chained) {
              throw revisionMismatch(
                `${patch.path} 在准备事务后被修改，本事务对该文件的后续操作无法衔接到 rebase 后的内容`,
                {
                  path: patch.path,
                  actual: oldRevisions[patch.path],
                  patchId: patch.patchId,
                  operation: patch.metadata?.op,
                },
              )
            }
            patch = chained
          } else if (patch.baseRevision) {
            const current = await this.store.snapshot(patch.path, true, { skipFileFilter: true })
            oldRevisions[patch.path] = current.revision
            attributes = { mode: current.mode, textEncoding: current.textEncoding }
            const canReplayRolledBackPatch =
              isRestoringRolledBackTransaction &&
              isString(patch.oldContent) &&
              current.content === patch.oldContent
            if (
              (current.revision !== patch.baseRevision ||
                (current.exists && isString(patch.oldContent) && current.content !== patch.oldContent)) &&
              !canReplayRolledBackPatch
            ) {
              const rebased = await this.planner.tryRebasePatch(patch, current)
              if (!rebased) {
                throw revisionMismatch(`${patch.path} 的补丁 base revision 已变化`, {
                  expected: patch.baseRevision,
                  actual: current.revision,
                })
              }
              patch = rebased
            }
          }
          // chmod 不改变正文 revision；重建路径使用写盘前的权限，重命名目标继承源路径。
          const from = patch.metadata?.from
          if (patch.metadata?.op === 'rename_file_create' && isString(from)) {
            attributes = attributesByPath.get(from) ?? patchFileAttributes(patch)
          }
          const contentRebased = patch !== tx.patches[patchIndex]
          if (attributes) {
            patch = withPatchFileAttributes(patch, attributes)
          }
          attributesByPath.set(patch.path, patchFileAttributes(patch))
          tx.patches[patchIndex] = patch
          if (contentRebased) rebasedFiles.add(patch.path)
          stagedByPath.set(patch.path, stagedContentAfter(patch))
        }
        // rebase 改变了将写下的内容：摘要随之刷新，apply 结果与 change feed 描述的就是实际写盘；
        // 前面的校验看的是 rebase 前的内容，所以锁内对 rebase 后的补丁链再校验一次，不通过就不写盘。
        if (rebasedFiles.size > 0) {
          this.refreshTransactionSummary(tx)
          const revalidation = await this.runValidators({ transactionId: tx.transactionId })
          if (!revalidation.ok) {
            throw validationFailed(tx.transactionId, revalidation, {
              rebasedFiles: [...rebasedFiles],
            })
          }
        }

        // 写盘前先为每个受影响路径捕获原始状态，供失败回滚使用。
        // 注意：这里只读不写，不改变下面补丁的顺序写入与 rebase 语义。
        restoreByPath = await this.transactionRecovery.captureApplyRestoreState(tx.changedFiles)
        pending = this.beginDurableOperation(tx, 'apply', restoreByPath)
      } catch (error) {
        this.transactionRepository.set(tx.transactionId, transactionBeforePreflight)
        throw error
      }
      const writtenOrder: string[] = []

      try {
        for (const patch of tx.patches) {
          if (!writtenOrder.includes(patch.path)) writtenOrder.push(patch.path)
          if (isDeletePatch(patch)) {
            await this.store.remove(patch.path, { skipFileFilter: true })
            newRevisions[patch.path] = 'deleted'
          } else {
            if (isCreatePatch(patch)) {
              const beforeWrite = await this.store.snapshot(patch.path, false, {
                skipFileFilter: true,
              })
              if (!beforeWrite.exists) createdFiles.push(patch.path)
            }
            const snap = await this.store.write(patch.path, patch.newContent ?? '', {
              skipFileFilter: true,
              encoding: patchFileAttributes(patch).textEncoding,
              mode: patchFileAttributes(patch).mode,
            })
            newRevisions[patch.path] = snap.revision
          }
        }
      } catch (writeError) {
        // 多文件写入原子化：任一补丁失败时，按逆序把已写文件还原到本次 apply 前的状态。
        if (pending) await this.restoreDurableOperation(pending)
        else
          await this.transactionRecovery.restoreAppliedFiles(
            writtenOrder,
            restoreByPath,
            tx,
            'apply',
          )
        throw writeError
      }
      const previousAppliedAt = tx.appliedAt
      tx.status = this.transactionStateMachine.commit(execution)
      tx.appliedAt = Date.now()
      const appliedRevisions = tx.changedFiles.map((pathValue) => ({
        path: pathValue,
        before: oldRevisions[pathValue],
        after: newRevisions[pathValue],
      }))
      try {
        this.publishTransactionChange(tx, 'applied', [], appliedRevisions)
      } catch (stateError) {
        tx.status = this.transactionStateMachine.abort(execution)
        tx.appliedAt = previousAppliedAt
        if (pending) await this.restoreDurableOperation(pending)
        else
          await this.transactionRecovery.restoreAppliedFiles(
            writtenOrder,
            restoreByPath,
            tx,
            'apply',
          )
        throw stateError
      }

      // Git intent-to-add 是已提交文件事务的附带可见性，不进入崩溃恢复提交点。按路径的最终状态处理：
      // 仍在的新建文件挂上 intent-to-add（同一事务里建了又删的不挂——git add 遇到不存在的路径会整批
      // 失败）；最终被删的路径撤掉残留的 intent-to-add 条目（rename_file 的旧路径同样走这里）。
      const gitTrackedFiles = await this.gitIndex.trackCreatedFilesInGit(
        createdFiles.filter((pathValue) => newRevisions[pathValue] !== 'deleted'),
      )
      const gitUntrackedFiles = await this.gitIndex.untrackDeletedIntentToAddFromGit(
        tx.changedFiles.filter((pathValue) => newRevisions[pathValue] === 'deleted'),
      )
      if (gitTrackedFiles.length > 0) tx.metadata = { ...(tx.metadata ?? {}), gitTrackedFiles }
      // rollback 恢复这些文件时据此把 intent-to-add 挂回去。
      if (gitUntrackedFiles.length > 0) tx.metadata = { ...(tx.metadata ?? {}), gitUntrackedFiles }
      this.retainTerminalTransaction(tx.transactionId)
      this.persistCommittedTransactionState(tx.transactionId, 'git metadata or terminal retention')
      const result: ApplyResult = {
        status: 'applied',
        transactionId: tx.transactionId,
        changedFiles: tx.changedFiles,
        oldRevisions,
        newRevisions,
        rebasedFiles: optionalWhen(rebasedFiles.size, [...rebasedFiles]),
        gitTrackedFiles: optionalWhen(gitTrackedFiles.length > 0, gitTrackedFiles),
        gitUntrackedFiles: optionalWhen(gitUntrackedFiles.length > 0, gitUntrackedFiles),
      }
      await this.hooks.emit('AfterApplyEdit', this, result)
      this.journal.record({
        actor: 'system',
        action: 'apply_edit',
        transactionId: tx.transactionId,
        outputSummary: tx.changedFiles.join(','),
        risk: tx.risk,
      })
      return result
    } finally {
      await this.locks.unlock(lock.lockId)
    }
  }

  /** 校验当前文件或事务暂存内容，并合并适配器诊断。 */
  public async validate(input: ValidateInput): Promise<ValidationResult> {
    return input.transactionId
      ? this.runTransactionCommand(input.transactionId, () => this.validateSerialized(input))
      : this.validateSerialized(input)
  }

  /** 已位于 transactionId 队列内的校验实现；apply 复用此入口，避免嵌套排队。 */
  private async validateSerialized(input: ValidateInput): Promise<ValidationResult> {
    await this.hooks.emit('BeforeValidate', this, input)
    if (input.transactionId && !this.transactionRepository.has(input.transactionId)) {
      throw new ProjectError('INVALID_INPUT', `未知事务：${input.transactionId}`)
    }
    await this.decide('validate', input.paths, input)
    const result = await this.runValidators(input)
    const transaction = input.transactionId
      ? this.transactionRepository.get(input.transactionId)
      : undefined
    const previousStatus = transaction?.status
    if (transaction && result.ok) {
      transaction.status = this.transactionStateMachine.validationSucceeded(transaction)
    }
    if (transaction) {
      try {
        const lifecycle = result.ok
          ? previousStatus === 'applied'
            ? 'applied'
            : previousStatus === 'rolled_back'
              ? 'rolled_back'
              : 'validated'
          : 'validation_failed'
        this.publishTransactionChange(transaction, lifecycle)
      } catch (error) {
        if (previousStatus)
          transaction.status = this.transactionStateMachine.restore(previousStatus)
        throw error
      }
    }
    await this.hooks.emit('AfterValidate', this, result)
    this.journal.record({
      actor: 'validator',
      action: 'validate',
      transactionId: input.transactionId,
      outputSummary: result.ok ? 'ok' : `${result.diagnostics.length} diagnostic(s)`,
    })
    return result
  }

  /**
   * 在事务暂存态（无事务时为当前工作区）上跑 validator 与 adapter 校验。只产出结果，不改事务
   * 状态、不发布生命周期——apply 在锁内复核 rebase 后的补丁链时也用它。
   */
  private async runValidators(input: ValidateInput): Promise<ValidationResult> {
    return this.transactionValidation.run(input)
  }

  /** 回滚已应用事务，并把 apply 对 git intent-to-add 标记的增删一并撤回。 */
  public async rollback(input: RollbackInput): Promise<RollbackResult> {
    return this.runTransactionCommand(input.transactionId, () => this.rollbackSerialized(input))
  }

  private async rollbackSerialized(input: RollbackInput): Promise<RollbackResult> {
    await this.hooks.emit('BeforeRollback', this, input)
    const tx = this.transactionRepository.get(input.transactionId)
    if (!tx) throw new ProjectError('INVALID_INPUT', `未知事务：${input.transactionId}`)
    const execution = this.transactionStateMachine.beginRollback(tx)
    const lock = await this.locks.lock(tx.changedFiles, `rollback:${tx.transactionId}`)
    try {
      const reversed = [...tx.patches].reverse()
      const appliedRevisions =
        this.transactionProjectionRepository.get(tx.transactionId)?.revisions ??
        this.changeFeed.get(tx.transactionId)?.revisions ??
        []
      for (const pathValue of tx.changedFiles) {
        const expectedRevision = appliedRevisions.find(
          (revision) => revision.path === pathValue,
        )?.after
        if (!expectedRevision) {
          throw new ProjectError(
            'CONFLICT_WITH_EXTERNAL_EDIT',
            `无法安全回滚事务 ${tx.transactionId}：缺少 apply 后 revision（${pathValue}）`,
            { transactionId: tx.transactionId, path: pathValue },
            '请重新读取冲突文件并人工确认恢复内容；不要强制覆盖当前工作区。',
          )
        }
        const current = await this.store.snapshot(pathValue, true, { skipFileFilter: true })
        const finalPatch = [...tx.patches]
          .reverse()
          .find((patchValue) => patchValue.path === pathValue)
        const expectedContent =
          finalPatch && !isDeletePatch(finalPatch) ? finalPatch.newContent : undefined
        const matchesAppliedState =
          expectedRevision === 'deleted'
            ? !current.exists
            : current.exists &&
              (isString(expectedContent)
                ? current.content === expectedContent
                : current.revision === expectedRevision)
        if (!matchesAppliedState) {
          throw new ProjectError(
            'CONFLICT_WITH_EXTERNAL_EDIT',
            `事务应用后文件已被外部修改，拒绝回滚：${pathValue}`,
            {
              transactionId: tx.transactionId,
              path: pathValue,
              expectedRevision,
              actualRevision: current.exists ? current.revision : 'deleted',
            },
            '请重新读取冲突文件并人工合并；不要重试会覆盖当前内容的回滚。',
          )
        }
      }
      // 预检：每个补丁都必须可撤销（`canRevertToOriginal`：写入前不存在的新建，或带可还原的旧正文，
      // 含覆盖既有文件的 create_file）。否则用 "" 写盘会把文件截断为空（静默丢数据），宁可整体失败也不半改。
      for (const patch of reversed) {
        if (!canRevertToOriginal(patch)) {
          throw new ProjectError(
            'PATCH_APPLY_ERROR',
            `无法回滚事务 ${tx.transactionId}：补丁缺少可还原的旧正文（${patch.path}）`,
            { path: patch.path, op: patch.metadata?.op },
          )
        }
      }
      // 捕获回滚前状态；任一步写盘失败时按逆序还原，保持 rollback 自身的原子性
      //（与 applyEdit 一致，并用 skipFileFilter 还原 apply 时绕过 fileFilter 的文件）。
      const restoreByPath = await this.transactionRecovery.captureApplyRestoreState(tx.changedFiles)
      const pending = this.beginDurableOperation(tx, 'rollback', restoreByPath)
      const writtenOrder: string[] = []
      const rolledBackRevisions: Record<string, string> = {}
      try {
        for (const patch of reversed) {
          if (!writtenOrder.includes(patch.path)) writtenOrder.push(patch.path)
          if (createsMissingFile(patch)) {
            await this.store.remove(patch.path, { skipFileFilter: true })
            rolledBackRevisions[patch.path] = 'deleted'
          } else {
            const snapshot = await this.store.write(patch.path, patch.oldContent ?? '', {
              skipFileFilter: true,
              encoding: patchFileAttributes(patch).textEncoding,
              mode: patchFileAttributes(patch).mode,
            })
            rolledBackRevisions[patch.path] = snapshot.revision
          }
        }
      } catch (rollbackError) {
        if (pending) await this.restoreDurableOperation(pending)
        else
          await this.transactionRecovery.restoreAppliedFiles(
            writtenOrder,
            restoreByPath,
            tx,
            'rollback',
          )
        throw rollbackError
      }
      const beforeRollback =
        this.transactionProjectionRepository.get(tx.transactionId)?.revisions ??
        this.changeFeed.get(tx.transactionId)?.revisions ??
        []
      tx.status = this.transactionStateMachine.commit(execution)
      const rollbackRevisions = tx.changedFiles.map((pathValue) => ({
        path: pathValue,
        before: beforeRollback.find((revision) => revision.path === pathValue)?.after,
        after: rolledBackRevisions[pathValue],
      }))
      try {
        this.publishTransactionChange(tx, 'rolled_back', [], rollbackRevisions)
      } catch (stateError) {
        tx.status = this.transactionStateMachine.abort(execution)
        if (pending) await this.restoreDurableOperation(pending)
        else
          await this.transactionRecovery.restoreAppliedFiles(
            writtenOrder,
            restoreByPath,
            tx,
            'rollback',
          )
        throw stateError
      }

      const gitUntrackedFiles = await this.gitIndex.untrackCreatedFilesFromGit(
        metadataPaths(tx.metadata?.gitTrackedFiles),
      )
      // apply 为被删路径撤掉的 intent-to-add 随文件恢复挂回去，git 视野回到 apply 之前。
      const gitTrackedFiles = await this.gitIndex.trackCreatedFilesInGit(
        metadataPaths(tx.metadata?.gitUntrackedFiles),
      )
      this.retainTerminalTransaction(tx.transactionId)
      this.persistCommittedTransactionState(tx.transactionId, 'git metadata or terminal retention')
      const result: RollbackResult = {
        status: 'rolled_back',
        transactionId: tx.transactionId,
        changedFiles: tx.changedFiles,
        gitUntrackedFiles: optionalWhen(gitUntrackedFiles.length > 0, gitUntrackedFiles),
        gitTrackedFiles: optionalWhen(gitTrackedFiles.length > 0, gitTrackedFiles),
      }
      await this.hooks.emit('AfterRollback', this, result)
      this.journal.record({
        actor: 'system',
        action: 'rollback',
        transactionId: tx.transactionId,
        outputSummary: tx.changedFiles.join(','),
      })
      return result
    } finally {
      await this.locks.unlock(lock.lockId)
    }
  }

  /** 返回单个事务或全部事务的合并 diff 摘要。 */
  public async diff(input: { transactionId?: string } = {}): Promise<DiffResult> {
    if (input.transactionId && !this.transactionRepository.has(input.transactionId)) {
      throw new ProjectError('INVALID_INPUT', `未知事务：${input.transactionId}`)
    }
    const txs = input.transactionId
      ? [this.transactionRepository.get(input.transactionId)!]
      : [...this.transactionRepository.values()]
    const diff = combineDiffs(txs.map((tx) => tx.diff))
    const changedFiles = [...new Set(txs.flatMap((tx) => tx.changedFiles))]
    const changedLines = txs.reduce((sum, tx) => sum + tx.changedLines, 0)
    return { diff, changedFiles, changedLines }
  }

  /** 返回当前 project 内核状态快照。 */
  public async status(): Promise<ProjectStatus> {
    return {
      root: this.root,
      transactions: this.transactionRepository.size,
      targets: this.queries.targetCount,
      journalEvents: this.journal.list().length,
      locks: this.locks.list(),
      plugins: this.plugins.list().map((p) => p.name),
      adapters: this.adapters.listFactoryIds(),
      validators: this.validators.listIds(),
      runningBatches: this.runningBatches,
      lastBatch: this.lastBatchMetrics,
    }
  }

  /** 返回当前 journal 事件列表。 */
  public getJournal(): AuditEvent[] {
    return this.journal.list()
  }

  /**
   * 读取指定事务的当前内存状态。
   *
   * **这是 StoredTransaction → PreparedTransaction 的唯一 cast 点**（§1.4 白名单③：闭集字面量
   * 收窄）。内存表存的是 `StoredTransaction`，它把 `status` 从字面量 `"prepared"` 放宽成含
   * `applied` / `validated` / `rolled_back` 的联合；其余字段形状完全一致。所有消费者（内置
   * validator、typescript validator、工具中间件的 preflight）只读 `patches` / `changedFiles`，
   * 没有一个读 `status`，所以这个宽窄差目前不产生错判。
   *
   * **欠账**：`PreparedTransaction.status` 是字面量类型这件事本身是错的——它让公开返回值在
   * 类型上宣称 `"prepared"` 而运行时可能是终态。修法是把 status 放宽进类型（跨仓 API 形状变更，
   * 见 Q3a 报告的待协调清单），**不是**在调用点再补一次 cast。
   */
  public getTransaction(idValue: string): PreparedTransaction | undefined {
    return this.transactionRepository.get(idValue) as PreparedTransaction | undefined
  }

  /** 执行批处理任务，并复用同一个 project 实例；记录工作池指标供 status/telemetry 观测。 */
  public async runBatch(input: BatchInput): Promise<BatchResult> {
    this.runningBatches += 1
    try {
      const result = await runBatch(this, input)
      if (isPresent(result.metrics)) {
        this.lastBatchMetrics = result.metrics
        void this.providers.telemetry?.emit?.({
          name: 'project.batch',
          properties: { ok: result.ok, ...result.metrics },
        })
        this.journal.record({
          actor: 'system',
          action: 'batch',
          outputSummary: `${result.metrics.totalTasks} tasks, peak ${result.metrics.peakActive}/${result.metrics.concurrencyLimit}, ${result.metrics.durationMs}ms`,
        })
      }
      return result
    } finally {
      this.runningBatches -= 1
    }
  }

  public async observe(input: ObserveInput = {}): Promise<ProjectSnapshot> {
    return this.queries.observe(input)
  }

  public async listFiles(input: ObserveInput = {}): Promise<FileListEntry[]> {
    return this.queries.listFiles(input)
  }

  public async stat(input: FileStatInput): Promise<FileStatResult> {
    return this.queries.stat(input)
  }

  public async read(input: ReadInput): Promise<ReadResult> {
    return this.queries.read(input)
  }

  public async search(input: SearchInput): Promise<SearchResult> {
    return this.queries.search(input)
  }

  public async listSymbols(pathInput: string): Promise<ProjectSymbol[]> {
    return this.queries.listSymbols(pathInput)
  }

  public async resolveTarget(input: ResolveTargetInput): Promise<ResolveTargetResult> {
    return this.queries.resolveTarget(input)
  }

  public createTaskContext(input: Omit<TaskContext, 'taskId' | 'createdAt'>): TaskContext {
    return this.queries.createTaskContext(input)
  }

  public async buildEvidencePack(input: BuildEvidencePackInput): Promise<EvidencePack> {
    return this.queries.buildEvidencePack(input)
  }
}

/** 创建项目内核，并安装 core plugin 与调用方传入的插件。 */
export async function createProjectKernel(
  options: CreateProjectKernelOptions,
): Promise<ProjectKernel> {
  const project = new ProjectKernelImpl(options)
  await project.initializeTransactionState()
  if (options.includeBuiltinPlugins ?? true) await project.install(corePlugin())
  for (const plugin of options.plugins ?? []) await project.install(plugin)
  return project
}

export type { CreateProjectKernelOptions, ProjectKernel } from '../types/kernel.js'
