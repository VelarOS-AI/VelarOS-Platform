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
import type { StoredTransaction } from "../types/transaction.js";
import type { ProjectValidator,ValidateInput, ValidationResult } from "../types/validation.js";
import { combineDiffs, unifiedDiff } from "../utils/diff.js";
import { matchesAny } from "../utils/glob.js";
import { id } from "../utils/id.js";
import { toAbs, toRel } from "../utils/path.js";
import { countChangedLines, isProjectTextEncoding, type ProjectTextEncoding } from "../utils/text.js";

export type { StoredTransaction } from "../types/transaction.js";

import { DEFAULT_CORE_POLICY } from "./defaults.js";
import { FileStore } from "./file-store.js";
import { LockManager } from "./lock-manager.js";
import { TransactionCoordinator } from "./transaction-coordinator.js";
import { TransactionStateMachine } from "./transaction-state-machine.js";

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

/**
 * 同一路径上的后继补丁以前一补丁的产出为 `oldContent`，策略写进 metadata 的
 * `startOffset`/`endOffset` 因而是中间态坐标，与事务前原文对不上。跨事务的区间冲突检测
 * （batch）按原文坐标比较，留着它们会把真实重叠判成不相交；去掉后该补丁退回「同文件即冲突」
 * 的保守判定。
 */
function withoutStagedOffsets(patchValue: PreparedPatch): PreparedPatch {
  if (!isPresent(patchValue.metadata)) return patchValue;
  const { startOffset: _startOffset, endOffset: _endOffset, ...metadata } = patchValue.metadata;
  return { ...patchValue, metadata };
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
  // 同一语法错误会被核心 adapter、TS 插件 adapter 与 validator 各报一次（只有 source 不同），
  // 按位置与消息去重后再计数，免得一个错误报成「共 3 条」并挤占前 N 条名额。
  const unique = [
    ...new Map(
      diagnostics.map((diagnostic) => [
        JSON.stringify([diagnostic.severity, diagnostic.path, diagnostic.line, diagnostic.column, diagnostic.message]),
        diagnostic,
      ]),
    ).values(),
  ];
  // Array.prototype.sort 稳定：同档诊断保持 validator 产出顺序。
  const ordered = unique.sort((left, right) => rank(left) - rank(right));
  const [first] = ordered;
  const location = [first.path, first.line, optionalWhen(isPresent(first.line), first.column)]
    .filter(isPresent)
    .join(":");
  const firstLine = truncateText(first.message.split("\n")[0].trim(), MaxHeadlineChars);
  return {
    headline: `${isEmpty(location) ? "" : `${location} `}${firstLine}（共 ${ordered.length} 条）`,
    details: {
      diagnostics: ordered.slice(0, MaxReportedDiagnostics).map((diagnostic) => ({
        ...diagnostic,
        message: truncateText(diagnostic.message, MaxDiagnosticMessageChars),
      })),
      diagnosticCount: ordered.length,
    },
  };
}

/**
 * `rebasedFiles` 出现表示失败发生在 apply 锁内的复核：准备事务后这些文件被外部修改，rebase 后
 * 的内容没通过校验。此时要改的不是编辑操作本身，而是先读最新内容。
 */
function validationFailed(
  transactionId: string,
  validation: ValidationResult,
  context: { rebasedFiles?: string[] } = {},
): ProjectError {
  const envelope = diagnosticsEnvelope(validation.diagnostics);
  return new ProjectError(
    "VALIDATION_FAILED",
    `事务校验失败，未写入磁盘：${envelope.headline}`,
    {
      transactionId,
      ...context,
      ...envelope.details,
      failedChecks: [...new Set(validation.checks.filter((check) => !check.ok).map((check) => check.id))],
    },
    isPresent(context.rebasedFiles)
      ? "准备事务后 rebasedFiles 被外部修改，rebase 后的内容未通过校验；请重新读取这些文件，基于最新内容重新准备事务。"
      : "请根据 diagnostics 修正编辑操作，然后重新准备事务。",
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


// 内存治理上限：长会话内核常驻时，避免 target/evidence/已结束事务无界增长。
const MaxRetainedTargets = 500;
const MaxRetainedEvidence = 500;
const MaxRetainedTerminalTransactions = 200;
const DefaultImplicitSearchExcludeGlobs = ["node_modules/**", ".git/**", "dist/**", "coverage/**"] as const;
// 全部事务（含已准备未应用的）总量兜底；正常 prepare→apply 不受影响。
const MaxRetainedTransactions = 1000;

/**
 * 判定 intent-to-add 的 `git diff --cached` 探针：只列路径、按 NUL 分隔（路径原样输出，不受
 * core.quotePath 转义）；`--relative` 让输出与 pathspec 一样相对 cwd——内核根可能是仓库子目录；
 * `--no-renames` 防止改名配对只打印新路径、把旧路径藏掉。
 */
const IntentToAddProbeArgs = ["diff", "--cached", "--name-only", "-z", "--relative", "--no-renames"] as const;

/** `git … -z` 的路径输出：每条以 NUL 结尾，切开后去掉末尾空段。 */
function splitNulTerminatedPaths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

/** 事务 metadata 里记下的 git 索引路径清单；它随事务状态持久化，读回时只认字符串项。 */
function metadataPaths(value: unknown): string[] {
  return isArray(value) ? value.filter(isString) : [];
}

/** applyEdit 失败回滚所需的单个路径原始状态。 */
interface ApplyRestoreState {
  existedBefore: boolean;
  oldContent?: string;
  /** 原文件的文本编码；还原时文件若已被删掉，按它重建而不是写成 UTF-8。 */
  encoding?: ProjectTextEncoding;
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
  readonly transactionStateMachine = new TransactionStateMachine();
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
        if (this.transactionStateMachine.isTerminal(transaction.status)) {
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

  /**
   * 对内核给出的具体文件路径跑 git 子命令。`--literal-pathspecs` 让路径只按字面匹配：否则名为
   * `[s]taged.txt` 的文件会被当成 glob，连带命中用户真实暂存的 `staged.txt`，`git rm --cached`
   * 就把它一起移出索引。
   */
  private async runGitOnPaths(args: readonly string[], paths: readonly string[]) {
    return this.runGit(["--literal-pathspecs", ...args, "--", ...paths]);
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
    const result = await this.runGitOnPaths(["add", "--intent-to-add"], files);
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
    const result = await this.runGitOnPaths(["rm", "--cached", "--ignore-unmatch"], files);
    if (result.exitCode === 0) return files;
    this.providers.logger?.warn?.("project.git.untrackCreatedFiles.failed", {
      files,
      stderr: result.stderr,
    });
    return [];
  }

  /**
   * 被删路径在索引里若只剩 intent-to-add 条目，就把条目撤掉，否则 `git status` 会留下一条删除残留。
   * 带真实内容的索引项（用户 `git add` 过的、已提交的）一律不动：索引照旧，删除留在工作区等用户处理。
   */
  private async untrackDeletedIntentToAddFromGit(paths: string[]): Promise<string[]> {
    const files = [...new Set(paths)].filter(Boolean);
    if (isEmpty(files) || !(await this.isInsideGitWorkTree())) return [];
    const intentToAddFiles = await this.listIntentToAddFiles(files);
    if (isEmpty(intentToAddFiles)) return [];
    const result = await this.runGitOnPaths(["rm", "--cached", "--ignore-unmatch"], intentToAddFiles);
    if (result.exitCode === 0) return intentToAddFiles;
    this.providers.logger?.warn?.("project.git.untrackDeletedIntentToAdd.failed", {
      files: intentToAddFiles,
      stderr: result.stderr,
    });
    return [];
  }

  /**
   * 从 files 里挑出索引中是 intent-to-add（`git add -N`）的条目。
   *
   * 判据：diff-options 文档规定 `--ita-invisible-in-index` 把 intent-to-add 条目当作索引里不存在，
   * `--ita-visible-in-index` 把它当作空文件；两个开关只改变这一类条目的呈现，所以同一组路径在两种
   * 视图下 `diff --cached` 结果的差集恰好是 intent-to-add 条目。真实暂存的新文件（含空文件）两种
   * 视图都显示为新增；已提交且未改动的文件两种视图都不显示——只看「在索引里、但 `diff --cached` 不
   * 显示」会把后者误判成 intent-to-add，撤掉它等于替用户暂存了一次删除。
   *
   * 两个开关都显式给出、不赌默认值：文档写默认可见，porcelain `git diff` 实测默认不可见（git 2.54）。
   * 开关被文档标注为实验性；将来若被移除，git 以未知参数失败，这里只记告警、返回空——失败方向永远
   * 是留下残留，而不是误动真实暂存。
   */
  private async listIntentToAddFiles(files: readonly string[]): Promise<string[]> {
    const [visible, invisible] = await Promise.all([
      this.runGitOnPaths([...IntentToAddProbeArgs, "--ita-visible-in-index"], files),
      this.runGitOnPaths([...IntentToAddProbeArgs, "--ita-invisible-in-index"], files),
    ]);
    if (visible.exitCode !== 0 || invisible.exitCode !== 0) {
      this.providers.logger?.warn?.("project.git.listIntentToAdd.failed", {
        files,
        stderr: [visible.stderr, invisible.stderr].filter(Boolean).join("\n"),
      });
      return [];
    }
    const shownWhenVisible = new Set(splitNulTerminatedPaths(visible.stdout));
    const shownWhenInvisible = new Set(splitNulTerminatedPaths(invisible.stdout));
    return files.filter((file) => shownWhenVisible.has(file) && !shownWhenInvisible.has(file));
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
        encoding: before.textEncoding,
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
      const deletes = kind === "apply" ? this.isDeletePatch(patchValue) : this.createsMissingFile(patchValue);
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
        ...(restore.existedBefore ? { content: restore.oldContent!, encoding: restore.encoding } : {}),
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
        await this.store.write(restore.path, restore.content!, { skipFileFilter: true, encoding: restore.encoding });
      } else {
        await this.store.remove(restore.path, { skipFileFilter: true });
      }
    }
    tx.status = this.transactionStateMachine.restore(pending.previousStatus);
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
            await this.store.write(file, restore.oldContent, { skipFileFilter: true, encoding: restore.encoding });
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

  /** 新建类补丁整文件写入，不依赖该路径此前的内容。 */
  private isCreatePatch(patchValue: PreparedPatch): boolean {
    const op = patchValue.metadata?.op;
    return op === "create_file" || op === "rename_file_create";
  }

  /**
   * 补丁写入前该路径不存在，撤销它就是删除文件。覆盖既有文件的 `create_file` 同样整文件写入，
   * 但它的 `oldContent` 是原文——回滚写回原文；把它当新建处理会删掉原文件，永久丢失原文。
   */
  private createsMissingFile(patchValue: PreparedPatch): boolean {
    return this.isCreatePatch(patchValue) && !isTrue(patchValue.metadata?.replacesExisting);
  }

  /**
   * 补丁写下后能否被 rollback 完整撤销：写入前不存在的新建补丁撤销即删除，永远可恢复；其余补丁
   * （编辑、覆盖、删除、重命名的删除侧）撤销要写回 `oldContent`，只有补丁捕获到原文才可恢复。
   * 取不到原文的是二进制、超出读取上限的文件与符号链接本身：整文件覆盖和删除这类文件时策略把
   * `oldContent` 留空；在它们上面做局部编辑则在 prepare 就被拒绝（`assertEditsReadOriginal`），
   * 所以字符串 `oldContent` 一定是真原文。
   *
   * 回滚前置预检、`resolveTransactionRisk` 与 Desktop PreviewCache 的 `canRevertToOriginal`
   * 是同一条判据：预检据此拒绝会把文件截空的回滚，风险分级据此只把恢复不了的写入交给人审。
   */
  private canRevertToOriginal(patchValue: PreparedPatch): boolean {
    return this.createsMissingFile(patchValue) || isString(patchValue.oldContent);
  }

  /**
   * `canRevertToOriginal` 把「补丁带着字符串 `oldContent`」当作「捕获到了真原文」，这条前提在内核边界
   * 统一兜住，不指望每个策略、adapter、插件都自觉：快照里没有正文（二进制或超出读取上限）的既有文件，
   * 编辑补丁（非新建、非删除）只能凭空假设原文，apply 会把文件截成只剩新文本，`oldContent: ""` 又让
   * 回滚判为可恢复、写出空文件。整文件覆盖与删除不依赖原文，照常放行，由风险分级按不可恢复处理。
   */
  private assertEditsReadOriginal(patches: readonly PreparedPatch[], snapshot: FileSnapshot): void {
    if (!snapshot.exists || snapshot.isDirectory || isString(snapshot.content)) return;
    const blind = patches.find((patchValue) =>
      patchValue.path === snapshot.path && !this.isCreatePatch(patchValue) && !this.isDeletePatch(patchValue));
    if (!blind) return;
    throw new ProjectError(
      "NOT_SUPPORTED",
      `无法读取 ${snapshot.path} 的完整正文（二进制或超出读取上限），不能在它上面做局部编辑。`,
      { path: snapshot.path, op: blind.metadata?.op, strategyId: blind.strategyId },
      "整文件替换请用 overwrite；其余修改请用项目命令处理该文件。",
    );
  }

  /**
   * 补丁在空路径上重建文件时沿用的原编码（删除/重命名补丁从原文件快照记下）；缺席按 UTF-8。
   * 路径上已有文本文件时写入始终沿用该文件自己的编码，这个值不起作用。
   */
  private patchTextEncoding(patchValue: PreparedPatch): Optional<ProjectTextEncoding> {
    const encoding = patchValue.metadata?.textEncoding;
    return isProjectTextEncoding(encoding) ? encoding : undefined;
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
    const rebased = await this.tryRebasePatch(patchValue, await this.snapshotWithContent(patchValue.path, staged));
    return isNull(rebased) ? null : withoutStagedOffsets(rebased);
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

  /**
   * 事务内衔接补丁、按路径分组预检、加锁都以路径字符串为 key，所以路径进事务前统一规范成
   * FileStore 快照用的根相对形式：`./x`、绝对路径与 `x` 若各成一组，同一文件的补丁不衔接，
   * 顺序整文件写入会让后写覆盖先写。越出根目录的路径在这里按原拼写显式拒绝。
   */
  private canonicalPath(pathValue: string): string {
    return toRel(this.root, toAbs(this.root, pathValue));
  }

  /** 编辑原语里的文件路径（`path` / `from` / `to`）换成规范形式；`json_patch` 内层的 JSON Pointer 不是文件路径。 */
  private withCanonicalPaths(intent: EditIntent): EditIntent {
    const { operation } = intent;
    if (operation.type === "rename_file") return {
      ...intent,
      operation: { ...operation, from: this.canonicalPath(operation.from), to: this.canonicalPath(operation.to) },
    };
    if (!("path" in operation) || !isString(operation.path)) return intent;
    return { ...intent, operation: { ...operation, path: this.canonicalPath(operation.path) } };
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
    const baseRevisions = new Map(
      Object.entries(processed.baseRevisions ?? {}).map(([pathValue, revision]) => [this.canonicalPath(pathValue), revision]),
    );

    for (const intent of processed.operations.map((operationIntent) => this.withCanonicalPaths(operationIntent))) {
      const target = this.getTarget(intent.targetId);
      let snapshot: FileSnapshot | undefined;
      const pathForOp = isPresent(target) ? this.canonicalPath(target.path) : operationPath(intent.operation);
      let renameTargetSnapshot: FileSnapshot | undefined;
      if (pathForOp) {
        // revision 前置校验只在首次触碰时做：暂存内容是本事务自己的产物，不对应任何磁盘 revision。
        const isStaged = stagedByPath.has(pathForOp);
        // 本事务已删掉的文件只能重新 create_file；其它操作放行的话，prepare 给出的 diff 会描述一份
        // 衔接规则永远写不下去的内容，直到 apply 才以校验失败收场。
        if (isNull(stagedByPath.get(pathForOp)) && intent.operation.type !== "create_file") {
          throw new ProjectError(
            "TARGET_NOT_FOUND",
            `${pathForOp} 已被本事务前面的操作删除，不能再执行 ${intent.operation.type}`,
            { path: pathForOp, operation: intent.operation.type },
            "如需重建该文件请用 create_file；否则去掉这条操作，或拆成单独事务。",
          );
        }
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
        const requestedBaseRevision = baseRevisions.get(pathForOp) ?? processed.baseRevision;
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
          const requestedTargetRevision = baseRevisions.get(intent.operation.to);
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
      if (snapshot) this.assertEditsReadOriginal(intentPatches, snapshot);
      if (renameTargetSnapshot) {
        intentPatches = intentPatches.map((patchValue) =>
          patchValue.metadata?.op === "rename_file_create"
            ? { ...patchValue, baseRevision: renameTargetSnapshot.revision }
            : patchValue
        );
      }
      const chainedPatches: PreparedPatch[] = [];
      for (const patchValue of intentPatches) {
        chainedPatches.push(stagedByPath.has(patchValue.path) ? withoutStagedOffsets(patchValue) : patchValue);
        stagedByPath.set(patchValue.path, this.stagedContentAfter(patchValue));
      }
      patches.push(...this.withIntentMetadata(chainedPatches, intent));
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

  /**
   * 事务风险按「能否恢复」划线：只要有一个补丁回滚后恢复不了原文（`canRevertToOriginal` 为假）
   * 就是 high，交给 `decide` 请人审。能完整回滚的覆盖、删除、重命名是日常写入，与普通编辑一样只按
   * 新建与规模分 medium/low——宿主按路径记忆审批，把它们划成 high 会让每个不同文件都打断一次用户。
   */
  private resolveTransactionRisk(
    patches: readonly PreparedPatch[],
    changedFiles: readonly string[],
    changedLines: number,
  ): RiskLevel {
    if (patches.some((patchValue) => !this.canRevertToOriginal(patchValue))) return "high";

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
    this.transactionStateMachine.assertDiscardable(tx);
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
    const amendedStatus = this.transactionStateMachine.amend(tx);
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
      preparedTx.status = amendedStatus;
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
    return this.runTransactionCommand(input.transactionId, () => this.fixTransactionSerialized(input));
  }

  /** 已位于 transactionId 队列内的修复实现；最终 amendment 复用私有串行入口。 */
  private async fixTransactionSerialized(input: FixInput): Promise<FixResult> {
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
      await this.amendEditSerialized({
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
    this.transactionStateMachine.assertApplicable(tx);
    const validation = await this.validateSerialized({ transactionId: tx.transactionId });
    if (!validation.ok) throw validationFailed(tx.transactionId, validation);
    // validate 会把可变事务推进到 validated；execution token 必须从校验后的稳定状态开始，
    // 这样 apply 后续失败时仍恢复到现有语义下的 validated，而不是调用前的 prepared。
    const execution = this.transactionStateMachine.beginApply(tx);
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
        // rebase 改变了将写下的内容：摘要随之刷新，apply 结果与 change feed 描述的就是实际写盘；
        // 前面的校验看的是 rebase 前的内容，所以锁内对 rebase 后的补丁链再校验一次，不通过就不写盘。
        if (rebasedFiles.size > 0) {
          this.refreshTransactionSummary(tx);
          const revalidation = await this.runValidators({ transactionId: tx.transactionId });
          if (!revalidation.ok) {
            throw validationFailed(tx.transactionId, revalidation, { rebasedFiles: [...rebasedFiles] });
          }
        }

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
          if (this.isDeletePatch(patch)) {
            await this.store.remove(patch.path, { skipFileFilter: true });
            newRevisions[patch.path] = "deleted";
          } else {
            if (this.isCreatePatch(patch)) {
              const beforeWrite = await this.store.snapshot(patch.path, false, {
                skipFileFilter: true,
              });
              if (!beforeWrite.exists) createdFiles.push(patch.path);
            }
            const snap = await this.store.write(patch.path, patch.newContent ?? "", {
              skipFileFilter: true,
              encoding: this.patchTextEncoding(patch),
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
      const previousAppliedAt = tx.appliedAt;
      tx.status = this.transactionStateMachine.commit(execution);
      tx.appliedAt = Date.now();
      const appliedRevisions = tx.changedFiles.map((pathValue) => ({
        path: pathValue,
        before: oldRevisions[pathValue],
        after: newRevisions[pathValue],
      }));
      try {
        this.publishTransactionChange(tx, "applied", [], appliedRevisions);
      } catch (stateError) {
        tx.status = this.transactionStateMachine.abort(execution);
        tx.appliedAt = previousAppliedAt;
        if (pending) await this.restoreDurableOperation(pending);
        else await this.restoreAppliedFiles(writtenOrder, restoreByPath, tx.transactionId);
        throw stateError;
      }

      // Git intent-to-add 是已提交文件事务的附带可见性，不进入崩溃恢复提交点。按路径的最终状态处理：
      // 仍在的新建文件挂上 intent-to-add（同一事务里建了又删的不挂——git add 遇到不存在的路径会整批
      // 失败）；最终被删的路径撤掉残留的 intent-to-add 条目（rename_file 的旧路径同样走这里）。
      const gitTrackedFiles = await this.trackCreatedFilesInGit(
        createdFiles.filter((pathValue) => newRevisions[pathValue] !== "deleted"),
      );
      const gitUntrackedFiles = await this.untrackDeletedIntentToAddFromGit(
        tx.changedFiles.filter((pathValue) => newRevisions[pathValue] === "deleted"),
      );
      if (gitTrackedFiles.length > 0) tx.metadata = { ...(tx.metadata ?? {}), gitTrackedFiles };
      // rollback 恢复这些文件时据此把 intent-to-add 挂回去。
      if (gitUntrackedFiles.length > 0) tx.metadata = { ...(tx.metadata ?? {}), gitUntrackedFiles };
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
        gitUntrackedFiles: optionalWhen((gitUntrackedFiles.length > 0), gitUntrackedFiles),
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
    return input.transactionId
      ? this.runTransactionCommand(input.transactionId, () => this.validateSerialized(input))
      : this.validateSerialized(input);
  }

  /** 已位于 transactionId 队列内的校验实现；apply 复用此入口，避免嵌套排队。 */
  private async validateSerialized(input: ValidateInput): Promise<ValidationResult> {
    await this.hooks.emit("BeforeValidate", this, input);
    if (input.transactionId && !this.transactions.has(input.transactionId)) {
      throw new ProjectError("INVALID_INPUT", `未知事务：${input.transactionId}`);
    }
    await this.decide("validate", input.paths, input);
    const result = await this.runValidators(input);
    const transaction = input.transactionId
      ? this.transactions.get(input.transactionId)
      : undefined;
    const previousStatus = transaction?.status;
    if (transaction && result.ok) {
      transaction.status = this.transactionStateMachine.validationSucceeded(transaction);
    }
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
        if (previousStatus) transaction.status = this.transactionStateMachine.restore(previousStatus);
        throw error;
      }
    }
    await this.hooks.emit("AfterValidate", this, result);
    this.journal.record({ actor: "validator", action: "validate", transactionId: input.transactionId, outputSummary: result.ok ? "ok" : `${result.diagnostics.length} diagnostic(s)` });
    return result;
  }

  /**
   * 在事务暂存态（无事务时为当前工作区）上跑 validator 与 adapter 校验。只产出结果，不改事务
   * 状态、不发布生命周期——apply 在锁内复核 rebase 后的补丁链时也用它。
   */
  private async runValidators(input: ValidateInput): Promise<ValidationResult> {
    const overlay = await this.buildTransactionContentOverlay(input.transactionId);
    // validator 优先读取事务暂存内容，再回退到当前工作区文件。
    const ctx = {
      getTransaction: (idValue: string) => this.getTransaction(idValue),
      root: this.root,
      policy: this.policy,
      providers: this.providers,
      readFile: this.createOverlayFileReader(overlay.contentByPath),
    };
    const result = await this.validators.validate(input, ctx);
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
    return { ...result, ok: result.diagnostics.every((d) => d.severity !== "error") };
  }

  /** 回滚已应用事务，并把 apply 对 git intent-to-add 标记的增删一并撤回。 */
  public async rollback(input: RollbackInput): Promise<RollbackResult> {
    return this.runTransactionCommand(input.transactionId, () => this.rollbackSerialized(input));
  }

  private async rollbackSerialized(input: RollbackInput): Promise<RollbackResult> {
    await this.hooks.emit("BeforeRollback", this, input);
    const tx = this.transactions.get(input.transactionId);
    if (!tx) throw new ProjectError("INVALID_INPUT", `未知事务：${input.transactionId}`);
    const execution = this.transactionStateMachine.beginRollback(tx);
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
      // 预检：每个补丁都必须可撤销（`canRevertToOriginal`：写入前不存在的新建，或带可还原的旧正文，
      // 含覆盖既有文件的 create_file）。否则用 "" 写盘会把文件截断为空（静默丢数据），宁可整体失败也不半改。
      for (const patch of reversed) {
        if (!this.canRevertToOriginal(patch)) {
          throw new ProjectError(
            "PATCH_APPLY_ERROR",
            `无法回滚事务 ${tx.transactionId}：补丁缺少可还原的旧正文（${patch.path}）`,
            { path: patch.path, op: patch.metadata?.op },
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
          if (this.createsMissingFile(patch)) {
            await this.store.remove(patch.path, { skipFileFilter: true });
            rolledBackRevisions[patch.path] = "deleted";
          } else {
            const snapshot = await this.store.write(patch.path, patch.oldContent ?? "", {
              skipFileFilter: true,
              encoding: this.patchTextEncoding(patch),
            });
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
      tx.status = this.transactionStateMachine.commit(execution);
      const rollbackRevisions = tx.changedFiles.map((pathValue) => ({
        path: pathValue,
        before: beforeRollback.find((revision) => revision.path === pathValue)?.after,
        after: rolledBackRevisions[pathValue],
      }));
      try {
        this.publishTransactionChange(tx, "rolled_back", [], rollbackRevisions);
      } catch (stateError) {
        tx.status = this.transactionStateMachine.abort(execution);
        if (pending) await this.restoreDurableOperation(pending);
        else await this.restoreAppliedFiles(writtenOrder, restoreByPath, tx.transactionId);
        throw stateError;
      }

      const gitUntrackedFiles = await this.untrackCreatedFilesFromGit(metadataPaths(tx.metadata?.gitTrackedFiles));
      // apply 为被删路径撤掉的 intent-to-add 随文件恢复挂回去，git 视野回到 apply 之前。
      const gitTrackedFiles = await this.trackCreatedFilesInGit(metadataPaths(tx.metadata?.gitUntrackedFiles));
      this.retainTerminalTransaction(tx.transactionId);
      this.persistCommittedTransactionState(tx.transactionId, "git metadata or terminal retention");
      const result: RollbackResult = {
        status: "rolled_back",
        transactionId: tx.transactionId,
        changedFiles: tx.changedFiles,
        gitUntrackedFiles: optionalWhen((gitUntrackedFiles.length > 0), gitUntrackedFiles),
        gitTrackedFiles: optionalWhen((gitTrackedFiles.length > 0), gitTrackedFiles),
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
      this.assertEditsReadOriginal(prepared, currentSnapshot);
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
