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
//  3. `applyEdit` → 取写锁 → 每个路径的首个补丁校验 base revision（不匹配则试 rebase）→ 写盘；
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
//    为 `oldContent`（`chainPatch` 是唯一衔接规则，prepare / 暂存重放 / apply 共用），所以
//    校验看到的、写盘写下的、diff 描述的是同一份最终内容。若让每个补丁各自基于原文生成，
//    顺序整文件写入会让最后一个补丁覆盖前面的改动——静默丢改动。
//  - **写锁覆盖 `tx.changedFiles` 全集，且 apply/rollback 全程持锁**：锁按路径粒度、公平排队
//    （见 lock-manager）。锁只在**进程内**有效——它防的是同一内核的并发事务互相踩，不防外部
//    编辑器；外部编辑靠 base revision 检查兜。
//  - **base revision 不匹配 → 先试 rebase，再失败才抛**：只有 `QueueRebaseFriendlyOperations`
//    里那些"靠锚点定位、不依赖绝对偏移"的操作允许 rebase。把 `create_file`/`delete_file`
//    放进这个集合会让"文件已被别人改过"被静默覆盖。
//  - **多文件写入原子化有两档**：宿主提供 `transactionStatePath` 时，写盘前先提交可恢复计划，
//    进程中断后由下一次 owner 启动恢复；不能完整捕获旧正文的事务在写前拒绝。无 durable state
//    的嵌入式调用仍靠 `captureApplyRestoreState` + 逆序还原，并保留旧的二进制/超限告警边界。
//  - **`rollback` 有前置全量预检**：任何非 create 补丁缺 `oldContent` 就整体拒绝。少了这一步，
//    `patch.oldContent ?? ""` 会把文件截断成空——静默丢数据是这里最坏的失败模式。
//  - **`decide` 是唯一策略/审批门**：provider 可直接拒，也可要求审批；高风险补丁按
//    `policy.approval.requireForHighRiskPatch` 再走一次人审。绕过 `decide` 直接调 `store` = 无审批写盘。
//
// ## 内存治理（为什么有一堆 Max* 常量）
// 内核在长会话里常驻，`targets` / `evidence` / `transactions` 都是只增 Map。四个上限按插入顺序
// 淘汰最旧项；正常 prepare→apply 流程永远不会淘汰到刚写入的事务。
import * as path from "node:path";

import { isArray,isEmpty, isFalse, isNotNull, isNull, isObject, isPresent, isString, isTrue, isUndefined, optionalWhen, toOptional } from "@velaros-ai/core";
import { AppError } from "@velaros-ai/core/error";

import { type AuditEvent, AuditJournal } from "../audit/journal.js";
import { runBatch } from "../batch/runner.js";
import {
  MemoryProjectChangeFeed,
  type ProjectChangeFeed,
  type ProjectChangeFeedWriter,
  type ProjectChangeLifecycle,
  projectChangePatches,
  type ProjectChangeRecordInput,
  type ProjectChangeRevision,
} from "../change-feed.js";
import { ProjectError } from "../errors.js";
import { HookRegistry } from "../hooks/registry.js";
import { PipelineRegistry } from "../pipeline/registry.js";
import { corePlugin } from "../plugins/core.js";
import { createNodeCommandProvider } from "../providers/index.js";
import { AdapterRegistry } from "../registry/adapter-registry.js";
import { FixerRegistry } from "../registry/fixer-registry.js";
import { PatchStrategyRegistry } from "../registry/patch-registry.js";
import { PluginRegistry, type RegistrySink } from "../registry/plugin-registry.js";
import { ValidatorRegistry } from "../registry/validator-registry.js";
import { searchWithRipgrep } from "../search/ripgrep.js";
import {
  FileProjectTransactionStateStore,
  type ProjectTransactionFileState,
  type ProjectTransactionPendingOperation,
  type ProjectTransactionRestoreEntry,
} from "../transaction-state.js";
import type { FileAdapterFactory, ProjectSymbol } from "../types/adapter.js";
import type { BatchInput, BatchMetrics, BatchResult } from "../types/batch.js";
import type { Diagnostic, DiffResult, ProjectStatus,Range, RiskLevel } from "../types/common.js";
import type { BuildEvidencePackInput, EvidencePack, TaskContext } from "../types/context.js";
import type { AmendEditInput, ApplyEditInput, ApplyResult, EditIntent, EditOperation, PreparedPatch,PreparedTransaction, PrepareEditInput, RollbackInput, RollbackResult } from "../types/edit.js";
import type { FixInput, FixResult, ProjectFixer } from "../types/fix.js";
import type { ProjectHook } from "../types/hook.js";
import type { FileListEntry, FileStatInput, FileStatResult,ObserveInput, ReadInput, ReadResult, SearchHit,SearchInput, SearchResult } from "../types/io.js";
import type { PatchStrategy } from "../types/patch.js";
import type { PipelineStage } from "../types/pipeline.js";
import type { ProjectPlugin } from "../types/plugin.js";
import type { CorePolicy, PolicyDecisionInput } from "../types/policy.js";
import type { CommandProvider, ProjectProviders } from "../types/provider.js";
import type { FileSnapshot,ProjectSnapshot } from "../types/snapshot.js";
import type { ResolvedTarget,ResolveTargetInput, ResolveTargetResult } from "../types/target.js";
import type { ProjectValidator,ValidateInput, ValidationResult } from "../types/validation.js";
import { combineDiffs, unifiedDiff } from "../utils/diff.js";
import { matchesAny } from "../utils/glob.js";
import { id } from "../utils/id.js";
import { countChangedLines } from "../utils/text.js";

import { DEFAULT_CORE_POLICY } from "./defaults.js";
import { FileStore } from "./file-store.js";
import { LockManager } from "./lock-manager.js";
import { TransactionCoordinator } from "./transaction-coordinator.js";

function resolveEvidenceTargetRange(
  storedTarget?: ResolvedTarget,
  inputRange?: Partial<Range>
): Range | undefined {
  if (storedTarget?.range) return storedTarget.range;
  if (!inputRange || !isPresent(inputRange.startLine) || !isPresent(inputRange.endLine)) return undefined;
  const range: Range = {
    startLine: inputRange.startLine,
    endLine: inputRange.endLine,
  };
  if (isPresent(inputRange.startColumn)) range.startColumn = inputRange.startColumn;
  if (isPresent(inputRange.endColumn)) range.endColumn = inputRange.endColumn;
  if (isPresent(inputRange.startOffset)) range.startOffset = inputRange.startOffset;
  if (isPresent(inputRange.endOffset)) range.endOffset = inputRange.endOffset;
  return range;
}

/**
 * 取出编辑原语作用的文件路径。`rename_file` 用 `from`/`to` 而非 `path`；符号类与 `custom`
 * 原语本身不带路径，靠 `targetId` 反查——所以这里返回缺席是正常路径，不是错误。
 */
function operationPath(operation: EditOperation): string | undefined {
  if (operation.type === "rename_file") return operation.from;
  return "path" in operation ? operation.path : undefined;
}

function symbolIdentityKey(symbol: ProjectSymbol): string {
  const start = isPresent(symbol.range.startOffset)
    ? String(symbol.range.startOffset)
    : `${symbol.range.startLine}:${symbol.range.startColumn ?? ""}`;
  return [
    symbol.path,
    symbol.kind,
    symbol.container ?? "",
    symbol.name,
    start,
  ].join("\u0000");
}

function uniqueSymbols(symbols: ProjectSymbol[]): ProjectSymbol[] {
  const seen = new Set<string>();
  const unique: ProjectSymbol[] = [];
  for (const symbol of symbols) {
    const key = symbolIdentityKey(symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(symbol);
  }
  return unique;
}

/** 创建工作区内核的配置；每个内核都锚定在一个根目录下。 */
export interface CreateProjectKernelOptions {
  root: string;
  corePolicy?: Partial<CorePolicy>;
  providers?: ProjectProviders;
  plugins?: ProjectPlugin[];
  includeBuiltinPlugins?: boolean;
  metadata?: Record<string, any>;
  /** 宿主持有写端；编辑器等消费者只能从 kernel.changeFeed 读取。 */
  changeFeed?: ProjectChangeFeedWriter;
  /** 宿主私有、项目根绑定的可恢复事务状态文件。 */
  transactionStatePath?: string;
}

/** Project Agent 与 Kernel capability 共用的项目内核接口。 */
export interface ProjectKernel {
  readonly root: string;
  readonly policy: CorePolicy;
  readonly providers: ProjectRuntimeProviders;
  readonly changeFeed: ProjectChangeFeed;
  observe(input?: ObserveInput): Promise<ProjectSnapshot>;
  /** 列出相对工作区根目录的文件和目录。 */
  listFiles(input?: ObserveInput): Promise<FileListEntry[]>;
  stat(input: FileStatInput): Promise<FileStatResult>;
  read(input: ReadInput): Promise<ReadResult>;
  search(input: SearchInput): Promise<SearchResult>;
  listSymbols(path: string): Promise<ProjectSymbol[]>;
  resolveTarget(input: ResolveTargetInput): Promise<ResolveTargetResult>;
  createTaskContext(input: Omit<TaskContext, "taskId" | "createdAt">): TaskContext;
  buildEvidencePack(input: BuildEvidencePackInput): Promise<EvidencePack>;
  prepareEdit(input: PrepareEditInput): Promise<PreparedTransaction>;
  /** 丢弃一个尚未应用的已暂存事务（dryRun 预览用）；已应用的事务请用 rollback。 */
  discardTransaction(transactionId: string): { discarded: boolean };
  amendEdit(input: AmendEditInput): Promise<PreparedTransaction>;
  fixTransaction(input: FixInput): Promise<FixResult>;
  applyEdit(input: ApplyEditInput): Promise<ApplyResult>;
  validate(input: ValidateInput): Promise<ValidationResult>;
  rollback(input: RollbackInput): Promise<RollbackResult>;
  diff(input?: { transactionId?: string }): Promise<DiffResult>;
  /** 读取内存中已暂存/已应用事务；apply 前预检与 amend 路径使用。 */
  getTransaction(transactionId: string): PreparedTransaction | undefined;
  status(): Promise<ProjectStatus>;
  getJournal(): AuditEvent[];
  runBatch(input: BatchInput): Promise<BatchResult>;
  /** 注册监听内核生命周期事件的 hook。 */
  registerHook(hook: ProjectHook): void;
}

const RevisionMismatchSuggestedNextAction =
  "请重新读取受影响文件，并使用最新 snapshot.revision 重试。";

function revisionMismatch(message: string, details: any): ProjectError {
  return new ProjectError(
    "BASE_REVISION_MISMATCH",
    message,
    details,
    RevisionMismatchSuggestedNextAction,
  );
}

// 失败信封只携带模型定位问题所需的诊断：前几条足以指路，其余只报总数。
const MaxReportedDiagnostics = 10;
// 命令型 validator 会把整段 stdout/stderr 塞进一条诊断，信封里按字符截断。
const MaxDiagnosticMessageChars = 2000;
const MaxHeadlineChars = 200;

function truncateText(text: string, maximum: number): string {
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

/**
 * 把诊断压成对模型可读、可定位的信封：错误级排在最前、其中带行号的优先，只保留前 N 条（字段
 * 原样保留，仅截断超长 message），并生成「路径:行:列 消息（共 N 条）」的一行摘要放进错误
 * 消息——模型即使只看到 message 也知道去哪里改。完整 checks 与 diagnostics 重复且可能很大，
 * 不再随错误抛出。调用方保证至少有一条诊断。
 */
function diagnosticsEnvelope(diagnostics: readonly Diagnostic[]): {
  headline: string;
  details: { diagnostics: Diagnostic[]; diagnosticCount: number };
} {
  const rank = (diagnostic: Diagnostic): number =>
    (diagnostic.severity === "error" ? 0 : 2) + (isPresent(diagnostic.line) ? 0 : 1);
  // Array.prototype.sort 稳定：同档诊断保持 validator 产出顺序。
  const ordered = [...diagnostics].sort((left, right) => rank(left) - rank(right));
  const [first] = ordered;
  const location = [first.path, first.line, optionalWhen(isPresent(first.line), first.column)]
    .filter(isPresent)
    .join(":");
  const firstLine = truncateText(first.message.split("\n")[0].trim(), MaxHeadlineChars);
  return {
    headline: `${isEmpty(location) ? "" : `${location} `}${firstLine}（共 ${diagnostics.length} 条）`,
    details: {
      diagnostics: ordered.slice(0, MaxReportedDiagnostics).map((diagnostic) => ({
        ...diagnostic,
        message: truncateText(diagnostic.message, MaxDiagnosticMessageChars),
      })),
      diagnosticCount: diagnostics.length,
    },
  };
}

function validationFailed(transactionId: string, validation: ValidationResult): ProjectError {
  const envelope = diagnosticsEnvelope(validation.diagnostics);
  return new ProjectError(
    "VALIDATION_FAILED",
    `事务校验失败，未写入磁盘：${envelope.headline}`,
    {
      transactionId,
      ...envelope.details,
      failedChecks: [...new Set(validation.checks.filter((check) => !check.ok).map((check) => check.id))],
    },
    "请根据 diagnostics 修正编辑操作，然后重新准备事务。",
  );
}

function cloneStoredTransaction(transaction: StoredTransaction): StoredTransaction {
  return structuredClone(transaction);
}

const QueueRebaseFriendlyOperations = new Set<string>([
  "replace_text",
  "delete_text",
  "replace_symbol",
  "insert_before_symbol",
  "insert_after_symbol",
  "insert_around_symbol",
  "add_import",
  "remove_import",
  "append_text",
  "prepend_text",
  "insert_text_at_anchor",
]);

type StagedFileContent = Nullable<string>;

/**
 * 内核内存表里事务的真实形状：比 `PreparedTransaction` 多出三个终态与 `appliedAt`。
 * `PreparedTransaction.status` 被钉成字面量 `"prepared"`，只描述「刚 prepare 完」那一瞬，
 * 不足以表达生命周期；对外 API 暂未跟进（见 `getTransaction` 的欠账说明），本类型是内部真相。
 */
export type StoredTransaction = Omit<PreparedTransaction, "status"> & {
  status: PreparedTransaction["status"] | "applied" | "validated" | "rolled_back";
  appliedAt?: number;
};

// 内存治理上限：长会话内核常驻时，避免 target/evidence/已结束事务无界增长。
const MaxRetainedTargets = 500;
const MaxRetainedEvidence = 500;
const MaxRetainedTerminalTransactions = 200;
const DefaultImplicitSearchExcludeGlobs = ["node_modules/**", ".git/**", "dist/**", "coverage/**"] as const;
// 全部事务（含已准备未应用的）总量兜底；正常 prepare→apply 不受影响。
const MaxRetainedTransactions = 1000;

/** applyEdit 失败回滚所需的单个路径原始状态。 */
interface ApplyRestoreState {
  existedBefore: boolean;
  oldContent?: string;
  restorable: boolean;
}

type ProjectRuntimeProviders = ProjectProviders & {
  command: CommandProvider;
};

interface TransactionContentOverlay {
  contentByPath: Map<string, StagedFileContent>;
  diagnostics: Diagnostic[];
}

/** 事务安全的项目内核实现，统一协调 IO、适配器、校验和审计 hook。 */
class ProjectKernelImpl implements ProjectKernel, RegistrySink {
  readonly root: string;
  readonly policy: CorePolicy;
  readonly providers: ProjectRuntimeProviders;
  readonly changeFeed: ProjectChangeFeed;

  readonly journal = new AuditJournal();
  readonly hooks = new HookRegistry();
  readonly pipelines = new PipelineRegistry();
  readonly plugins = new PluginRegistry();
  readonly adapters = new AdapterRegistry();
  readonly patchStrategies = new PatchStrategyRegistry();
  readonly validators = new ValidatorRegistry();
  readonly fixers = new FixerRegistry();
  readonly locks = new LockManager();
  readonly transactionCoordinator = new TransactionCoordinator();
  readonly store: FileStore;
  private readonly changeFeedWriter: ProjectChangeFeedWriter;
  private readonly transactionState?: FileProjectTransactionStateStore;
  private readonly transactionProjections = new Map<string, ProjectChangeRecordInput>();

  private targets = new Map<string, ResolvedTarget>();
  private evidence = new Map<string, EvidencePack>();
  private transactions = new Map<string, StoredTransaction>();
  // 已结束（applied/rolled_back）事务的淘汰队列；超过上限时移除最旧的，避免内存无界增长。
  private terminalTransactionOrder: string[] = [];
  // 工作区根目录是否在 git work tree 内（会话内恒定，惰性探测一次后缓存）。
  private gitWorkTreeCache?: boolean;
  // 批处理工作池观测：当前在跑的批次数 + 最近一次批次的指标。
  private runningBatches = 0;
  private lastBatchMetrics?: BatchMetrics;

  constructor(options: CreateProjectKernelOptions) {
    this.root = path.resolve(options.root);
    this.policy = { ...DEFAULT_CORE_POLICY, ...(options.corePolicy ?? {}), approval: { ...DEFAULT_CORE_POLICY.approval, ...(options.corePolicy?.approval ?? {}) } };
    this.providers = {
      ...(options.providers ?? {}),
      command: options.providers?.command ?? createNodeCommandProvider(),
    };
    this.changeFeedWriter = options.changeFeed ?? new MemoryProjectChangeFeed();
    this.changeFeed = this.changeFeedWriter;
    this.store = new FileStore(
      this.root,
      this.policy,
      this.providers.fileFilter,
      this.providers.command
    );
    if (options.transactionStatePath) {
      this.transactionState = new FileProjectTransactionStateStore({
        path: options.transactionStatePath,
        root: this.root,
      });
      const durable = this.transactionState.snapshot();
      for (const transaction of durable.transactions) {
        this.transactions.set(transaction.transactionId, transaction);
        if (transaction.status === "applied" || transaction.status === "rolled_back") {
          this.terminalTransactionOrder.push(transaction.transactionId);
        }
      }
      for (const projection of durable.projections) {
        this.transactionProjections.set(projection.transactionId, projection);
      }
    }
  }

  private transactionStateValues(): StoredTransaction[] {
    return [...this.transactions.values()];
  }

  private transactionProjectionValues(): ProjectChangeRecordInput[] {
    return [...this.transactionProjections.values()];
  }

  private persistTransactionState(pending?: ProjectTransactionPendingOperation): void {
    this.transactionState?.commit({
      transactions: this.transactionStateValues(),
      projections: this.transactionProjectionValues(),
      pending,
    });
  }

  /**
   * apply/rollback 的文件与主状态已经提交后，Git 元数据或内存淘汰只属于附带治理。
   * 它们的二次快照失败不能把一个已经成功落盘的事务伪装成失败。
   */
  private persistCommittedTransactionState(transactionId: string, reason: string): void {
    try {
      this.persistTransactionState();
    } catch (error) {
      this.providers.logger?.warn?.("project.transactionState.postCommit.failed", {
        transactionId,
        reason,
        error: AppError.getMessage(error),
      });
    }
  }

  private transactionChangeProjection(
    tx: StoredTransaction,
    lifecycle: ProjectChangeLifecycle,
    newIntents: readonly EditIntent[] = [],
    revisions?: readonly ProjectChangeRevision[],
  ): ProjectChangeRecordInput {
    const previous = this.transactionProjections.get(tx.transactionId)
      ?? this.changeFeedWriter.get(tx.transactionId);
    const intents = [...(previous?.intents ?? []), ...newIntents];
    const reasons = [...new Set(intents.map((intent) => intent.reason?.trim()).filter(isPresent))];
    return {
      transactionId: tx.transactionId,
      lifecycle,
      reason: optionalWhen(!isEmpty(reasons), reasons.join("; ")),
      intents,
      patches: projectChangePatches(tx.patches),
      changedFiles: [...tx.changedFiles],
      diff: tx.diff,
      changedLines: tx.changedLines,
      risk: tx.risk,
      revisions: revisions ?? previous?.revisions ?? tx.baseSnapshots.map((snapshot) => ({
        path: snapshot.path,
        before: snapshot.revision,
      })),
      createdAt: tx.createdAt,
      appliedAt: tx.appliedAt,
    };
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
    const projection = this.transactionChangeProjection(tx, lifecycle, newIntents, revisions);
    const previousProjection = this.transactionProjections.get(tx.transactionId);
    const retainedTransaction = this.transactions.get(tx.transactionId);
    this.transactionProjections.set(tx.transactionId, projection);
    if (removeTransaction) this.transactions.delete(tx.transactionId);
    try {
      this.persistTransactionState();
    } catch (error) {
      if (previousProjection) this.transactionProjections.set(tx.transactionId, previousProjection);
      else this.transactionProjections.delete(tx.transactionId);
      if (removeTransaction && retainedTransaction) this.transactions.set(tx.transactionId, retainedTransaction);
      throw error;
    }
    try {
      this.changeFeedWriter.record(projection);
    } catch (error) {
      this.providers.logger?.warn?.("project.changeFeed.record.failed", {
        transactionId: tx.transactionId,
        lifecycle,
        error: AppError.getMessage(error),
      });
    }
  }

  private reconcileDurableChangeFeed(): void {
    for (const projection of this.transactionProjections.values()) {
      const current = this.changeFeedWriter.get(projection.transactionId);
      if (current?.lifecycle === projection.lifecycle
        && current.diff === projection.diff
        && current.appliedAt === projection.appliedAt) {
        continue;
      }
      try {
        this.changeFeedWriter.record(projection);
      } catch (error) {
        this.providers.logger?.warn?.("project.changeFeed.reconcile.failed", {
          transactionId: projection.transactionId,
          lifecycle: projection.lifecycle,
          error: AppError.getMessage(error),
        });
      }
    }
  }

  /** 安装插件，并记录插件接入事件。 */
  public async install(plugin: ProjectPlugin): Promise<void> {
    await this.plugins.install(plugin, this);
    this.journal.record({ actor: "system", action: "plugin.install", outputSummary: plugin.name });
  }

  public registerAdapterFactory(factory: FileAdapterFactory): void {
    this.adapters.register(factory);
  }

  public registerPatchStrategy(strategy: PatchStrategy): void {
    this.patchStrategies.register(strategy);
  }

  public registerValidator(validator: ProjectValidator): void {
    this.validators.register(validator);
  }

  public registerFixer(fixer: ProjectFixer): void {
    this.fixers.register(fixer);
  }

  public registerHook(hook: ProjectHook): void {
    this.hooks.register(hook);
  }

  public registerPipelineStage(stage: PipelineStage): void {
    this.pipelines.register(stage);
  }

  private async decide(
    action: PolicyDecisionInput["action"],
    paths?: string[],
    data?: unknown,
    risk: "low" | "medium" | "high" = "low",
    options?: { skipHighRiskUserApproval?: boolean },
  ): Promise<void> {
    // 策略 provider 可以直接拒绝，也可以要求再走一次审批。
    const providerDecision = await this.providers.policy?.decide({ action, paths, risk, data });
    if (providerDecision && !providerDecision.allow) {
      this.journal.record({ actor: "system", action: `policy.${action}`, inputSummary: paths?.join(","), outputSummary: providerDecision.reason, permissionDecision: "deny", risk });
      throw new ProjectError("PERMISSION_DENIED", providerDecision.reason ?? `策略拒绝执行 ${action}`);
    }
    const needsHighRiskApproval =
      risk === "high" &&
      this.policy.approval.requireForHighRiskPatch &&
      !options?.skipHighRiskUserApproval;
    if (providerDecision?.requireApproval || needsHighRiskApproval) {
      if (!this.providers.approval) {
        throw new ProjectError(
          "PERMISSION_DENIED",
          `${action} 需要审批，但宿主没有提供审批通道`,
          { action, paths, risk },
          "请在有用户审批上下文的宿主中重试，或缩小为非破坏性操作。",
        );
      }
      const approved = await this.providers.approval.approve({ action, paths, risk, reason: providerDecision?.reason ?? `${action} 需要审批`, data });
      if (isFalse(approved)) throw new ProjectError("PERMISSION_DENIED", `${action} 的审批被拒绝`);
    }
  }

  private async authorizePaths(
    paths: LooseOptional<readonly string[]>,
    action: "read" | "write" | "search" | "observe",
    deniedActionLabel: string,
  ): Promise<LooseOptional<string[]>> {
    if (!paths) return undefined;
    const authorized: string[] = [];
    for (const pathValue of paths) {
      const access = await this.store.authorize(pathValue, action, deniedActionLabel);
      authorized.push(access.rel);
    }
    return [...new Set(authorized)];
  }

  private async enrichSnapshot(snapshot: FileSnapshot): Promise<FileSnapshot> {
    if (!snapshot.exists || snapshot.isDirectory) return snapshot;
    const adapters = await this.adapters.createAdapters(snapshot, this);
    return { ...snapshot, adapterIds: adapters.map((a) => a.id) };
  }

  private async runGit(args: string[], timeoutMs = 10_000) {
    return this.providers.command.run({
      command: "git",
      args,
      cwd: this.root,
      timeoutMs,
    });
  }

  private async isInsideGitWorkTree(): Promise<boolean> {
    // 工作区根目录的 git 仓库归属在会话内是恒定的；缓存结果避免每次 apply/rollback 都新起 git 子进程。
    if (isPresent(this.gitWorkTreeCache)) return this.gitWorkTreeCache;
    const result = await this.runGit(["rev-parse", "--is-inside-work-tree"], 5_000);
    this.gitWorkTreeCache = result.exitCode === 0 && result.stdout.trim() === "true";
    return this.gitWorkTreeCache;
  }

  private async trackCreatedFilesInGit(paths: string[]): Promise<string[]> {
    const files = [...new Set(paths)].filter(Boolean);
    if (isEmpty(files) || !(await this.isInsideGitWorkTree())) return [];
    // intent-to-add 让新建文件进入 git diff 视野，但不会暂存文件内容。
    const result = await this.runGit(["add", "--intent-to-add", "--", ...files]);
    if (result.exitCode === 0) return files;
    this.providers.logger?.warn?.("project.git.trackCreatedFiles.failed", {
      files,
      stderr: result.stderr,
    });
    return [];
  }

  private async untrackCreatedFilesFromGit(paths: string[]): Promise<string[]> {
    const files = [...new Set(paths)].filter(Boolean);
    if (isEmpty(files) || !(await this.isInsideGitWorkTree())) return [];
    const result = await this.runGit(["rm", "--cached", "--ignore-unmatch", "--", ...files]);
    if (result.exitCode === 0) return files;
    this.providers.logger?.warn?.("project.git.untrackCreatedFiles.failed", {
      files,
      stderr: result.stderr,
    });
    return [];
  }

  private defaultExcludeGitignoredForRoot(root?: string): boolean | undefined {
    const normalizedRoot = root?.trim();
    // 显式搜索子目录时默认保留 ignored 子项，避免用户点名的目录被整体跳过。
    return optionalWhen((normalizedRoot && normalizedRoot !== "."), false);
  }

  private resolveSearchExcludeGlobs(input: SearchInput): string[] {
    return [
      ...this.defaultImplicitSearchExcludeGlobs(input.root),
      ...(input.exclude ?? []),
    ];
  }

  private defaultImplicitSearchExcludeGlobs(root?: string): string[] {
    const normalizedRoot = root?.trim();
    if (normalizedRoot && normalizedRoot !== ".") return [];
    return [...DefaultImplicitSearchExcludeGlobs];
  }

  /** 扫描工作区并返回文件快照列表。 */
  public async observe(input: ObserveInput = {}): Promise<ProjectSnapshot> {
    await this.decide("search", undefined, input);
    const processed = await this.pipelines.run("observe.input", input, this);
    const result = await this.store.observe(processed);
    this.journal.record({ actor: "system", action: "observe", outputSummary: `${result.files.length} files` });
    return result;
  }

  /** 列出工作区内符合条件的文件和目录。 */
  public async listFiles(input: ObserveInput = {}): Promise<FileListEntry[]> {
    await this.decide("search", undefined, input);
    return this.store.listFiles(input);
  }

  /** 返回单个路径的轻量状态信息和建议读取范围。 */
  public async stat(input: FileStatInput): Promise<FileStatResult> {
    const access = await this.store.authorize(input.path, "read", "读取");
    const authorizedInput = { ...input, path: access.rel };
    await this.decide("read", [access.rel], authorizedInput);
    return this.store.stat(authorizedInput, { skipFileFilter: true });
  }

  /** 读取工作区文件内容，并执行权限、管线和脱敏处理。 */
  public async read(input: ReadInput): Promise<ReadResult> {
    await this.hooks.emit("BeforeRead", this, input);
    const processed = await this.pipelines.run("read.input", input, this);
    const access = await this.store.authorize(processed.path, "read", "读取");
    const authorizedInput = { ...processed, path: access.rel };
    await this.decide("read", [access.rel], authorizedInput);
    let result = await this.store.read(authorizedInput, { skipFileFilter: true });
    result.snapshot = await this.enrichSnapshot(result.snapshot);
    if (result.content && this.providers.secretRedaction) {
      const redacted = await this.providers.secretRedaction.redact({ path: result.snapshot.path, content: result.content, trust: input.trust });
      result = { ...result, content: redacted.content };
    }
    await this.hooks.emit("AfterRead", this, result);
    this.journal.record({ actor: "system", action: "read", path: result.snapshot.path, outputSummary: result.content ? `${result.content.length} chars` : "binary/no content" });
    return result;
  }

  /** 在工作区内搜索文本，并优先使用可用的快速搜索后端。 */
  public async search(input: SearchInput): Promise<SearchResult> {
    await this.hooks.emit("BeforeSearch", this, input);
    await this.decide("search", undefined, input);
    const processed = await this.pipelines.run("search.input", input, this);
    const rootAccess = processed.root?.trim()
      ? await this.store.authorize(processed.root, "search", "搜索", { skipFileFilter: true })
      : null;
    const authorizedProcessed = rootAccess ? { ...processed, root: rootAccess.rel } : processed;
    const maxResults = processed.maxResults ?? 50;

    let backend: SearchResult["backend"];
    let hits: SearchHit[] = [];
    let truncated = false;
    let toolRequirements: SearchResult["toolRequirements"];

    const allowRg =
      this.policy.enableRipgrepSearch &&
      (processed.useRipgrep ?? true);

    if (allowRg) {
      try {
        const rgResult = await searchWithRipgrep({
          rootAbs: this.root,
          subdirRel: authorizedProcessed.root,
          query: authorizedProcessed.query,
          regex: !!processed.regex,
          caseSensitive: processed.caseSensitive,
          include: processed.include,
          exclude: this.resolveSearchExcludeGlobs(authorizedProcessed),
          excludeGitignored:
            processed.excludeGitignored ?? this.defaultExcludeGitignoredForRoot(authorizedProcessed.root),
          maxResults,
          command: this.providers.command,
          policy: this.policy,
        });
        if (rgResult.toolRequirements && !isEmpty(rgResult.toolRequirements)) {
          toolRequirements = rgResult.toolRequirements;
        }
        if (isNotNull(rgResult.hits)) {
          backend = "ripgrep";
          const enriched: SearchHit[] = [];
          // 同一文件可能有多条命中：按路径缓存 revision，避免对同一文件重复整文件读取 + 哈希。
          const revisionByPath = new Map<string, string>();
          for (const hit of rgResult.hits) {
            if (matchesAny(hit.path, this.policy.readDeny)) continue;
            try {
              let revision = revisionByPath.get(hit.path);
              if (isUndefined(revision)) {
                revision = (await this.store.snapshot(hit.path, false)).revision;
                revisionByPath.set(hit.path, revision);
              }
              let snippet = hit.snippet;
              if (snippet && this.providers.secretRedaction) {
                snippet = (
                  await this.providers.secretRedaction.redact({
                    path: hit.path,
                    content: snippet,
                    trust: { source: "project", trust: "untrusted" },
                  })
                ).content;
              }
              enriched.push({
                ...hit,
                revision,
                snippet,
                trust: { source: "project", trust: "untrusted" },
              });
            } catch {
              // arch-guard:silent-catch-ok 单条搜索命中可能已不可读，跳过后继续处理其它命中。
              continue;
            }
            if (enriched.length >= maxResults) break;
          }
          enriched.sort((a, b) => b.score - a.score);
          truncated = !!rgResult.timedOut || rgResult.hits.length >= maxResults || enriched.length >= maxResults;
          hits = enriched.slice(0, maxResults);
          const result: SearchResult = {
            query: authorizedProcessed.query,
            hits,
            truncated,
            backend,
            diagnostics: rgResult.diagnostics,
            toolRequirements,
          };
          await this.hooks.emit("AfterSearch", this, result);
          this.journal.record({
            actor: "system",
            action: "search",
            outputSummary: `${result.hits.length} hits`,
            inputSummary: `${authorizedProcessed.query} [rg]`,
          });
          return result;
        }
      } catch {
        // arch-guard:silent-catch-ok ripgrep 搜索失败时按设计回退到 adapter 搜索。
      }
    }

    const adapterSearch = await this.searchViaAdapters(authorizedProcessed, maxResults);
    backend = "adapters";
    hits = adapterSearch.hits;
    truncated = adapterSearch.truncated;
    const scannedFiles = adapterSearch.scannedFiles;

    const result: SearchResult = {
      query: authorizedProcessed.query,
      hits,
      truncated,
      backend,
      scannedFiles,
      toolRequirements,
    };
    await this.hooks.emit("AfterSearch", this, result);
    this.journal.record({
      actor: "system",
      action: "search",
      inputSummary: authorizedProcessed.query,
      outputSummary: `${result.hits.length} hits`,
    });
    return result;
  }

  /** 回退搜索：通过 adapter 扫描文件，每个文件限制命中数，再做全局合并。 */
  private async searchViaAdapters(
    processed: SearchInput,
    maxResults: number,
  ): Promise<{ hits: SearchHit[]; scannedFiles: number; truncated: boolean }> {
    // adapter 搜索更慢，但能在没有 ripgrep 或 ripgrep 失败时保持功能可用。
    const entries = await this.store.listFiles({
      path: processed.root,
      include: processed.include,
      exclude: this.resolveSearchExcludeGlobs(processed),
      excludeGitignored:
        processed.excludeGitignored ?? this.defaultExcludeGitignoredForRoot(processed.root),
      recursive: true,
      maxDepth: 20,
    });
    const files = entries.filter((e) => e.type === "file").map((e) => e.path);
    const perFileCap = Math.min(120, Math.max(maxResults * 2, 24));
    const hits: SearchHit[] = [];
    let scannedFiles = 0;
    let stoppedEarly = false;

    for (const file of files) {
      scannedFiles++;
      let snap: FileSnapshot;
      try {
        snap = await this.enrichSnapshot(await this.store.snapshot(file, true));
      } catch {
        // arch-guard:silent-catch-ok 搜索扫描按 best-effort 跳过不可读取文件。
        continue;
      }
      if (snap.isBinary || snap.size > this.policy.maxSearchFileSizeBytes) continue;
      if (matchesAny(snap.path, this.policy.readDeny)) continue;

      const adapters = await this.adapters.createAdapters(snap, this);
      for (const adapter of adapters) {
        if (!adapter.search) continue;
        const adapterHits = await adapter.search({
          snapshot: snap,
          query: processed.query,
          regex: processed.regex,
          maxResults: perFileCap,
          caseSensitive: processed.caseSensitive,
        });
        for (const hit of adapterHits) {
          let snippet = hit.snippet;
          if (snippet && this.providers.secretRedaction) {
            snippet = (
              await this.providers.secretRedaction.redact({
                path: hit.path,
                content: snippet,
                trust: { source: "project", trust: "untrusted" },
              })
            ).content;
          }
          hits.push({
            ...hit,
            snippet,
            revision: snap.revision,
            trust: { source: "project", trust: "untrusted" },
          });
        }
      }
      // 命中已够：不再扫描剩余文件（这是 ripgrep 不可用时的回退路径，停止整树读取+脱敏，
      // 避免命中很早就满足却仍把整个工作区读一遍）。停止即视为可能截断。
      if (hits.length >= maxResults) {
        stoppedEarly = true;
        break;
      }
    }

    hits.sort((a, b) => b.score - a.score);
    const truncated = stoppedEarly || hits.length > maxResults;
    return {
      hits: hits.slice(0, maxResults),
      scannedFiles,
      truncated,
    };
  }

  /** 收集指定文件中各适配器解析出的符号列表。 */
  public async listSymbols(pathInput: string): Promise<ProjectSymbol[]> {
    const snap = await this.enrichSnapshot(await this.store.snapshot(pathInput, true));
    const codeIntel = this.providers.codeIntelligence;
    // 只有宿主显式启用代码智能时才使用远端/索引后端，否则回退本地 adapter。
    if (codeIntel?.isProjectEnabled(this.root)) {
      try {
        const graphSymbols = await codeIntel.listSymbols({
          projectRoot: this.root,
          path: snap.path,
        });
        const projectSymbols = graphSymbols.map((symbol) => ({
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.line,
          column: symbol.column,
          endLine: symbol.endLine,
          endColumn: symbol.endColumn,
          exported: symbol.exported,
          nodeId: symbol.nodeId,
          signature: symbol.signature,
          adapterId: "code-intelligence",
          path: snap.path,
          range: {
            startLine: symbol.line,
            startColumn: symbol.column,
            endLine: symbol.endLine,
            endColumn: symbol.endColumn,
          },
        }));
        if (!isEmpty(projectSymbols)) return uniqueSymbols(projectSymbols);
      } catch {
        // arch-guard:silent-catch-ok 代码智能不可用时回退本地 adapter 符号解析。
      }
    }
    const adapters = await this.adapters.createAdapters(snap, this);
    const symbols: ProjectSymbol[] = [];
    for (const adapter of adapters) {
      const parsed = await adapter.parse?.({ snapshot: snap });
      if (parsed?.symbols) {
        symbols.push(
          ...parsed.symbols.map((symbol) => ({
            ...symbol,
            adapterId: adapter.id,
            path: snap.path,
            line: symbol.range.startLine,
            column: symbol.range.startColumn,
            endLine: symbol.range.endLine,
            endColumn: symbol.range.endColumn,
          })),
        );
      }
    }
    return uniqueSymbols(symbols);
  }

  /** 把路径、符号或文本线索解析成可复用的目标引用。 */
  public async resolveTarget(input: ResolveTargetInput): Promise<ResolveTargetResult> {
    await this.hooks.emit("BeforeResolve", this, input);
    const processed = await this.pipelines.run("resolve.input", input, this);
    const access = await this.store.authorize(processed.path, "read", "读取");
    const authorizedInput = { ...processed, path: access.rel };
    await this.decide("resolve", [access.rel], authorizedInput);
    const snap = await this.enrichSnapshot(await this.store.snapshot(authorizedInput.path, true, {
      skipFileFilter: true,
    }));
    const codeIntel = this.providers.codeIntelligence;
    const symbolName = authorizedInput.target?.symbol?.name;
    // 只有宿主显式启用代码智能时才查询定义，否则回退 adapter resolveTarget。
    if (codeIntel?.isProjectEnabled(this.root) && symbolName) {
      try {
        const lineHint = authorizedInput.target?.lineHint;
        const locations = await codeIntel.getDefinition({
          projectRoot: this.root,
          path: snap.path,
          line: lineHint?.startLine ?? 1,
          column: 1,
          symbol: symbolName,
        });
        const match = locations[0];
        if (match) {
          const target: ResolvedTarget = {
            targetId: `code-intel:${match.nodeId ?? match.path}:${match.line}`,
            path: match.path,
            kind: "symbol",
            symbol: {
              kind: authorizedInput.target?.symbol?.kind ?? "symbol",
              name: symbolName,
              container: authorizedInput.target?.symbol?.container,
            },
            range: {
              startLine: match.line,
              startColumn: match.column,
              endLine: match.endLine,
              endColumn: match.endColumn,
            },
            anchors: {},
            confidence: 0.9,
            baseRevision: snap.revision,
            sha256: snap.sha256 ?? "",
            expectedMatches: authorizedInput.expectedMatches ?? 1,
            adapterId: "code-intelligence",
          };
          this.targets.set(target.targetId, target);
          const resolved = { status: "resolved" as const, target };
          await this.hooks.emit("AfterResolve", this, resolved);
          return resolved;
        }
      } catch {
        // arch-guard:silent-catch-ok 代码智能解析失败时回退 adapter resolveTarget。
      }
    }
    const adapters = await this.adapters.createAdapters(snap, this);
    const ambiguous: ResolvedTarget[] = [];
    for (const adapter of adapters) {
      if (!adapter.resolveTarget) continue;
      const result = await adapter.resolveTarget({ ...authorizedInput, snapshot: snap });
      if (result.status === "resolved") {
        this.targets.set(result.target.targetId, result.target);
        this.capInsertionOrderedMap(this.targets, MaxRetainedTargets);
        await this.hooks.emit("AfterResolve", this, result);
        this.journal.record({ actor: "system", action: "resolve_target", path: result.target.path, targetId: result.target.targetId, outputSummary: `${result.target.kind}:${result.target.confidence}` });
        return result;
      }
      if (result.status === "ambiguous") ambiguous.push(...result.candidates);
    }
    if (!isEmpty(ambiguous)) return { status: "ambiguous", candidates: ambiguous, reason: `找到 ${ambiguous.length} 个候选目标` };
    return { status: "not_found", reason: "没有 adapter 能解析该目标" };
  }

  /** 为一次任务创建带唯一 id 和时间戳的上下文。 */
  public createTaskContext(input: Omit<TaskContext, "taskId" | "createdAt">): TaskContext {
    return { ...input, taskId: id("task"), createdAt: Date.now() };
  }

  /** 基于目标或路径范围构建可引用的证据包。 */
  public async buildEvidencePack(input: BuildEvidencePackInput): Promise<EvidencePack> {
    const evidenceId = id("evidence");
    const inputTargetId = input.target?.targetId;
    const storedTarget = inputTargetId ? this.getTarget(inputTargetId) : undefined;
    const targetPath = storedTarget?.path ?? input.target?.path;
    const targetRange = resolveEvidenceTargetRange(storedTarget, input.target?.range);
    const targetBaseRevision = storedTarget?.baseRevision ?? input.target?.baseRevision;
    const includeCurrentWindow = input.include?.currentWindow ?? Boolean(targetPath && targetRange);
    let freshContext: EvidencePack["freshContext"];

    if (includeCurrentWindow && targetPath && targetRange) {
      // Evidence 只截取目标附近的新鲜窗口，不把整文件塞进上下文。
      const before = Math.max(0, input.include?.windowLinesBefore ?? 5);
      const after = Math.max(0, input.include?.windowLinesAfter ?? 5);
      const contextStart = Math.max(1, targetRange.startLine - before);
      const contextEnd = Math.max(contextStart, targetRange.endLine + after);
      const read = await this.read({
        path: targetPath,
        baseRevision: targetBaseRevision,
        range: { startLine: contextStart, endLine: contextEnd },
        maxBytes: 80_000,
      });
      const revision = read.snapshot.revision ?? targetBaseRevision;
      const contextRange = read.range ?? { startLine: contextStart, endLine: contextEnd };
      let currentWindow = read.content;
      if (currentWindow && this.providers.secretRedaction) {
        currentWindow = (await this.providers.secretRedaction.redact({ path: read.snapshot.path, content: currentWindow, trust: { source: "project", trust: "untrusted" } })).content;
      }

      const suggestedReads: NonNullable<EvidencePack["freshContext"]>["suggestedReads"] = [];
      if (contextRange.startLine > 1) {
        suggestedReads.push({
          path: read.snapshot.path,
          range: {
            startLine: Math.max(1, contextRange.startLine - Math.max(before, 20)),
            endLine: contextRange.startLine - 1,
          },
          reason: "before-context",
        });
      }
      if (read.hasMore) {
        suggestedReads.push({
          path: read.snapshot.path,
          range: {
            startLine: contextRange.endLine + 1,
            endLine: contextRange.endLine + Math.max(after, 20),
          },
          reason: "after-context",
        });
      }

      freshContext = {
        currentWindow,
        path: read.snapshot.path,
        revision,
        targetRange,
        contextRange,
        citation: {
          path: read.snapshot.path,
          revision,
          range: targetRange,
        },
        hasMoreBefore: contextRange.startLine > 1,
        hasMoreAfter: !!read.hasMore,
        suggestedReads,
        metadata: input.metadata,
      };
    }
    const task = input.task
      ? {
          description: input.task.description,
          goal: input.task.goal,
          userConstraints: input.task.userConstraints,
          successCriteria: input.task.successCriteria,
          riskLevel: input.task.riskLevel,
        }
      : undefined;
    let pack: EvidencePack = {
      evidenceId,
      task,
      target: storedTarget,
      editScope: input.editScope ?? {},
      freshContext,
      trust: { projectContentIsUntrusted: true, redactedSecrets: !!this.providers.secretRedaction },
      metadata: input.metadata,
    };
    const builtByContextProvider = await this.providers.context?.buildEvidence?.(pack);
    if (builtByContextProvider && isObject(builtByContextProvider)) {
      pack = { ...pack, metadata: { ...(pack.metadata ?? {}), contextProvider: builtByContextProvider } };
    }
    const sanitizedByContextProvider = await this.providers.context?.sanitize?.(pack);
    if (sanitizedByContextProvider && isObject(sanitizedByContextProvider)) {
      pack = { ...(sanitizedByContextProvider as EvidencePack), evidenceId: (sanitizedByContextProvider as EvidencePack).evidenceId ?? evidenceId };
    }
    this.evidence.set(evidenceId, pack);
    this.capInsertionOrderedMap(this.evidence, MaxRetainedEvidence);
    this.journal.record({ actor: "system", action: "build_evidence", targetId: input.target?.targetId, outputSummary: evidenceId });
    return pack;
  }

  private getTarget(targetId?: string): ResolvedTarget | undefined {
    return targetId ? this.targets.get(targetId) : undefined;
  }

  /** 按插入顺序淘汰最旧的条目，把 Map 体积约束在上限内（Map 保留插入顺序）。 */
  private capInsertionOrderedMap(map: Map<string, unknown>, maxSize: number): void {
    while (map.size > maxSize) {
      const oldest = map.keys().next().value;
      if (isUndefined(oldest)) break;
      map.delete(oldest);
    }
  }

  /** 记录已结束事务，并在超过保留上限时淘汰最旧的事务记录（保留磁盘外的内存治理）。 */
  private retainTerminalTransaction(transactionId: string): void {
    this.terminalTransactionOrder = this.terminalTransactionOrder.filter((idValue) => idValue !== transactionId);
    this.terminalTransactionOrder.push(transactionId);
    while (this.terminalTransactionOrder.length > MaxRetainedTerminalTransactions) {
      const oldest = this.terminalTransactionOrder.shift();
      if (isPresent(oldest) && oldest !== transactionId) this.transactions.delete(oldest);
    }
  }

  /** 写盘前捕获每个受影响路径的原始状态，供 apply 失败时回滚（只读，不改写盘语义）。 */
  private async captureApplyRestoreState(
    paths: readonly string[],
  ): Promise<Map<string, ApplyRestoreState>> {
    const restoreByPath = new Map<string, ApplyRestoreState>();
    for (const file of paths) {
      if (restoreByPath.has(file)) continue;
      const before = await this.store.snapshot(file, true, { skipFileFilter: true });
      restoreByPath.set(file, {
        existedBefore: before.exists && !before.isDirectory,
        // 仅文本文件可按字符串还原；二进制/超限文件无法捕获正文，回滚时尽力而为。
        oldContent: optionalWhen(isString(before.content), before.content),
        restorable: isString(before.content) || !before.exists || before.isDirectory,
      });
    }
    return restoreByPath;
  }

  private transactionOwnedStates(
    tx: StoredTransaction,
    kind: ProjectTransactionPendingOperation["kind"],
    pathValue: string,
  ): ProjectTransactionFileState[] {
    const patches = kind === "apply" ? tx.patches : [...tx.patches].reverse();
    const states: ProjectTransactionFileState[] = [];
    for (const patchValue of patches) {
      if (patchValue.path !== pathValue) continue;
      const op = patchValue.metadata?.op;
      const deletes = kind === "apply"
        ? op === "delete_file" || op === "rename_file_delete"
        : op === "create_file" || op === "rename_file_create";
      states.push(deletes
        ? { exists: false }
        : {
            exists: true,
            content: kind === "apply" ? patchValue.newContent ?? "" : patchValue.oldContent ?? "",
          });
    }
    return states;
  }

  private durableRestorePlan(
    tx: StoredTransaction,
    kind: ProjectTransactionPendingOperation["kind"],
    restoreByPath: Map<string, ApplyRestoreState>,
  ): ProjectTransactionRestoreEntry[] {
    const plan: ProjectTransactionRestoreEntry[] = [];
    for (const pathValue of tx.changedFiles) {
      const restore = restoreByPath.get(pathValue);
      if (!restore?.restorable || (restore.existedBefore && !isString(restore.oldContent))) {
        throw new ProjectError(
          "PATCH_APPLY_ERROR",
          `事务 ${tx.transactionId} 无法建立可恢复写盘计划：${pathValue}`,
          { transactionId: tx.transactionId, path: pathValue, operation: kind },
          "请把二进制或超限文件拆出该事务；可恢复事务只写入能够完整捕获旧正文的文件。",
        );
      }
      const ownedStates = this.transactionOwnedStates(tx, kind, pathValue);
      if (isEmpty(ownedStates)) {
        throw new ProjectError(
          "PATCH_APPLY_ERROR",
          `事务 ${tx.transactionId} 的路径缺少可验证写盘状态：${pathValue}`,
          { transactionId: tx.transactionId, path: pathValue, operation: kind },
        );
      }
      plan.push({
        path: pathValue,
        exists: restore.existedBefore,
        ...(restore.existedBefore ? { content: restore.oldContent! } : {}),
        ownedStates,
      });
    }
    return plan;
  }

  private fileStateMatches(
    snapshot: FileSnapshot,
    state: ProjectTransactionFileState,
  ): boolean {
    if (!state.exists) return !snapshot.exists;
    return snapshot.exists
      && !snapshot.isDirectory
      && !snapshot.isBinary
      && snapshot.content === state.content;
  }

  private async restoreDurableOperation(pending: ProjectTransactionPendingOperation): Promise<void> {
    const tx = this.transactions.get(pending.transactionId);
    if (!tx) {
      throw new ProjectError(
        "TRANSACTION_RECOVERY_CONFLICT",
        `可恢复操作引用了不存在的事务：${pending.transactionId}`,
        { pending },
      );
    }
    for (const restore of [...pending.restore].reverse()) {
      const current = await this.store.snapshot(restore.path, true, { skipFileFilter: true });
      if (this.fileStateMatches(current, restore)) continue;
      if (!restore.ownedStates.some((state) => this.fileStateMatches(current, state))) {
        throw new ProjectError(
          "TRANSACTION_RECOVERY_CONFLICT",
          `事务恢复拒绝覆盖无法归属于本事务的外部内容：${restore.path}`,
          {
            transactionId: pending.transactionId,
            operation: pending.kind,
            path: restore.path,
            actualRevision: current.revision,
          },
          "请先人工保全当前文件，再决定保留外部内容还是事务恢复点。",
        );
      }
      if (restore.exists) {
        await this.store.write(restore.path, restore.content!, { skipFileFilter: true });
      } else {
        await this.store.remove(restore.path, { skipFileFilter: true });
      }
    }
    tx.status = pending.previousStatus;
    this.persistTransactionState();
  }

  private beginDurableOperation(
    tx: StoredTransaction,
    kind: ProjectTransactionPendingOperation["kind"],
    restoreByPath: Map<string, ApplyRestoreState>,
  ): ProjectTransactionPendingOperation | undefined {
    if (!this.transactionState) return undefined;
    const pending: ProjectTransactionPendingOperation = {
      kind,
      transactionId: tx.transactionId,
      previousStatus: tx.status,
      restore: this.durableRestorePlan(tx, kind, restoreByPath),
    };
    this.persistTransactionState(pending);
    return pending;
  }

  public async initializeTransactionState(): Promise<void> {
    const pending = this.transactionState?.snapshot().pending;
    if (pending) await this.restoreDurableOperation(pending);
    this.reconcileDurableChangeFeed();
  }

  /** apply 写盘失败时，按逆序把已写文件还原到本次 apply 前的状态，使多文件写入保持原子性。 */
  private async restoreAppliedFiles(
    writtenOrder: readonly string[],
    restoreByPath: Map<string, ApplyRestoreState>,
    transactionId: string,
  ): Promise<void> {
    for (const file of [...writtenOrder].reverse()) {
      const restore = restoreByPath.get(file);
      if (!restore) continue;
      try {
        if (restore.existedBefore) {
          if (isString(restore.oldContent)) {
            await this.store.write(file, restore.oldContent, { skipFileFilter: true });
          } else {
            // 无法捕获旧正文（二进制/超限文件），只能记录而非静默放过。
            this.providers.logger?.warn?.("project.apply.restore.skippedBinaryOrOversize", {
              transactionId,
              path: file,
            });
          }
        } else {
          // 原本不存在的文件在回滚中删除，撤销本次创建。
          await this.store.remove(file, { skipFileFilter: true });
        }
      } catch (restoreError) {
        // arch-guard:silent-catch-ok 还原失败不覆盖原始写入错误；记录后继续还原其余文件。
        this.providers.logger?.warn?.("project.apply.restore.failed", {
          transactionId,
          path: file,
          error: AppError.getMessage(restoreError),
        });
      }
    }
  }

  private isDeletePatch(patchValue: PreparedPatch): boolean {
    const op = patchValue.metadata?.op;
    return op === "delete_file" || op === "rename_file_delete";
  }

  private isCreatePatch(patchValue: PreparedPatch): boolean {
    const op = patchValue.metadata?.op;
    return op === "create_file" || op === "rename_file_create";
  }

  /** 补丁写下之后该路径的暂存内容；`null` 表示本事务已删除该文件。 */
  private stagedContentAfter(patchValue: PreparedPatch): StagedFileContent {
    return this.isDeletePatch(patchValue) ? null : patchValue.newContent ?? "";
  }

  /**
   * 同一路径上的后继补丁必须建立在前一补丁的产出（`staged`）之上。prepare 已按顺序衔接，
   * 这里只在链条断开时重新推导：apply 前该路径首个补丁被 rebase，或旧版本持久化的补丁各自
   * 基于原文。推导不出返回 null，由调用方记为诊断或冲突——绝不退回「后写覆盖先写」。
   */
  private async chainPatch(
    patchValue: PreparedPatch,
    staged: StagedFileContent,
  ): Promise<Nullable<PreparedPatch>> {
    // 新建类补丁整文件写入，不依赖前一状态。
    if (this.isCreatePatch(patchValue)) return patchValue;
    if (!isString(staged)) return null;
    if (patchValue.oldContent === staged) return patchValue;
    return this.tryRebasePatch(patchValue, await this.snapshotWithContent(patchValue.path, staged));
  }

  /**
   * 事务视角下某路径的当前快照：本事务已暂存的内容优先（`null` 读成不存在），首次触碰才读磁盘。
   */
  private async transactionSnapshot(
    pathValue: string,
    stagedByPath: ReadonlyMap<string, StagedFileContent>,
  ): Promise<FileSnapshot> {
    const staged = stagedByPath.get(pathValue);
    if (isString(staged)) return this.snapshotWithContent(pathValue, staged);
    if (isUndefined(staged)) return this.enrichSnapshot(await this.store.snapshot(pathValue, true));
    const disk = await this.store.snapshot(pathValue, false);
    return {
      path: disk.path,
      absPath: disk.absPath,
      exists: false,
      isDirectory: false,
      isBinary: false,
      size: 0,
      sha256: disk.sha256,
      revision: `staged:${disk.revision}`,
      mtimeMs: disk.mtimeMs,
      adapterIds: [],
    };
  }

  private async snapshotWithContent(pathValue: string, content: string): Promise<FileSnapshot> {
    const snapshot = await this.store.snapshot(pathValue, true);
    return this.enrichSnapshot({
      ...snapshot,
      exists: true,
      isDirectory: false,
      isBinary: false,
      content,
      size: content.length,
      encoding: "utf8",
      revision: `staged:${snapshot.revision}`,
    });
  }

  /**
   * 给 validator / fixer 的读文件入口：事务暂存态优先，缺席才落到磁盘。
   * 暂存值为 `null` 表示「本事务把这个文件删了」，要读成"不存在"（undefined）而不是空串——
   * 空串会让校验器把删文件当成"清空文件"来验。
   */
  private createOverlayFileReader(
    contentByPath: Map<string, StagedFileContent>,
  ): (pathValue: string) => Promise<string | undefined> {
    return async (pathValue: string) => {
      if (contentByPath.has(pathValue)) {
        const stagedContent = contentByPath.get(pathValue);
        return isNull(stagedContent) ? undefined : stagedContent;
      }
      return (await this.read({ path: pathValue })).content;
    };
  }

  private async buildTransactionContentOverlay(
    transactionId?: string,
  ): Promise<TransactionContentOverlay> {
    // 重放已准备补丁，让校验器和修复器在写盘前看到暂存态内容。
    const contentByPath = new Map<string, StagedFileContent>();
    const diagnostics: Diagnostic[] = [];
    const tx = transactionId ? this.transactions.get(transactionId) : undefined;
    if (!tx) return { contentByPath, diagnostics };

    // 与 apply 预检共用 `chainPatch` 衔接规则：校验看到的内容就是 apply 将写下的内容。
    for (const patchValue of tx.patches) {
      const staged = contentByPath.get(patchValue.path);
      let chained: Nullable<PreparedPatch>;
      try {
        chained = isUndefined(staged) ? patchValue : await this.chainPatch(patchValue, staged);
      } catch (error) {
        // arch-guard:silent-catch-ok 重放失败归档为 transaction diagnostic，由 validate / amend 统一报告。
        diagnostics.push({
          severity: "error",
          path: patchValue.path,
          source: "core.transaction-replay",
          message: `重放同一文件的后续补丁失败：${AppError.getMessage(error)}`,
        });
        continue;
      }
      if (!chained) {
        diagnostics.push({
          severity: "error",
          path: patchValue.path,
          source: "core.transaction-replay",
          message: "同一文件的后续补丁无法衔接到前面补丁的结果上，事务不能按顺序重放。",
          data: { patchId: patchValue.patchId, operation: patchValue.metadata?.op },
        });
        continue;
      }
      contentByPath.set(patchValue.path, this.stagedContentAfter(chained));
    }

    return { contentByPath, diagnostics };
  }

  private async prepareTransaction(
    input: PrepareEditInput,
    options: {
      contentOverlay?: Map<string, StagedFileContent>;
      forcePatchBaseRevision?: "none";
      store?: boolean;
    } = {},
  ): Promise<PreparedTransaction> {
    // 从文件系统角度看，prepare 只生成补丁预览，不写盘。
    const processed = await this.pipelines.run("prepare.input", input, this);
    const patches: PreparedPatch[] = [];
    const baseSnapshots: FileSnapshot[] = [];
    // 按操作顺序暂存每个路径的最新内容：后续操作基于它生成补丁，使同一路径的补丁首尾相接；
    // amendment 从已暂存事务的重放结果起步，锚点才能命中前面补丁产生的内容。
    const stagedByPath = new Map<string, StagedFileContent>(options.contentOverlay ?? []);

    for (const intent of processed.operations) {
      const target = this.getTarget(intent.targetId);
      let snapshot: FileSnapshot | undefined;
      const pathForOp = target?.path ?? operationPath(intent.operation);
      let renameTargetSnapshot: FileSnapshot | undefined;
      if (pathForOp) {
        // revision 前置校验只在首次触碰时做：暂存内容是本事务自己的产物，不对应任何磁盘 revision。
        const isStaged = stagedByPath.has(pathForOp);
        if (target && isStaged) {
          throw new ProjectError(
            "INVALID_INPUT",
            `${pathForOp} 已被本事务前面的操作修改，targetId 基于磁盘 revision 的定位已失效`,
            { path: pathForOp, targetId: target.targetId, expected: target.baseRevision },
            "同一文件的后续操作请改用 path 加 oldText / anchorText / symbol 定位，或拆成单独事务。",
          );
        }
        snapshot = await this.transactionSnapshot(pathForOp, stagedByPath);
        if (target && this.policy.requireBaseRevision && snapshot.revision !== target.baseRevision) {
          throw revisionMismatch(`${target.path} 的目标 revision 已变化`, { expected: target.baseRevision, actual: snapshot.revision });
        }
        const requestedBaseRevision = processed.baseRevisions?.[pathForOp] ?? processed.baseRevision;
        if (!target && this.policy.requireBaseRevision && !isStaged && requestedBaseRevision && snapshot.revision !== requestedBaseRevision) {
          throw revisionMismatch(`${pathForOp} 的文件 revision 已变化`, {
            path: pathForOp,
            expected: requestedBaseRevision,
            actual: snapshot.exists ? snapshot.revision : "deleted",
          });
        }
        if (intent.operation.type === "rename_file") {
          const renameTargetIsStaged = stagedByPath.has(intent.operation.to);
          renameTargetSnapshot = await this.transactionSnapshot(intent.operation.to, stagedByPath);
          if (renameTargetSnapshot.exists) {
            throw new ProjectError(
              "CONFLICT_WITH_EXTERNAL_EDIT",
              `重命名目标已存在，拒绝覆盖：${intent.operation.to}`,
              { path: intent.operation.to, actual: renameTargetSnapshot.revision },
              "请选择一个不存在的目标路径，或先单独处理现有目标文件。",
            );
          }
          const requestedTargetRevision = processed.baseRevisions?.[intent.operation.to];
          if (!renameTargetIsStaged && requestedTargetRevision && renameTargetSnapshot.revision !== requestedTargetRevision) {
            throw revisionMismatch(`${intent.operation.to} 的目标 revision 已变化`, {
              path: intent.operation.to,
              expected: requestedTargetRevision,
              actual: "deleted",
            });
          }
          if (!renameTargetIsStaged) baseSnapshots.push(renameTargetSnapshot);
        }
        if (!isStaged) baseSnapshots.push(snapshot);
      }

      const adapters = snapshot ? await this.adapters.createAdapters(snapshot, this) : [];
      let adapterPrepared: PreparedPatch[] | undefined;
      // 文件 adapter 优先处理，以便生成更懂语言结构的补丁。
      for (const adapter of adapters) {
        if (adapter.prepareEdit && snapshot) {
          adapterPrepared = await adapter.prepareEdit({ ...processed, operations: [intent], snapshot });
          if (adapterPrepared?.length) break;
        }
      }
      let intentPatches: PreparedPatch[];
      if (adapterPrepared?.length) intentPatches = adapterPrepared;
      else {
        const strategy = this.patchStrategies.select({ intent, target, snapshot, policy: this.policy });
        intentPatches = await strategy.prepare({ intent, target, snapshot, policy: this.policy });
      }
      if (renameTargetSnapshot) {
        intentPatches = intentPatches.map((patchValue) =>
          patchValue.metadata?.op === "rename_file_create"
            ? { ...patchValue, baseRevision: renameTargetSnapshot.revision }
            : patchValue
        );
      }
      for (const patchValue of intentPatches) {
        stagedByPath.set(patchValue.path, this.stagedContentAfter(patchValue));
      }
      patches.push(...this.withIntentMetadata(intentPatches, intent));
    }

    const preparedPatches =
      options.forcePatchBaseRevision === "none"
        ? patches.map((patchValue) => ({ ...patchValue, baseRevision: undefined }))
        : patches;

    const summary = this.summarizePatches(preparedPatches);
    this.assertScopeWithinPolicy(summary.changedFiles, summary.changedLines);

    const tx: PreparedTransaction = {
      transactionId: id("tx"),
      status: "prepared",
      patches: preparedPatches,
      ...summary,
      createdAt: Date.now(),
      baseSnapshots,
      metadata: processed.metadata,
    };
    if (options.store ?? true) {
      this.transactions.set(tx.transactionId, tx);
      // 兜底上限：约束「已准备但从未 apply/rollback」的被遗弃事务无界增长。
      // 刚写入的事务在插入顺序中最新，正常 prepare→apply 流程不会被淘汰。
      this.capInsertionOrderedMap(this.transactions, MaxRetainedTransactions);
    }
    return tx;
  }

  private refreshTransactionSummary(tx: StoredTransaction): void {
    Object.assign(tx, this.summarizePatches(tx.patches));
  }

  /**
   * 事务摘要描述每个文件的**净变化**（事务前 → 最终内容）。同一文件的多个补丁首尾相接，逐补丁
   * diff 的拼接会把中间态 hunk 叠在一起，行数也被重复计算；模型与审批看到的必须就是将要写下的。
   * 单补丁文件直接沿用补丁自带的 diff，保留策略/插件自己的 diff 表达。
   */
  private summarizePatches(
    patches: readonly PreparedPatch[],
  ): Pick<PreparedTransaction, "changedFiles" | "diff" | "changedLines" | "risk"> {
    const patchesByPath = new Map<string, PreparedPatch[]>();
    for (const patchValue of patches) {
      patchesByPath.set(patchValue.path, [...(patchesByPath.get(patchValue.path) ?? []), patchValue]);
    }
    const fileDiffs = [...patchesByPath.entries()].map(([pathValue, pathPatches]) => {
      const [first] = pathPatches;
      if (pathPatches.length === 1) return { diff: first.diff, changedLines: first.changedLines };
      const finalContent = this.stagedContentAfter(pathPatches[pathPatches.length - 1]);
      const diff = unifiedDiff(pathValue, first.oldContent ?? "", finalContent ?? "");
      return { diff, changedLines: countChangedLines(diff) };
    });
    const changedFiles = [...patchesByPath.keys()];
    const changedLines = fileDiffs.reduce((sum, fileDiff) => sum + fileDiff.changedLines, 0);
    return {
      changedFiles,
      diff: combineDiffs(fileDiffs.map((fileDiff) => fileDiff.diff)),
      changedLines,
      risk: this.resolveTransactionRisk(patches, changedFiles, changedLines),
    };
  }

  private resolveTransactionRisk(
    patches: readonly PreparedPatch[],
    changedFiles: readonly string[],
    changedLines: number,
  ): RiskLevel {
    const destructive = patches.some((patchValue) => {
      const op = patchValue.metadata?.op;
      return op === "delete_file"
        || op === "rename_file_delete"
        || (op === "create_file" && isTrue(patchValue.metadata?.overwrite));
    });
    if (destructive) return "high";

    const createsFile = patches.some((patchValue) => patchValue.metadata?.op === "create_file");
    const broadChange = changedFiles.length > this.policy.maxChangedFilesPerTransaction / 2
      || changedLines > this.policy.maxChangedLinesPerTransaction / 2;
    return createsFile || broadChange ? "medium" : "low";
  }

  /**
   * 事务规模与受保护文件的**唯一**判定点：prepare（首次成型）与 amend（追加后重算）都走它。
   * 判据：两条路径此前各写了一份完全相同的三项检查，任何一侧改阈值/加规则都会留下另一侧的
   * 缺口——而缺口只在「amend 把事务撑过阈值」这种少见路径上暴露。
   */
  private assertScopeWithinPolicy(changedFiles: readonly string[], changedLines: number): void {
    if (changedFiles.length > this.policy.maxChangedFilesPerTransaction) {
      throw new ProjectError(
        "SCOPE_VIOLATION",
        `变更文件过多：${changedFiles.length}`,
        { actual: changedFiles.length, maximum: this.policy.maxChangedFilesPerTransaction },
        `请按独立意图拆成每批最多 ${this.policy.maxChangedFilesPerTransaction} 个文件的多个原子事务。`,
      );
    }
    if (changedLines > this.policy.maxChangedLinesPerTransaction) {
      throw new ProjectError(
        "SCOPE_VIOLATION",
        `变更行数过多：${changedLines}`,
        { actual: changedLines, maximum: this.policy.maxChangedLinesPerTransaction },
        `请按独立意图拆成每批最多 ${this.policy.maxChangedLinesPerTransaction} 行的多个原子事务。`,
      );
    }
    for (const file of changedFiles) {
      if (matchesAny(file, this.policy.protectedFiles)) throw new ProjectError("PROTECTED_FILE", `受保护文件被修改：${file}`);
    }
  }

  /** 根据编辑意图生成待应用事务，但不修改磁盘文件。 */
  public async prepareEdit(input: PrepareEditInput): Promise<PreparedTransaction> {
    await this.hooks.emit("BeforePrepareEdit", this, input);
    await this.decide("prepare_edit", undefined, input);
    const transactionsBeforePrepare = new Map(this.transactions);
    const tx = await this.prepareTransaction(input);
    try {
      this.publishTransactionChange(tx, "prepared", input.operations);
    } catch (error) {
      this.transactions = transactionsBeforePrepare;
      throw error;
    }
    await this.hooks.emit("AfterPrepareEdit", this, tx);
    this.journal.record({ actor: "system", action: "prepare_edit", transactionId: tx.transactionId, outputSummary: `${tx.changedFiles.length} 个文件，${tx.changedLines} 行变更`, risk: tx.risk });
    return tx;
  }

  private async runTransactionCommand<T>(
    transactionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.transactionCoordinator.run(transactionId, action);
  }

  /**
   * 丢弃一个尚未应用的已暂存事务，把它从内存事务表移除。
   * 用于 dryRun 预览：预览只想看 diff，不该留下可被 commit 或污染 `diff()` 合并的暂存事务。
   * 已应用的事务不能用本方法（应走 rollback）。
   */
  public discardTransaction(transactionId: string): { discarded: boolean } {
    if (this.transactionCoordinator.isBusy(transactionId)) {
      throw new ProjectError(
        "INVALID_INPUT",
        `事务正在执行，不能丢弃：${transactionId}`,
        { transactionId },
        "请等待当前事务操作完成后，再根据最新事务状态决定是否丢弃。",
      );
    }
    const tx = this.transactions.get(transactionId);
    if (!tx) return { discarded: false };
    if (tx.appliedAt || tx.status === "applied") {
      throw new ProjectError("INVALID_INPUT", `只能丢弃尚未应用的事务：${transactionId}`);
    }
    this.publishTransactionChange(tx, "discarded", [], undefined, true);
    return { discarded: true };
  }

  /** 在尚未应用的事务上追加编辑操作并刷新事务摘要。 */
  public async amendEdit(input: AmendEditInput): Promise<PreparedTransaction> {
    return this.runTransactionCommand(input.transactionId, () => this.amendEditSerialized(input));
  }

  private async amendEditSerialized(input: AmendEditInput): Promise<PreparedTransaction> {
    await this.hooks.emit("BeforePrepareEdit", this, input);
    const tx = this.transactions.get(input.transactionId);
    if (!tx) throw new ProjectError("INVALID_INPUT", `未知事务：${input.transactionId}`);
    if (tx.appliedAt || tx.status === "applied" || tx.status === "rolled_back") {
      throw new ProjectError("INVALID_INPUT", `只能修补尚未应用的事务：${input.transactionId}`);
    }
    // 同一个 Map value 的两种视图：`tx` 带终态字段用于上面的守卫，`preparedTx` 是收窄后的对外形状。
    const preparedTx = this.getTransaction(input.transactionId)!;
    await this.decide("amend_edit", tx.changedFiles, input, tx.risk);
    const overlay = await this.buildTransactionContentOverlay(input.transactionId);
    if (!isEmpty(overlay.diagnostics)) {
      const envelope = diagnosticsEnvelope(overlay.diagnostics);
      throw new ProjectError(
        "INVALID_INPUT",
        `无法 amend 该事务：当前暂存补丁不能干净重放：${envelope.headline}`,
        { transactionId: input.transactionId, ...envelope.details },
      );
    }

    const amendment = await this.prepareTransaction(
      {
        operations: input.operations,
        evidenceId: input.evidenceId,
        metadata: input.metadata,
      },
      {
        contentOverlay: overlay.contentByPath,
        store: false,
      },
    );

    const transactionBeforeAmend = cloneStoredTransaction(tx);
    try {
      preparedTx.patches.push(
        ...amendment.patches.map((patchValue) => ({
          ...patchValue,
          metadata: {
            ...(patchValue.metadata ?? {}),
            amendedFromTransactionId: preparedTx.transactionId,
          },
        })),
      );
      preparedTx.baseSnapshots.push(...amendment.baseSnapshots);
      preparedTx.metadata = {
        ...(preparedTx.metadata ?? {}),
        amendmentMetadata: toOptional(input.metadata),
        amendedAt: Date.now(),
        amendmentCount: Number(preparedTx.metadata?.amendmentCount ?? 0) + 1,
      };
      preparedTx.status = "prepared";
      this.refreshTransactionSummary(preparedTx);
      this.assertScopeWithinPolicy(preparedTx.changedFiles, preparedTx.changedLines);
      this.publishTransactionChange(tx, "amended", input.operations);
    } catch (error) {
      this.transactions.set(input.transactionId, transactionBeforeAmend);
      throw error;
    }
    await this.hooks.emit("AfterPrepareEdit", this, preparedTx);
    this.journal.record({ actor: "system", action: "amend_edit", transactionId: preparedTx.transactionId, outputSummary: `${input.operations.length} amendment operation(s)`, risk: preparedTx.risk });
    return preparedTx;
  }

  /** 在事务暂存内容上运行修复器，并把修复转成事务修订。 */
  public async fixTransaction(input: FixInput): Promise<FixResult> {
    const tx = this.getTransaction(input.transactionId);
    if (!tx) throw new ProjectError("INVALID_INPUT", `未知事务：${input.transactionId}`);
    await this.decide("amend_edit", tx.changedFiles, input, tx.risk);
    const originalOverlay = await this.buildTransactionContentOverlay(input.transactionId);
    if (!isEmpty(originalOverlay.diagnostics)) return {
        ok: false,
        changed: false,
        transactionId: input.transactionId,
        changedFiles: [],
        fixes: [],
        diagnostics: originalOverlay.diagnostics,
      };

    const mutableContent = new Map(originalOverlay.contentByPath);
    // fixer 在事务暂存态上工作，最后只把真实变化转成 amendment。
    const ctx = {
      getTransaction: (idValue: string) => this.getTransaction(idValue),
      root: this.root,
      providers: this.providers,
      readFile: this.createOverlayFileReader(mutableContent),
    };

    const paths = input.paths ?? tx.changedFiles;
    let result: FixResult = {
      ok: true,
      changed: false,
      transactionId: input.transactionId,
      changedFiles: [],
      fixes: [],
      diagnostics: [],
    };

    const maxPasses = Math.max(1, input.maxPasses ?? 1);
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const passResult = await this.fixers.fix({ ...input, paths }, ctx);
      result = {
        ok: result.ok && passResult.ok,
        changed: result.changed || passResult.changed,
        transactionId: input.transactionId,
        changedFiles: [...new Set([...result.changedFiles, ...passResult.changedFiles])],
        fixes: [...result.fixes, ...passResult.fixes],
        diagnostics: [...result.diagnostics, ...passResult.diagnostics],
        toolRequirements: optionalWhen([
          ...(result.toolRequirements ?? []),
          ...(passResult.toolRequirements ?? []),
        ].length, ([...(result.toolRequirements ?? []), ...(passResult.toolRequirements ?? [])])),
      };
      if (!passResult.changed) break;
      for (const fix of passResult.fixes) {
        mutableContent.set(fix.path, fix.content);
      }
    }

    const operations = [...mutableContent.entries()].flatMap(([pathValue, finalContent]) => {
      if (isNull(finalContent)) return [];
      const originalContent = originalOverlay.contentByPath.get(pathValue);
      if (!isString(originalContent) || originalContent === finalContent) return [];
      return [
        {
          operation:
            originalContent.length > 0
              ? {
                  type: "replace_text" as const,
                  path: pathValue,
                  oldText: originalContent,
                  newText: finalContent,
                }
              : {
                  type: "append_text" as const,
                  path: pathValue,
                  text: finalContent,
                },
          reason: "自动修复暂存事务",
        },
      ];
    });

    if (!isEmpty(operations)) {
      await this.amendEdit({
        transactionId: input.transactionId,
        operations,
        metadata: {
          autoFix: true,
          fixerIds: this.fixers.listIds(),
        },
      });
    }

    this.journal.record({ actor: "validator", action: "fix_transaction", transactionId: input.transactionId, outputSummary: `${result.changedFiles.length} 个文件已修复` });
    return result;
  }

  /** 应用已准备好的事务，并记录新旧 revision。 */
  public async applyEdit(input: ApplyEditInput): Promise<ApplyResult> {
    return this.runTransactionCommand(input.transactionId, () => this.applyEditSerialized(input));
  }

  private async applyEditSerialized(input: ApplyEditInput): Promise<ApplyResult> {
    await this.hooks.emit("BeforeApplyEdit", this, input);
    const tx = this.transactions.get(input.transactionId);
    if (!tx) throw new ProjectError("INVALID_INPUT", `未知事务：${input.transactionId}`);
    const isRestoringRolledBackTransaction = tx.status === "rolled_back";
    if (!isRestoringRolledBackTransaction && (tx.appliedAt || tx.status === "applied")) {
      throw new ProjectError("INVALID_INPUT", `事务已经应用：${input.transactionId}`);
    }
    const validation = await this.validate({ transactionId: tx.transactionId });
    if (!validation.ok) throw validationFailed(tx.transactionId, validation);
    const authorizedChangedFiles = await this.authorizePaths(tx.changedFiles, "write", "写入");
    await this.decide("apply_edit", toOptional(authorizedChangedFiles), input, tx.risk);
    const lock = await this.locks.lock(tx.changedFiles, tx.transactionId);
    try {
      const oldRevisions: Record<string, string> = {};
      const newRevisions: Record<string, string> = {};
      const rebasedFiles = new Set<string>();
      const createdFiles: string[] = [];
      const transactionBeforePreflight = cloneStoredTransaction(tx);
      let restoreByPath: Map<string, ApplyRestoreState>;
      let pending: ProjectTransactionPendingOperation | undefined;

      try {
        // 在 durable write-ahead plan 之前完成全部 revision/rebase 判定，保证计划里记录的
        // owned state 就是后面实际可能写入磁盘的内容。只有每个路径的首个补丁对照磁盘；后继补丁
        // 经 `chainPatch` 衔接到前一补丁的产出，首个补丁被 rebase 时随之在 rebase 结果上重新推导。
        const stagedByPath = new Map<string, StagedFileContent>();
        for (let patchIndex = 0; patchIndex < tx.patches.length; patchIndex += 1) {
          let patch = tx.patches[patchIndex];
          const staged = stagedByPath.get(patch.path);
          if (!isUndefined(staged)) {
            const chained = await this.chainPatch(patch, staged);
            if (!chained) {
              throw revisionMismatch(
                `${patch.path} 在准备事务后被修改，本事务对该文件的后续操作无法衔接到 rebase 后的内容`,
                { path: patch.path, actual: oldRevisions[patch.path], patchId: patch.patchId, operation: patch.metadata?.op },
              );
            }
            patch = chained;
          } else if (patch.baseRevision) {
            const current = await this.store.snapshot(patch.path, true, { skipFileFilter: true });
            oldRevisions[patch.path] = current.revision;
            const canReplayRolledBackPatch =
              isRestoringRolledBackTransaction &&
              isString(patch.oldContent) &&
              current.content === patch.oldContent;
            if (current.revision !== patch.baseRevision && !canReplayRolledBackPatch) {
              const rebased = await this.tryRebasePatch(patch, current);
              if (!rebased) {
                throw revisionMismatch(`${patch.path} 的补丁 base revision 已变化`, { expected: patch.baseRevision, actual: current.revision });
              }
              patch = rebased;
            }
          }
          if (patch !== tx.patches[patchIndex]) {
            tx.patches[patchIndex] = patch;
            rebasedFiles.add(patch.path);
          }
          stagedByPath.set(patch.path, this.stagedContentAfter(patch));
        }
        // rebase 改变了将写下的内容：摘要随之刷新，apply 结果与 change feed 描述的就是实际写盘。
        if (rebasedFiles.size > 0) this.refreshTransactionSummary(tx);

        // 写盘前先为每个受影响路径捕获原始状态，供失败回滚使用。
        // 注意：这里只读不写，不改变下面补丁的顺序写入与 rebase 语义。
        restoreByPath = await this.captureApplyRestoreState(tx.changedFiles);
        pending = this.beginDurableOperation(tx, "apply", restoreByPath);
      } catch (error) {
        this.transactions.set(tx.transactionId, transactionBeforePreflight);
        throw error;
      }
      const writtenOrder: string[] = [];

      try {
        for (const patch of tx.patches) {
          const op = patch.metadata?.op;
          if (op === "delete_file" || op === "rename_file_delete") {
            await this.store.remove(patch.path, { skipFileFilter: true });
            newRevisions[patch.path] = "deleted";
          } else {
            if (op === "create_file" || op === "rename_file_create") {
              const beforeWrite = await this.store.snapshot(patch.path, false, {
                skipFileFilter: true,
              });
              if (!beforeWrite.exists) createdFiles.push(patch.path);
            }
            const snap = await this.store.write(patch.path, patch.newContent ?? "", {
              skipFileFilter: true,
            });
            newRevisions[patch.path] = snap.revision;
          }
          if (!writtenOrder.includes(patch.path)) writtenOrder.push(patch.path);
        }
      } catch (writeError) {
        // 多文件写入原子化：任一补丁失败时，按逆序把已写文件还原到本次 apply 前的状态。
        if (pending) await this.restoreDurableOperation(pending);
        else await this.restoreAppliedFiles(writtenOrder, restoreByPath, tx.transactionId);
        throw writeError;
      }
      const previousStatus = pending?.previousStatus ?? tx.status;
      const previousAppliedAt = tx.appliedAt;
      tx.status = "applied";
      tx.appliedAt = Date.now();
      const appliedRevisions = tx.changedFiles.map((pathValue) => ({
        path: pathValue,
        before: oldRevisions[pathValue],
        after: newRevisions[pathValue],
      }));
      try {
        this.publishTransactionChange(tx, "applied", [], appliedRevisions);
      } catch (stateError) {
        tx.status = previousStatus;
        tx.appliedAt = previousAppliedAt;
        if (pending) await this.restoreDurableOperation(pending);
        else await this.restoreAppliedFiles(writtenOrder, restoreByPath, tx.transactionId);
        throw stateError;
      }

      // Git intent-to-add 是已提交文件事务的附带可见性，不进入崩溃恢复提交点。
      const gitTrackedFiles = await this.trackCreatedFilesInGit(createdFiles);
      if (gitTrackedFiles.length > 0) {
        tx.metadata = {
          ...(tx.metadata ?? {}),
          gitTrackedFiles,
        };
      }
      this.retainTerminalTransaction(tx.transactionId);
      this.persistCommittedTransactionState(tx.transactionId, "git metadata or terminal retention");
      const result: ApplyResult = {
        status: "applied",
        transactionId: tx.transactionId,
        changedFiles: tx.changedFiles,
        oldRevisions,
        newRevisions,
        rebasedFiles: optionalWhen(rebasedFiles.size, ([...rebasedFiles])),
        gitTrackedFiles: optionalWhen((gitTrackedFiles.length > 0), gitTrackedFiles),
      };
      await this.hooks.emit("AfterApplyEdit", this, result);
      this.journal.record({ actor: "system", action: "apply_edit", transactionId: tx.transactionId, outputSummary: tx.changedFiles.join(","), risk: tx.risk });
      return result;
    } finally {
      await this.locks.unlock(lock.lockId);
    }
  }

  /** 校验当前文件或事务暂存内容，并合并适配器诊断。 */
  public async validate(input: ValidateInput): Promise<ValidationResult> {
    await this.hooks.emit("BeforeValidate", this, input);
    if (input.transactionId && !this.transactions.has(input.transactionId)) {
      throw new ProjectError("INVALID_INPUT", `未知事务：${input.transactionId}`);
    }
    await this.decide("validate", input.paths, input);
    const overlay = await this.buildTransactionContentOverlay(input.transactionId);
    // validator 优先读取事务暂存内容，再回退到当前工作区文件。
    const ctx = {
      getTransaction: (idValue: string) => this.getTransaction(idValue),
      root: this.root,
      policy: this.policy,
      providers: this.providers,
      readFile: this.createOverlayFileReader(overlay.contentByPath),
    };
    let result = await this.validators.validate(input, ctx);
    if (!isEmpty(overlay.diagnostics)) {
      result.diagnostics.push(...overlay.diagnostics);
      result.checks.push({
        id: "core.transaction-replay",
        ok: false,
        diagnostics: overlay.diagnostics,
      });
    }
    const paths = input.paths ?? (input.transactionId ? this.transactions.get(input.transactionId)?.changedFiles ?? [] : []);
    for (const pathValue of paths) {
      const hasStagedContent = overlay.contentByPath.has(pathValue);
      const stagedContent = optionalWhen(hasStagedContent, (overlay.contentByPath.get(pathValue)));
      if (isNull(stagedContent)) continue;
      const snap =
        isString(stagedContent)
          ? await this.snapshotWithContent(pathValue, stagedContent)
          : await this.enrichSnapshot(await this.store.snapshot(pathValue, true));
      for (const adapter of await this.adapters.createAdapters(snap, this)) {
        if (adapter.validate) {
          const adapterResult = await adapter.validate({ snapshot: snap, transactionId: input.transactionId, changedContent: stagedContent });
          result.diagnostics.push(...adapterResult.diagnostics);
          result.checks.push(...adapterResult.checks);
        }
      }
    }
    result = { ...result, ok: result.diagnostics.every((d) => d.severity !== "error") };
    const transaction = input.transactionId
      ? this.transactions.get(input.transactionId)
      : undefined;
    const previousStatus = transaction?.status;
    const preservesTerminalStatus = previousStatus === "applied" || previousStatus === "rolled_back";
    if (transaction && result.ok && !preservesTerminalStatus) transaction.status = "validated";
    if (transaction) {
      try {
        const lifecycle = result.ok
          ? previousStatus === "applied"
            ? "applied"
            : previousStatus === "rolled_back"
              ? "rolled_back"
              : "validated"
          : "validation_failed";
        this.publishTransactionChange(transaction, lifecycle);
      } catch (error) {
        if (previousStatus) transaction.status = previousStatus;
        throw error;
      }
    }
    await this.hooks.emit("AfterValidate", this, result);
    this.journal.record({ actor: "validator", action: "validate", transactionId: input.transactionId, outputSummary: result.ok ? "ok" : `${result.diagnostics.length} diagnostic(s)` });
    return result;
  }

  /** 回滚已应用事务，并撤销为新建文件设置的 git 跟踪标记。 */
  public async rollback(input: RollbackInput): Promise<RollbackResult> {
    return this.runTransactionCommand(input.transactionId, () => this.rollbackSerialized(input));
  }

  private async rollbackSerialized(input: RollbackInput): Promise<RollbackResult> {
    await this.hooks.emit("BeforeRollback", this, input);
    const tx = this.transactions.get(input.transactionId);
    if (!tx) throw new ProjectError("INVALID_INPUT", `未知事务：${input.transactionId}`);
    if (!tx.appliedAt || tx.status !== "applied") {
      throw new ProjectError("INVALID_INPUT", `只能回滚已应用的事务：${input.transactionId}`);
    }
    const lock = await this.locks.lock(tx.changedFiles, `rollback:${tx.transactionId}`);
    try {
      const reversed = [...tx.patches].reverse();
      const appliedRevisions = this.transactionProjections.get(tx.transactionId)?.revisions
        ?? this.changeFeed.get(tx.transactionId)?.revisions
        ?? [];
      for (const pathValue of tx.changedFiles) {
        const expectedRevision = appliedRevisions.find((revision) => revision.path === pathValue)?.after;
        if (!expectedRevision) {
          throw new ProjectError(
            "CONFLICT_WITH_EXTERNAL_EDIT",
            `无法安全回滚事务 ${tx.transactionId}：缺少 apply 后 revision（${pathValue}）`,
            { transactionId: tx.transactionId, path: pathValue },
            "请重新读取冲突文件并人工确认恢复内容；不要强制覆盖当前工作区。",
          );
        }
        const current = await this.store.snapshot(pathValue, true, { skipFileFilter: true });
        const finalPatch = [...tx.patches].reverse().find((patchValue) => patchValue.path === pathValue);
        const expectedContent = finalPatch && !this.isDeletePatch(finalPatch)
          ? finalPatch.newContent
          : undefined;
        const matchesAppliedState = expectedRevision === "deleted"
          ? !current.exists
          : current.exists
            && (current.revision === expectedRevision
              || (isString(expectedContent) && current.content === expectedContent));
        if (!matchesAppliedState) {
          throw new ProjectError(
            "CONFLICT_WITH_EXTERNAL_EDIT",
            `事务应用后文件已被外部修改，拒绝回滚：${pathValue}`,
            {
              transactionId: tx.transactionId,
              path: pathValue,
              expectedRevision,
              actualRevision: current.exists ? current.revision : "deleted",
            },
            "请重新读取冲突文件并人工合并；不要重试会覆盖当前内容的回滚。",
          );
        }
      }
      // 预检：非新建补丁必须带可还原的旧正文。否则用 "" 写盘会把文件截断为空（静默丢数据），
      // 宁可整体失败也不半改。
      for (const patch of reversed) {
        const op = patch.metadata?.op;
        const isCreate = op === "create_file" || op === "rename_file_create";
        if (!isCreate && !isString(patch.oldContent)) {
          throw new ProjectError(
            "PATCH_APPLY_ERROR",
            `无法回滚事务 ${tx.transactionId}：补丁缺少可还原的旧正文（${patch.path}）`,
            { path: patch.path, op },
          );
        }
      }
      // 捕获回滚前状态；任一步写盘失败时按逆序还原，保持 rollback 自身的原子性
      //（与 applyEdit 一致，并用 skipFileFilter 还原 apply 时绕过 fileFilter 的文件）。
      const restoreByPath = await this.captureApplyRestoreState(tx.changedFiles);
      const pending = this.beginDurableOperation(tx, "rollback", restoreByPath);
      const writtenOrder: string[] = [];
      const rolledBackRevisions: Record<string, string> = {};
      try {
        for (const patch of reversed) {
          const op = patch.metadata?.op;
          if (op === "create_file" || op === "rename_file_create") {
            await this.store.remove(patch.path, { skipFileFilter: true });
            rolledBackRevisions[patch.path] = "deleted";
          } else {
            const snapshot = await this.store.write(patch.path, patch.oldContent ?? "", { skipFileFilter: true });
            rolledBackRevisions[patch.path] = snapshot.revision;
          }
          writtenOrder.push(patch.path);
        }
      } catch (rollbackError) {
        if (pending) await this.restoreDurableOperation(pending);
        else await this.restoreAppliedFiles(writtenOrder, restoreByPath, tx.transactionId);
        throw rollbackError;
      }
      const beforeRollback = this.transactionProjections.get(tx.transactionId)?.revisions
        ?? this.changeFeed.get(tx.transactionId)?.revisions
        ?? [];
      const previousStatus = pending?.previousStatus ?? tx.status;
      tx.status = "rolled_back";
      const rollbackRevisions = tx.changedFiles.map((pathValue) => ({
        path: pathValue,
        before: beforeRollback.find((revision) => revision.path === pathValue)?.after,
        after: rolledBackRevisions[pathValue],
      }));
      try {
        this.publishTransactionChange(tx, "rolled_back", [], rollbackRevisions);
      } catch (stateError) {
        tx.status = previousStatus;
        if (pending) await this.restoreDurableOperation(pending);
        else await this.restoreAppliedFiles(writtenOrder, restoreByPath, tx.transactionId);
        throw stateError;
      }

      const gitTrackedFiles = isArray(tx.metadata?.gitTrackedFiles)
        ? tx.metadata.gitTrackedFiles.filter(isString)
        : [];
      const gitUntrackedFiles = await this.untrackCreatedFilesFromGit(gitTrackedFiles);
      this.retainTerminalTransaction(tx.transactionId);
      this.persistCommittedTransactionState(tx.transactionId, "git metadata or terminal retention");
      const result: RollbackResult = {
        status: "rolled_back",
        transactionId: tx.transactionId,
        changedFiles: tx.changedFiles,
        gitUntrackedFiles: optionalWhen((gitUntrackedFiles.length > 0), gitUntrackedFiles),
      };
      await this.hooks.emit("AfterRollback", this, result);
      this.journal.record({ actor: "system", action: "rollback", transactionId: tx.transactionId, outputSummary: tx.changedFiles.join(",") });
      return result;
    } finally {
      await this.locks.unlock(lock.lockId);
    }
  }

  /** 返回单个事务或全部事务的合并 diff 摘要。 */
  public async diff(input: { transactionId?: string } = {}): Promise<DiffResult> {
    if (input.transactionId && !this.transactions.has(input.transactionId)) {
      throw new ProjectError("INVALID_INPUT", `未知事务：${input.transactionId}`);
    }
    const txs = input.transactionId
      ? [this.transactions.get(input.transactionId)!]
      : [...this.transactions.values()];
    const diff = combineDiffs(txs.map((tx) => tx.diff));
    const changedFiles = [...new Set(txs.flatMap((tx) => tx.changedFiles))];
    const changedLines = txs.reduce((sum, tx) => sum + tx.changedLines, 0);
    return { diff, changedFiles, changedLines };
  }

  /** 返回当前 project 内核状态快照。 */
  public async status(): Promise<ProjectStatus> {
    return {
      root: this.root,
      transactions: this.transactions.size,
      targets: this.targets.size,
      journalEvents: this.journal.list().length,
      locks: this.locks.list(),
      plugins: this.plugins.list().map((p) => p.name),
      adapters: this.adapters.listFactoryIds(),
      validators: this.validators.listIds(),
      runningBatches: this.runningBatches,
      lastBatch: this.lastBatchMetrics,
    };
  }

  /** 返回当前 journal 事件列表。 */
  public getJournal(): AuditEvent[] {
    return this.journal.list();
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
    return this.transactions.get(idValue) as PreparedTransaction | undefined;
  }

  /** 执行批处理任务，并复用同一个 project 实例；记录工作池指标供 status/telemetry 观测。 */
  public async runBatch(input: BatchInput): Promise<BatchResult> {
    this.runningBatches += 1;
    try {
      const result = await runBatch(this, input);
      if (isPresent(result.metrics)) {
        this.lastBatchMetrics = result.metrics;
        void this.providers.telemetry?.emit?.({
          name: "project.batch",
          properties: { ok: result.ok, ...result.metrics },
        });
        this.journal.record({
          actor: "system",
          action: "batch",
          outputSummary: `${result.metrics.totalTasks} tasks, peak ${result.metrics.peakActive}/${result.metrics.concurrencyLimit}, ${result.metrics.durationMs}ms`,
        });
      }
      return result;
    } finally {
      this.runningBatches -= 1;
    }
  }

  private withIntentMetadata(patches: PreparedPatch[], intent: EditIntent): PreparedPatch[] {
    return patches.map((patchValue) => ({
      ...patchValue,
      metadata: {
        ...(patchValue.metadata ?? {}),
        intentOperation: intent.operation,
        intentConstraints: intent.constraints,
        intentReason: intent.reason,
        intentTargetId: intent.targetId,
      },
    }));
  }

  private async tryRebasePatch(
    patchValue: PreparedPatch,
    currentSnapshot: FileSnapshot,
  ): Promise<Nullable<PreparedPatch>> {
    // rebase 会用最新快照重新执行原始 intent，同时保留补丁 id。
    const metadata = patchValue.metadata as {
      intentOperation?: EditIntent["operation"];
      intentConstraints?: EditIntent["constraints"];
      intentReason?: EditIntent["reason"];
    } | undefined;
    const operation = metadata?.intentOperation;
    if (!operation || !QueueRebaseFriendlyOperations.has(operation.type)) return null;
    if (!currentSnapshot.exists || currentSnapshot.isDirectory || currentSnapshot.isBinary) return null;

    const intent: EditIntent = {
      operation,
      constraints: metadata?.intentConstraints,
      reason: metadata?.intentReason,
      targetId: undefined,
    };

    try {
      const strategy = this.patchStrategies.select({
        intent,
        snapshot: currentSnapshot,
        policy: this.policy,
      });
      const prepared = await strategy.prepare({
        intent,
        snapshot: currentSnapshot,
        policy: this.policy,
      });
      if (prepared.length !== 1 || prepared[0].path !== patchValue.path) return null;
      return {
        ...prepared[0],
        patchId: patchValue.patchId,
        metadata: {
          ...(patchValue.metadata ?? {}),
          ...(prepared[0].metadata ?? {}),
          rebasedFromRevision: patchValue.baseRevision,
          rebasedAt: Date.now(),
        },
      };
    } catch {
      // arch-guard:silent-catch-ok rebase 失败表示该 patch 不可安全重放，调用方会按 null 处理。
      return null;
    }
  }
}

/** 创建项目内核，并安装 core plugin 与调用方传入的插件。 */
export async function createProjectKernel(options: CreateProjectKernelOptions): Promise<ProjectKernel> {
  const project = new ProjectKernelImpl(options);
  await project.initializeTransactionState();
  if (options.includeBuiltinPlugins ?? true) await project.install(corePlugin());
  for (const plugin of options.plugins ?? []) await project.install(plugin);
  return project;
}
