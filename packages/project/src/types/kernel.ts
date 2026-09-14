import { type AuditEvent } from '../persistence/audit-journal.js'
import { type ProjectChangeFeed, type ProjectChangeFeedWriter } from '../persistence/change-feed.js'

import type { ProjectSymbol } from './adapter.js'
import type { BatchInput, BatchResult } from './batch.js'
import type { DiffResult, ProjectStatus } from './common.js'
import type { BuildEvidencePackInput, EvidencePack, TaskContext } from './context.js'
import type {
  AmendEditInput,
  ApplyEditInput,
  ApplyResult,
  PreparedTransaction,
  PrepareEditInput,
  RollbackInput,
  RollbackResult,
} from './edit.js'
import type { FixInput, FixResult } from './fix.js'
import type { ProjectHook } from './hook.js'
import type {
  FileListEntry,
  FileStatInput,
  FileStatResult,
  ObserveInput,
  ReadInput,
  ReadResult,
  SearchInput,
  SearchResult,
} from './io.js'
import type { ProjectPlugin } from './plugin.js'
import type { CorePolicy } from './policy.js'
import type { CommandProvider, ProjectProviders } from './provider.js'
import type { ProjectSnapshot } from './snapshot.js'
import type { ResolveTargetInput, ResolveTargetResult } from './target.js'
import type { StoredTransaction } from './transaction.js'
import type { ValidateInput, ValidationResult } from './validation.js'

/** 创建工作区内核的配置；每个内核都锚定在一个根目录下。 */
export interface CreateProjectKernelOptions {
  root: string
  corePolicy?: Partial<CorePolicy>
  providers?: ProjectProviders
  plugins?: ProjectPlugin[]
  includeBuiltinPlugins?: boolean
  metadata?: Record<string, any>
  /** 宿主持有写端；编辑器等消费者只能从 kernel.changeFeed 读取。 */
  changeFeed?: ProjectChangeFeedWriter
  /** 宿主私有、项目根绑定的可恢复事务状态文件。 */
  transactionStatePath?: string
}

/** Project Agent 与 Kernel capability 共用的项目内核接口。 */
export interface ProjectKernel {
  prepareContextSnapshot(input: { path: string; content: string }): Promise<{ content: string; redacted: boolean }>
  readonly root: string
  readonly policy: CorePolicy
  readonly providers: ProjectRuntimeProviders
  readonly changeFeed: ProjectChangeFeed
  observe(input?: ObserveInput): Promise<ProjectSnapshot>
  /** 列出相对工作区根目录的文件和目录。 */
  listFiles(input?: ObserveInput): Promise<FileListEntry[]>
  stat(input: FileStatInput): Promise<FileStatResult>
  read(input: ReadInput): Promise<ReadResult>
  search(input: SearchInput): Promise<SearchResult>
  listSymbols(path: string): Promise<ProjectSymbol[]>
  resolveTarget(input: ResolveTargetInput): Promise<ResolveTargetResult>
  createTaskContext(input: Omit<TaskContext, 'taskId' | 'createdAt'>): TaskContext
  buildEvidencePack(input: BuildEvidencePackInput): Promise<EvidencePack>
  prepareEdit(input: PrepareEditInput): Promise<PreparedTransaction>
  /** 丢弃一个尚未应用的已暂存事务（dryRun 预览用）；已应用的事务请用 rollback。 */
  discardTransaction(transactionId: string): { discarded: boolean }
  amendEdit(input: AmendEditInput): Promise<PreparedTransaction>
  fixTransaction(input: FixInput): Promise<FixResult>
  applyEdit(input: ApplyEditInput): Promise<ApplyResult>
  validate(input: ValidateInput): Promise<ValidationResult>
  rollback(input: RollbackInput): Promise<RollbackResult>
  diff(input?: { transactionId?: string }): Promise<DiffResult>
  /** 读取内存中已暂存/已应用事务；apply 前预检与 amend 路径使用。 */
  getTransaction(transactionId: string): StoredTransaction | undefined
  status(): Promise<ProjectStatus>
  getJournal(): AuditEvent[]
  runBatch(input: BatchInput): Promise<BatchResult>
  /** 注册监听内核生命周期事件的 hook。 */
  registerHook(hook: ProjectHook): void
}

export type ProjectRuntimeProviders = ProjectProviders & {
  command: CommandProvider
}
