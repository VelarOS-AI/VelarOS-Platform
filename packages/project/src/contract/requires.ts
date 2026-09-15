

import type {
  ApprovalPort,
  FileContextCarrier,
} from '@velaros-ai/agent/tool-contract'
import type { ScopeRef } from '@velaros-ai/kernel/contracts/abi'

import type { AdapterCapability, AdapterKind, AdapterPrepareEditInput, AdapterSearchHit, AdapterSearchInput, AdapterValidateInput, ParseInput, ParseResult, ProjectSymbol } from '../types/adapter.js'
import type { AgentProjectApplyResult, AgentProjectDiffResult,AgentProjectFixResult, AgentProjectKernelReadResult, AgentProjectPreparedTransaction, AgentProjectResolveTargetResult, AgentProjectSearchResult, AgentProjectStoredTransaction, AgentProjectValidationResult } from '../types/agent-port.js'
import type { ProjectChangeRecord,ProjectChangeRecordInput } from '../types/change-feed.js'
import type { ApplyEditInput, PreparedPatch, PrepareEditInput, RollbackInput, RollbackResult } from '../types/edit.js'
import type { FixInput, FixResult,ProjectFixContext } from '../types/fix.js'
import type { HookContext,HookEvent } from '../types/hook.js'
import type { FileStatInput, FileStatResult, ObserveInput, ReadInput, SearchInput } from '../types/io.js'
import type { PatchStrategyInput } from '../types/patch.js'
import type { PipelineContext } from '../types/pipeline.js'
import type { ApprovalRequest,CorePolicy, PolicyDecision, PolicyDecisionInput } from '../types/policy.js'
import type {
  ProjectAuthorizationDecision,
  ProjectCommandResult,
  ProjectMutationAuthorizationInput,
  ProjectRunCommandOptions,
  ProjectSandboxApplyOptions,
  ProjectSandboxApplyResult,
  ProjectSandboxCreateRequest,
  ProjectSandboxDiff,
  ProjectSandboxDiffOptions,
  ProjectSandboxDiscardResult,
  ProjectSandboxRecord,
  ProjectSandboxRunOptions,
} from '../types/project.js'
import type { CommandRunInput, CommandRunResult,FileFilterInput, ProjectIntelligenceLocation, ProjectIntelligenceSymbol, RedactionInput, RedactionResult } from '../types/provider.js'
import type { FileSnapshot } from '../types/snapshot.js'
import type { ResolveTargetInput, ResolveTargetResult } from '../types/target.js'
import type { ProjectValidationContext,ValidateInput, ValidationResult } from '../types/validation.js'
import type { ProjectCodeQuery } from '../utils/schemas/code-query.js'

import type { ProjectChangeFeed } from './provides.js'

export type ProjectToolContextResolver = (
  scope: LooseOptional<ScopeRef>,
  signal: AbortSignal,
) => ProjectToolContext | Promise<ProjectToolContext>

export interface CreateProjectKernelModuleOptions {
  readonly resolveContext: ProjectToolContextResolver
}

export interface AgentProjectKernelPort {
  prepareContextSnapshot?(input: { path: string; content: string }): Promise<{ content: string; redacted: boolean }>
  listFiles(input?: ObserveInput): Promise<Array<{ path: string; type: 'file' | 'directory' }>>
  stat(input: FileStatInput): Promise<FileStatResult>
  read(input: ReadInput): Promise<AgentProjectKernelReadResult>
  search(input: SearchInput): Promise<AgentProjectSearchResult>
  listSymbols(path: string): Promise<ProjectSymbol[]>
  resolveTarget(input: ResolveTargetInput): Promise<AgentProjectResolveTargetResult>
  prepareEdit(input: PrepareEditInput): Promise<AgentProjectPreparedTransaction>
  discardTransaction(transactionId: string): { discarded: boolean }
  getTransaction(
    transactionId: string
  ): AgentProjectStoredTransaction | undefined
  fixTransaction(input: FixInput): Promise<AgentProjectFixResult>
  applyEdit(input: ApplyEditInput): Promise<AgentProjectApplyResult>
  validate(input: ValidateInput): Promise<AgentProjectValidationResult>
  rollback(input: RollbackInput): Promise<RollbackResult>
  diff(input?: { transactionId?: string }): Promise<AgentProjectDiffResult>
  status(): Promise<{ root: string; validators: string[] }>
}

/** Producer contract retained by ProjectKernel; UI consumers only receive ProjectChangeFeed. */
export interface ProjectChangeFeedWriter extends ProjectChangeFeed {
  record(change: ProjectChangeRecordInput): ProjectChangeRecord
}

/** 针对指定内核 phase 的有序输入/输出转换 hook。 */
export interface PipelineStage<I = any, O = any> {
  id: string;
  phase: string;
  order?: number;
  run(input: I, ctx: PipelineContext): Promise<O> | O;
}

export interface ProjectHook {
  id: string;
  event: HookEvent;
  /** 有副作用的 hook；抛错会中止触发该事件的操作。 */
  run(ctx: HookContext): Promise<void> | void;
}

export interface ProjectFixer {
  id: string;
  /** 运行潜在昂贵 fixer 前的低成本适用性检查。 */
  canFix(input: FixInput, ctx: ProjectFixContext): Promise<boolean> | boolean;
  fix(input: FixInput, ctx: ProjectFixContext): Promise<FixResult> | FixResult;
}

export interface ProjectValidator {
  id: string;
  /** 除 validator id 外可用于 ValidateInput.checks 选择本 validator 的稳定别名。 */
  readonly checkIds?: readonly string[];
  /** 快速过滤器，让 registry 跳过与本次请求无关的 validator。 */
  canValidate(input: ValidateInput): boolean;
  /** 由校验器声明完整依赖指纹；必须覆盖源码、配置和环境。缺省或返回 undefined 时每次执行。 */
  cacheKey?(input: ValidateInput, context: ProjectValidationContext): Promise<string | undefined> | string | undefined;
  validate(
    input: ValidateInput,
    context: ProjectValidationContext,
  ): Promise<ValidationResult> | ValidationResult;
}

export interface PatchStrategy {
  id: string;
  /** 多个 strategy 都能处理同一 intent 时，priority 更高者优先。 */
  priority?: number;
  canHandle(input: PatchStrategyInput): boolean;
  prepare(input: PatchStrategyInput): Promise<PreparedPatch[]> | PreparedPatch[];
}

export interface FileAdapter {
  id: string
  kind: AdapterKind
  /** 搜索、目标解析和编辑时优先尝试 priority 更高的 adapter。 */
  priority?: number
  capabilities: AdapterCapability[]
  parse?(input: ParseInput): Promise<ParseResult> | ParseResult
  search?(input: AdapterSearchInput): Promise<AdapterSearchHit[]> | AdapterSearchHit[]
  resolveTarget?(
    input: ResolveTargetInput & { snapshot: FileSnapshot }
  ): Promise<ResolveTargetResult> | ResolveTargetResult
  prepareEdit?(input: AdapterPrepareEditInput): Promise<PreparedPatch[]> | PreparedPatch[]
  validate?(input: AdapterValidateInput): Promise<ValidationResult> | ValidationResult
}

export interface FileAdapterFactory {
  id: string
  /** 创建 adapter 前对每个文件快照执行的快速适配性检查。 */
  canHandle(snapshot: FileSnapshot): Promise<boolean> | boolean
  create(input: { snapshot: FileSnapshot; kernel: any }): Promise<FileAdapter> | FileAdapter
}

/** 可安装的扩展点集合，用于注册 adapter、strategy、validator、hook 和 fixer。 */
export interface ProjectPlugin {
  name: string;
  version: string;
  setup(ctx: ProjectPluginContext): Promise<void> | void;
}

export interface ProjectPluginContext {
  /** 将能力注册到正在安装该插件的内核中。 */
  registerAdapterFactory(factory: FileAdapterFactory): void;
  registerPatchStrategy(strategy: PatchStrategy): void;
  registerValidator(validator: ProjectValidator): void;
  registerFixer(fixer: ProjectFixer): void;
  registerHook(hook: ProjectHook): void;
  registerPipelineStage(stage: PipelineStage): void;
}

/** 宿主应用可选的动态策略决策 hook。 */
export interface PolicyProvider {
  decide(input: PolicyDecisionInput): Promise<PolicyDecision> | PolicyDecision;
}

export interface ApprovalProvider {
  approve(input: ApprovalRequest): Promise<boolean> | boolean;
}

/** Narrow injectable code-intelligence surface consumed by Project. */
export interface ProjectCodeIntelligenceHost {
  readonly available: boolean;
  isProjectEnabled(projectRoot: string): boolean;
  listSymbols(input: {
    projectRoot: string;
    path: string;
  }): Promise<ProjectIntelligenceSymbol[]>;
  getDefinition(input: {
    projectRoot: string;
    path: string;
    line: number;
    column: number;
    symbol?: string;
  }): Promise<ProjectIntelligenceLocation[]>;
}

/** 宿主提供的文件可见性过滤器，叠加在静态 deny glob 之上。 */
export interface FileFilterProvider {
  shouldInclude(input: FileFilterInput): Promise<boolean> | boolean;
}

export interface SecretRedactionProvider {
  /** 返回可以安全暴露给工具、日志和模型上下文的内容。 */
  redact(input: RedactionInput): Promise<RedactionResult> | RedactionResult;
}

export interface ContextProvider {
  /** 为 evidence pack 补充或附加宿主侧元数据。 */
  buildEvidence?(input: any): Promise<any> | any;
  /** evidence 离开 project 边界前的最后清洗步骤。 */
  sanitize?(input: any): Promise<any> | any;
}

export interface LoggerProvider {
  debug?(message: string, data?: any): void;
  info?(message: string, data?: any): void;
  warn?(message: string, data?: any): void;
  error?(message: string, data?: any): void;
}

export interface CommandProvider {
  /** 受控子进程 runner，供 git、ripgrep、validator 和 fixer 使用。 */
  run(input: CommandRunInput): Promise<CommandRunResult> | CommandRunResult;
}

export interface TelemetryProvider {
  emit?(event: { name: string; properties?: Record<string, any>; timestamp?: number }): void | Promise<void>;
}

export interface SandboxProvider {
  create?(input: { root: string; reason?: string }): Promise<{ root: string; dispose?: () => Promise<void> | void }> | { root: string; dispose?: () => Promise<void> | void };
}

export interface ProjectProviders {
  /** 嵌入运行时提供的动态策略、审批和 IO hook。 */
  policy?: PolicyProvider;
  approval?: ApprovalProvider;
  fileFilter?: FileFilterProvider;
  secretRedaction?: SecretRedactionProvider;
  context?: ContextProvider;
  logger?: LoggerProvider;
  command?: CommandProvider;
  telemetry?: TelemetryProvider;
  sandbox?: SandboxProvider;
  /** 可选代码智能后端（由宿主注入，例如 CodeGraph MCP）。 */
  codeIntelligence?: ProjectCodeIntelligenceHost;
}

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

export type { ProjectAuthorizationDecision }

export interface ProjectToolApi {
  getRootPath: () => string
  runInDirectory: <T>(path: string, action: () => Promise<T>) => Promise<T>
  kernel: () => Promise<AgentProjectKernelPort>
  runWithApproval: <T>(action: () => Promise<T>) => Promise<T>
  prepareMutation: (
    input: ProjectMutationAuthorizationInput
  ) => Promise<ProjectAuthorizationDecision>
  runCommand: (
    command: string,
    options?: ProjectRunCommandOptions,
    allowDangerous?: boolean,
    abortSignal?: AbortSignal
  ) => Promise<ProjectCommandResult>
  /** Project 内置代码理解入口；宿主可用 CodeGraph 覆盖同一 action 面的增强查询。 */
  queryCode: (input: ProjectCodeQuery, context: ProjectToolContext) => Promise<unknown>
  /** Optional graph analysis backend; ordinary code queries remain available independently. */
  codeAnalysisAvailable?: () => boolean
  /** 演练沙箱端口；宿主用系统能力实现（Desktop 用本地内核）。没接的宿主没有 project:sandbox。 */
  sandbox?: ProjectSandboxPort
}

/**
 * 演练沙箱端口：把项目目录镜像到临时区，镜像里跑的命令被宿主约束在镜像根之内，跑完能看差量、能把文件变化落回项目、能整个丢弃。
 * 项目工具出不了项目边界，所以在镜像里跑命令也经这个端口（runInSandbox），不走 project:run。
 */
export interface ProjectSandboxPort {
  /** 建沙箱：source 已经是项目内的绝对路径；没有约束后端时宿主拒绝，不留目录。 */
  createSandbox: (options: ProjectSandboxCreateRequest) => Promise<ProjectSandboxRecord>
  /** 在镜像根里跑一条命令，约束钉在镜像根，写到项目会失败。 */
  runInSandbox: (options: ProjectSandboxRunOptions, abortSignal?: AbortSignal) => Promise<ProjectCommandResult>
  /** 镜像相对创建时的变化。 */
  diffSandbox: (options: ProjectSandboxDiffOptions) => Promise<ProjectSandboxDiff>
  /** 把镜像里的文件变化落回项目：源文件自建沙箱以来变过整批不落；.git 永远不落。授权与确认由工具在调用前完成。 */
  applySandbox: (options: ProjectSandboxApplyOptions) => Promise<ProjectSandboxApplyResult>
  /** 删掉镜像；路径不在沙箱基目录之下时宿主拒绝。 */
  discardSandbox: (sandboxId: string) => Promise<ProjectSandboxDiscardResult>
}

export interface ProjectToolContext extends FileContextCarrier {
  abortSignal: AbortSignal
  project: ProjectToolApi
  approval: ApprovalPort
}

export type ToolContext = ProjectToolContext

