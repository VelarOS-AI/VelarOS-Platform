/**
 * 注入面：宿主必须或可以塞进来的东西，每个注入点一个接口。本单元只从这些口子接收外部能力，别处不留钩子。
 *
 * - 调用上下文 `ProjectOperationContext`：必须。空间每次分发 `velaros:project`、`velaros:code` 的调用时给，里面是空间端口 `ProjectSpacePort`（写作 `ctx.project`）；
 *   空间端口的 `kernel()` 交出项目内核的 Agent 视图 `AgentProjectKernelPort`。
 * - 宿主端口 `ProjectHostPort`：给共用能力装项目端口（`projectCapabilityPorts`）时给。它在空间端口之上再加跑命令、演练沙箱与缩图，
 *   那些是共用能力要的，两件项目工具用不着。
 * - 内核配置 `CreateProjectKernelOptions`：建项目内核时必须。里面的宿主能力 `ProjectProviders`（列举过滤、证据包、日志、子进程、遥测、代码智能）
 *   与变更记录写端 `ProjectChangeFeedWriter` 都可选。
 * - 插件 `ProjectPlugin`：可选，放在内核配置里给；插件在 setup 里经 `ProjectPluginContext` 登记文件适配器工厂 `FileAdapterFactory`、补丁策略 `PatchStrategy`、
 *   校验器 `ProjectValidator`、修复器 `ProjectFixer`、生命周期 hook `ProjectHook` 与管线阶段 `PipelineStage`。
 *
 * 这里的每个接口都必须从根入口导出。
 */

import type { ImageResizeRequest, ImageResizeResult } from '@velaros-ai/velaros/images'
import type { RehearsalSandboxHostPort } from '@velaros-ai/velaros/sandbox'
import type { ShellHostPort } from '@velaros-ai/velaros/shell'

import type {
  AdapterCapability,
  AdapterKind,
  AdapterPrepareEditInput,
  AdapterSearchHit,
  AdapterSearchInput,
  AdapterValidateInput,
  ParseInput,
  ParseResult,
  ProjectSymbol,
} from '../types/adapter.js'
import type {
  AgentProjectApplyResult,
  AgentProjectKernelReadResult,
  AgentProjectPreparedTransaction,
  AgentProjectSearchResult,
  AgentProjectStoredTransaction,
} from '../types/agent-port.js'
import type { ProjectChangeRecord, ProjectChangeRecordInput } from '../types/change-feed.js'
import type { EvidencePack } from '../types/context.js'
import type {
  ApplyEditInput,
  PreparedPatch,
  PrepareEditInput,
  RollbackInput,
  RollbackResult,
} from '../types/edit.js'
import type { FixInput, FixResult, ProjectFixContext } from '../types/fix.js'
import type { HookContext, HookEvent } from '../types/hook.js'
import type {
  FileStatInput,
  FileStatResult,
  ObserveInput,
  ReadInput,
  SearchInput,
} from '../types/io.js'
import type { PatchStrategyInput } from '../types/patch.js'
import type { PipelineContext, PipelinePhase } from '../types/pipeline.js'
import type { CorePolicy } from '../types/policy.js'
import type { ProjectCodeIndexQuery, ProjectCodeQuery } from '../types/project.js'
import type {
  CommandRunInput,
  CommandRunResult,
  FileFilterInput,
  ProjectIntelligenceLocation,
  ProjectIntelligenceSymbol,
} from '../types/provider.js'
import type { FileSnapshot } from '../types/snapshot.js'
import type { ResolveTargetInput, ResolveTargetResult } from '../types/target.js'
import type {
  ProjectValidationContext,
  ValidateInput,
  ValidationResult,
} from '../types/validation.js'

import type { ProjectChangeFeed, ProjectKernel } from './provides.js'

// ── 项目内核的 Agent 视图 ───────────────────────────────────────

/**
 * 项目内核的 Agent 视图：工具经 `ctx.project.kernel()` 拿到它，读、列、搜、提交、撤销都经它，改动走项目的事务。
 * 宿主一般直接交 `createProjectKernel` 建的内核（`ProjectKernel` 在结构上满足它）。自己实现时照内核的语义：路径一律相对项目根，
 * 出了项目抛 PERMISSION_DENIED；失败时抛带 `reason`（`ProjectErrorCodes` 里的码）、`details`、`suggestedNextAction` 的错误，
 * 工具按码分支，模型按下一步自救。
 */
export interface AgentProjectKernelPort {
  /**
   * 列项目里的文件和目录，每项是相对项目根的路径加类型：按 path、include/exclude、是否递归与深度过滤，缺省跳过 .gitignore 忽略的条目，
   * 按深度优先的稳定顺序最多给 maxFiles 条。
   */
  listFiles(input?: ObserveInput): Promise<Array<{ path: string; type: 'file' | 'directory' }>>
  /** 看一个路径的轻量状态：存不存在、文件还是目录、大小、是不是可读文本及其磁盘编码、行数、当前 revision 和建议的首次读取范围；不返回正文。 */
  stat(input: FileStatInput): Promise<FileStatResult>
  /**
   * 读一个文件：可按行列范围、maxChars、maxBytes 截取，返回带 revision 的快照、正文、实际范围、总行数、
   * 是否还有后文与续读位置。给了 baseRevision 而文件已变时抛 BASE_REVISION_MISMATCH；目录、不存在、二进制不抛错，在快照里如实标出、不给正文。
   */
  read(input: ReadInput): Promise<AgentProjectKernelReadResult>
  /**
   * 按字面文本（regex 为真时按正则）在项目或 root 子目录里搜，include/exclude 过滤、maxResults 封顶；返回命中的路径、revision、范围与片段、
   * 是否截断，以及缺搜索命令时的 toolRequirements。
   */
  search(input: SearchInput): Promise<AgentProjectSearchResult>
  /** 列一个文件里的符号（名字、种类、容器、范围）：宿主的代码智能对这个项目启用时先问它，出错或没结果再用本地适配器解析。`velaros:code` 凭它核对目标符号的声明位置。 */
  listSymbols(path: string): Promise<ProjectSymbol[]>
  /**
   * 按编辑意图准备一个事务：算出每个文件的补丁、差量、改动行数与风险，不碰磁盘。baseRevisions 对不上抛 BASE_REVISION_MISMATCH；超出事务规模、
   * 定位不到或不唯一时抛对应的错误码。返回的 transactionId 交给 applyEdit 提交，或交给 discardTransaction 丢弃。
   */
  prepareEdit(input: PrepareEditInput): Promise<AgentProjectPreparedTransaction>
  /** 丢掉一个还没提交的事务，返回有没有丢：事务不存在返回 false；已提交的不能丢（要撤销用 rollback），正在执行的抛 INVALID_INPUT。改动工具在提交失败后用它清掉事务。 */
  discardTransaction(transactionId: string): { discarded: boolean }
  /**
   * 按事务号取内核里的事务（补丁、改动文件、差量、状态、提交时间），调用方只读；不存在或已被淘汰时返回 undefined。
   * `velaros:project` 的 edit 提交后凭它取最终补丁，inspect、undo 凭它核对回执。
   */
  getTransaction(transactionId: string): AgentProjectStoredTransaction | undefined
  /**
   * 提交一个事务：先跑校验（不过抛 VALIDATION_FAILED），再锁住改动的文件写盘；文件在准备之后被外部改过时先试着 rebase，
   * 接不上抛 BASE_REVISION_MISMATCH。多个文件要么全部写入、要么全部还原；新建的文件在 git 仓库里挂上 intent-to-add。返回每个文件提交前后的 revision。
   */
  applyEdit(input: ApplyEditInput): Promise<AgentProjectApplyResult>
  /**
   * 撤销一个已提交的事务：先核对每个文件仍是提交后的样子（被外部改过就抛 CONFLICT_WITH_EXTERNAL_EDIT，不覆盖），再逆序写回原文、删掉事务新建的文件，
   * 并撤回提交时对 git intent-to-add 的增删；要么全部撤回，要么保持原样。`velaros:project` 的 undo 调它。
   */
  rollback(input: RollbackInput): Promise<RollbackResult>
  /** 内核的状态：项目根（绝对路径）与已登记的校验器 id。工具凭 root 核对当前工作区没有换。 */
  status(): Promise<{ root: string; validators: string[] }>
}

// ── 变更记录写端 ────────────────────────────────────────────────

/**
 * 变更记录的写端：内核在事务每次状态变化（准备、修补、校验、校验失败、提交、撤销、丢弃）后写一条，界面与审计经只读的 `ProjectChangeFeed` 读。
 * 写端归宿主持有，经 `CreateProjectKernelOptions.changeFeed` 交给内核；本包自带落盘实现 `createFileProjectChangeFeed`，不给时内核用内存版。
 */
export interface ProjectChangeFeedWriter extends ProjectChangeFeed {
  /** 记下一个事务的最新投影（同一事务只留最新一条），返回带序号与更新时间的记录并通知订阅者。抛错不影响事务本身，内核只经 logger 记一条告警。 */
  record(change: ProjectChangeRecordInput): ProjectChangeRecord
}

// ── 插件与扩展点 ────────────────────────────────────────────────

/**
 * 管线阶段：在内核处理某类请求之前改写它的输入。同一阶段名下的各段按 order 从小到大串起来，前一段的输出是后一段的输入。
 * 阶段名有五个：observe.input、read.input、search.input、resolve.input、prepare.input。
 */
export interface PipelineStage<I = any, O = any> {
  /** 这一段的标识；内核不按它去重。 */
  id: string
  /** 挂在哪个阶段。 */
  phase: PipelinePhase
  /** 同一阶段里的先后，小的先跑；缺省 0，相同时按登记顺序。 */
  order?: number
  /** 改写输入并返回改写后的值（可以原样返回）；ctx 里有内核实例和阶段名。抛错时这次请求失败。 */
  run(input: I, ctx: PipelineContext): Promise<O> | O
}

/** 生命周期 hook：内核在读、搜索、解析目标、准备编辑、提交、校验、撤销的前后发出事件，同一事件的 hook 按登记顺序依次执行。 */
export interface ProjectHook {
  /** 这个 hook 的标识；内核不按它去重。 */
  id: string
  /** 订阅的事件：Read、Search、Resolve、PrepareEdit、ApplyEdit、Validate、Rollback 各有 Before 与 After 两个。 */
  event: HookEvent
  /**
   * 事件发生时执行，ctx 里有事件名、内核实例与事件数据（Before 事件是请求，After 事件是结果）。
   * Before 事件里抛错，这次操作就不做了；After 事件里抛错时操作已经完成（比如文件已经写入），调用仍以这个错误失败。
   */
  run(ctx: HookContext): Promise<void> | void
}

/** 修复器：在未提交事务的暂存内容上自动修正问题（格式、导入等），修出的内容由内核并进事务。经 fixTransaction 触发，按登记顺序逐个试。 */
export interface ProjectFixer {
  /** 修复器标识；FixInput.checks 按它挑选，诊断的来源也用它命名。 */
  id: string
  /** 运行潜在昂贵的 fix 之前的低成本适用性检查，返回 false 就跳过；抛错记成一条诊断，不影响其他修复器。 */
  canFix(input: FixInput, ctx: ProjectFixContext): Promise<boolean> | boolean
  /**
   * 修复：经 ctx.readFile 读暂存内容（没暂存的读工作区），返回修好的整文件内容（fixes）、改没改、诊断；改动只经返回值交回，由内核并进事务。
   * 抛错记成一条诊断，这次修复算失败。
   */
  fix(input: FixInput, ctx: ProjectFixContext): Promise<FixResult> | FixResult
}

/** 校验器：提交之前在事务的暂存内容上（不带事务时在当前工作区上）做检查，有一项不过事务就不能提交。按登记顺序逐个跑。 */
export interface ProjectValidator {
  /** 校验器标识；ValidateInput.checks 可按它挑选，结果里的检查项也以它命名。 */
  id: string
  /** 除 validator id 外可用于 ValidateInput.checks 选择本 validator 的稳定别名。 */
  readonly checkIds?: readonly string[]
  /** 快速过滤器，让 registry 跳过与本次请求无关的 validator。 */
  canValidate(input: ValidateInput): boolean
  /** 依赖指纹：必须覆盖结果依赖的源码、配置和环境；同一指纹下通过过的结果直接复用。缺省或返回 undefined 时每次都跑。 */
  cacheKey?(
    input: ValidateInput,
    context: ProjectValidationContext
  ): Promise<string | undefined> | string | undefined
  /**
   * 做检查：经 context.readFile 读暂存内容（没暂存的读工作区），返回是否通过、诊断与检查项；有 error 级诊断即算不通过。
   * 抛错时这次 validate 直接失败，提交也随之失败。
   */
  validate(
    input: ValidateInput,
    context: ProjectValidationContext
  ): Promise<ValidationResult> | ValidationResult
}

/** 补丁策略：把一个编辑意图变成具体补丁。文件适配器都不接手的意图，交给 canHandle 为真的策略里 priority 最高的那个。 */
export interface PatchStrategy {
  /** 策略的标识；内核不按它去重。 */
  id: string
  /** 多个 strategy 都能处理同一 intent 时，priority 更高者优先。 */
  priority?: number
  /** 能不能处理这个意图（按操作类型、目标文件判断）；一个策略都不能处理时 prepareEdit 报 NOT_SUPPORTED。 */
  canHandle(input: PatchStrategyInput): boolean
  /** 生成补丁：基于 input.snapshot 算出新内容与差量，不碰磁盘；定位失败时抛带 reason 错误码的错误。 */
  prepare(input: PatchStrategyInput): Promise<PreparedPatch[]> | PreparedPatch[]
}

/**
 * 文件适配器：懂某一类文件（文本、JSON、Markdown、代码等）的解析、搜索、目标定位、编辑与校验。由适配器工厂按文件快照新建，
 * 同一个文件可以有好几个，按 priority 从高到低试；每个方法都可以不实现，内核按方法在不在决定调不调。
 */
export interface FileAdapter {
  /** 适配器标识；快照的 adapterIds 与解析出的符号里记着它。 */
  id: string
  /** 适配的内容大类（文本、代码、结构化数据、文档、图片、二进制等）；内核不按它分派。 */
  kind: AdapterKind
  /** 搜索、目标解析和编辑时优先尝试 priority 更高的 adapter。 */
  priority?: number
  /** 声明支持哪些能力（读、搜索、定位、编辑、校验、渲染、符号）；内核只看方法在不在，这一项只作说明。 */
  capabilities: AdapterCapability[]
  /** 解析快照，返回语法诊断与符号；宿主的代码智能用不上时，listSymbols 靠它列符号。 */
  parse?(input: ParseInput): Promise<ParseResult> | ParseResult
  /** 在一个文件里搜；ripgrep 用不上时内核逐文件调它。 */
  search?(input: AdapterSearchInput): Promise<AdapterSearchHit[]> | AdapterSearchHit[]
  /** 在快照里定位目标（符号、文本线索）：第一个 resolved 的结果被采用，ambiguous 的候选汇总起来，都 not_found 时报找不到。 */
  resolveTarget?(
    input: ResolveTargetInput & { snapshot: FileSnapshot }
  ): Promise<ResolveTargetResult> | ResolveTargetResult
  /** 为一个编辑意图出补丁：返回非空就采用，空数组或 undefined 让给下一个适配器，都不接手才轮到补丁策略。 */
  prepareEdit?(input: AdapterPrepareEditInput): Promise<PreparedPatch[]> | PreparedPatch[]
  /** 校验一个文件的暂存内容（changedContent；没暂存时看工作区的快照），结果并进这次 validate。 */
  validate?(input: AdapterValidateInput): Promise<ValidationResult> | ValidationResult
}

/** 文件适配器工厂：内核每次要处理一个文件（读、搜索、定位、编辑、校验）时，问每个工厂能不能处理这个快照，能就为它新建一个适配器。 */
export interface FileAdapterFactory {
  /** 工厂标识；同一个 id 只认第一次登记，后来的忽略。 */
  id: string
  /** 创建 adapter 前对每个文件快照执行的快速适配性检查。 */
  canHandle(snapshot: FileSnapshot): Promise<boolean> | boolean
  /** 为这个快照新建适配器；kernel 是当前内核实例，适配器要读别的文件时用它。 */
  create(input: {
    snapshot: FileSnapshot
    kernel: ProjectKernel
  }): Promise<FileAdapter> | FileAdapter
}

/** 可安装的扩展点集合，用于注册 adapter、strategy、validator、hook 和 fixer。建内核时经 `CreateProjectKernelOptions.plugins` 给，按顺序装在内置核心插件之后。 */
export interface ProjectPlugin {
  /** 插件名；同名插件在一个内核里只装一次，重复的直接跳过。 */
  name: string
  /** 插件版本；内核不读它。 */
  version: string
  /** 安装：经 ctx 登记扩展。抛错时插件不算装上（同名的以后还能再装），但抛错之前已经登记的扩展不会撤回；建内核随之失败。 */
  setup(ctx: ProjectPluginContext): Promise<void> | void
}

/** 插件安装时拿到的登记入口，由内核实现：插件拿到的是从内核上绑定下来的这六个方法，每个把一件扩展登记进正在安装这个插件的内核。 */
export interface ProjectPluginContext {
  /** 登记文件适配器工厂；同一个 id 只认第一次。 */
  registerAdapterFactory(factory: FileAdapterFactory): void
  /** 登记补丁策略，按 priority 重新排序。 */
  registerPatchStrategy(strategy: PatchStrategy): void
  /** 登记校验器；此后每次 validate 与提交前的校验都会问它。 */
  registerValidator(validator: ProjectValidator): void
  /** 登记修复器；此后 fixTransaction 会试它。 */
  registerFixer(fixer: ProjectFixer): void
  /** 登记生命周期 hook，和同一事件的其他 hook 按登记顺序执行。 */
  registerHook(hook: ProjectHook): void
  /** 登记管线阶段，按 order 重新排序。 */
  registerPipelineStage(stage: PipelineStage): void
}

// ── 内核的宿主能力 ──────────────────────────────────────────────

/** 代码智能后端（例如宿主的 CodeGraph 索引）：给了而且对当前项目启用时，内核列符号、按符号名解析目标都先问它，出错或没结果再回退本地适配器。 */
export interface ProjectCodeIntelligenceHost {
  /** 这个项目根是否启用了代码智能；返回 false 时内核完全不问这个后端。 */
  isProjectEnabled(projectRoot: string): boolean
  /** 列一个文件（path 相对项目根）里的符号，行列从 1 起算（和项目里的行号一致）；抛错或返回空时内核改用本地适配器解析。 */
  listSymbols(input: { projectRoot: string; path: string }): Promise<ProjectIntelligenceSymbol[]>
  /** 按文件、行列与符号名查定义位置，内核把第一个结果当作解析出的目标；抛错或没有结果时回退适配器。 */
  getDefinition(input: {
    projectRoot: string
    path: string
    line: number
    column: number
    symbol?: string
  }): Promise<ProjectIntelligenceLocation[]>
}

/** 宿主提供的列举过滤器：只管列举、扫描与搜索时哪些条目不出现，点名读写从不问它。 */
export interface FileFilterProvider {
  /**
   * 一个路径（相对项目根）在列举、扫描、搜索时出不出现：返回 false 的条目不出现在结果里（按路径与它解开符号链接后的真实路径各问一次）。
   * 点名的路径（读、写、stat、点名的列举或搜索起点及其下面的条目）不问它，照常能读能写。
   */
  shouldInclude(input: FileFilterInput): Promise<boolean> | boolean
}

/** 证据包后端：内核建证据包（buildEvidencePack）时让宿主补充元数据，并在交出去之前做最后清洗。 */
export interface ContextProvider {
  /** 为 evidence pack 补充宿主侧元数据：返回的对象挂在 pack.metadata.contextProvider 下，返回非对象则忽略。 */
  buildEvidence?(
    input: EvidencePack
  ): Promise<Record<string, unknown>> | Record<string, unknown> | undefined
  /** evidence 离开 project 边界前的最后清洗步骤：返回证据包就整个替换（没带 evidenceId 时沿用原来的），返回非对象则不改。 */
  sanitize?(input: EvidencePack): Promise<EvidencePack> | EvidencePack | undefined
}

/** 日志后端：内核把不影响结果的附带失败（变更记录写失败、事务状态二次落盘失败、git 索引维护失败）记到这里；校验器与修复器也经 providers 拿到它。 */
export interface LoggerProvider {
  /** 调试级日志；内核自己不写，留给插件。 */
  debug?(message: string, data?: any): void
  /** 信息级日志；内核自己不写，留给插件。 */
  info?(message: string, data?: any): void
  /** 告警：内核写的 message 是以 project. 开头的事件名，data 是事务号、错误等详情。 */
  warn?(message: string, data?: any): void
  /** 错误级日志；内核自己不写，留给插件。 */
  error?(message: string, data?: any): void
}

/** 子进程后端：内核跑 ripgrep、git，命令型校验器与修复器跑 prettier、eslint、tsc，都经它。没给时内核用自带的 Node 实现。 */
export interface CommandProvider {
  /**
   * 受控子进程 runner：跑一个程序（命令名加参数数组，不经 shell；可给 cwd、超时、环境变量、stdin），返回退出码与输出。非零退出与超时照常返回、不抛错；
   * 程序不存在时在 toolRequirements 里报 missing-command（退出码按惯例给 127），ripgrep 搜索据此改用逐文件扫描。
   */
  run(input: CommandRunInput): Promise<CommandRunResult> | CommandRunResult
}

/** 遥测后端：内核每跑完一次批处理（runBatch）发一条 project.batch 事件，属性是成败与工作池指标。 */
export interface TelemetryProvider {
  /** 发一条事件（名字、属性、时间戳）；内核不等它、也不处理它的失败，返回的 Promise 不要拒绝。 */
  emit?(event: {
    name: string
    properties?: Record<string, any>
    timestamp?: number
  }): void | Promise<void>
}

/** 内核的可选宿主能力，建内核时经 `CreateProjectKernelOptions.providers` 一次给齐；每一项都可以不给，不给时按各项说的缺省处理。 */
export interface ProjectProviders {
  /** 列举过滤：列举、扫描、搜索时哪些条目不出现；不给就只按 .gitignore 与调用方的 exclude。 */
  fileFilter?: FileFilterProvider
  /** 证据包的补充与清洗；不给就用内核建的原样。 */
  context?: ContextProvider
  /** 日志；不给就不记附带失败。 */
  logger?: LoggerProvider
  /** 子进程：ripgrep、git、命令型校验器经它跑；不给就用内核自带的 Node 实现。 */
  command?: CommandProvider
  /** 遥测；不给就不发。 */
  telemetry?: TelemetryProvider
  /** 可选代码智能后端（由宿主注入，例如 CodeGraph MCP）：列符号、按符号名解析目标时先问它；不给就只用本地适配器。 */
  codeIntelligence?: ProjectCodeIntelligenceHost
}

// ── 建内核 ──────────────────────────────────────────────────────

/** 创建项目内核的配置：`createProjectKernel` 时宿主给；每个内核都锚定在一个根目录下，读写出不了这个根。 */
export interface CreateProjectKernelOptions {
  /** 项目根目录；按绝对路径解析，所有路径都相对它，越出它的一律拒绝。 */
  root: string
  /** 覆盖默认的静态策略（读写上限、事务规模、revision 算法等）；只给要改的项。 */
  corePolicy?: Partial<CorePolicy>
  /** 可选的宿主能力：列举过滤、证据包、日志、子进程、遥测、代码智能。 */
  providers?: ProjectProviders
  /** 额外插件，按顺序装在内置核心插件之后；同名的只装一次，任一个 setup 抛错，建内核就失败。 */
  plugins?: ProjectPlugin[]
  /**
   * 是否装内置核心插件（文本、JSON、Markdown、通用代码、JS/TS 的适配器与对应的补丁策略，范围与后置条件校验器）；缺省装。
   * 不装时适配器和补丁策略全靠 plugins 提供，否则编辑一律报 NOT_SUPPORTED。
   */
  includeBuiltinPlugins?: boolean
  /** 宿主持有写端；内核每次事务状态变化写一条，编辑器等消费者只能从 kernel.changeFeed 读取。不给就用内存版，进程退出即丢。 */
  changeFeed?: ProjectChangeFeedWriter
  /**
   * 宿主私有、项目根绑定的可恢复事务状态文件，放在宿主私有目录，不要放进项目树。给了，提交与撤销写盘前先把计划落进它，
   * 进程中途退出后下次建内核时恢复；不给就只在进程内保证多文件要么全写、要么全还原。
   */
  transactionStatePath?: string
}

// ── 工具的调用上下文与空间端口 ──────────────────────────────────

/**
 * 空间端口：`velaros:project` 与 `velaros:code` 在运行时向空间要什么，写作 `ctx.project`。空间每次分发调用时给一份，绑定当前项目根与会话。
 * 端口里只有工具真会调的方法，门禁从两个操作类出发核对。
 */
export interface ProjectSpacePort {
  /** 当前项目根的绝对路径：工具以它为基准解析相对路径、给项目资源门排队、核对回执属于哪个工作区。 */
  getRootPath: () => string
  /** 取当前项目根上的内核（Agent 视图）。每次调用都会取，宿主应当按项目根缓存同一个内核，不要每次新建。 */
  kernel: () => Promise<AgentProjectKernelPort>
  /**
   * 代码查询端口：`velaros:code` 的两个操作翻译成 `ProjectCodeQuery` 交过来，本单元自己不带实现
   * （语言服务那一半可以用 `@velaros-ai/velaros/project` 的 `createProjectCodeQuery`，代码图谱那一半由宿主的图后端提供）。
   * 语言服务类动作（`ProjectCodeLanguageActions` 里的七个）抛错时这次查询失败；代码图谱类动作没有后端时，抛 code 为 UNAVAILABLE
   * （或 reason 为 NOT_SUPPORTED）的错误：`query` 把它当降级写进回执，`analyze` 直接失败。
   * 返回普通对象，其中的 source、revision、truncated、degraded、note 会被装进回执。
   */
  queryCode: (input: ProjectCodeQuery, context: ProjectOperationContext) => Promise<unknown>
}

/**
 * 每次调用 `velaros:project`、`velaros:code` 时空间给的上下文。它不是模型能填的入参：空间分发这次调用时装好，生成声明时整个丢掉。
 */
export interface ProjectOperationContext {
  /** 本次调用的取消信号：用户取消或上层超时时触发；工具在排队与每一步之间核对，宿主的查询也应随之停下。 */
  abortSignal: AbortSignal
  /** 空间端口：项目根、内核与代码查询都经它要。 */
  project: ProjectSpacePort
  /** 本次调用所属会话：fileRef、续读页与改动引用按会话签发与核对。 */
  sessionId?: string
}

/** 项目命令端口只需要工作区根与宿主命令能力，不要求文件或代码查询能力。 */
export interface ProjectShellHostPort extends ShellHostPort {
  /** 当前宿主授权的项目根；命令分发按真实路径检查该范围。 */
  getRootPath(): string
}

/**
 * 宿主端口：项目给三件共用能力（`velaros:shell`、`velaros:sandbox`、`velaros:images`）装端口时向宿主要的东西。宿主每次分发调用时给一份，绑定当前项目根与会话。
 * 项目根与内核来自空间端口 `ProjectSpacePort`；跑命令、管后台任务的四件来自 `velaros:shell` 的 `ShellHostPort`
 * （本机实现是 `@velaros-ai/velaros/shell/local` 的本机宿主，项目端口会把工作目录钳在项目内、前台命令排进项目资源门再交给它）；
 * 演练沙箱与缩图可选。
 */
export interface ProjectHostPort extends ProjectSpacePort, ProjectShellHostPort {
  /** 演练沙箱（本机实现是 `@velaros-ai/velaros/sandbox/local`）；没接的宿主，项目里的 `velaros:sandbox` 每个操作都明说做不了。 */
  sandbox?: RehearsalSandboxHostPort
  /** 裁图缩图（可选）：`velaros:images` 看超过上限的图、只看一块区域时用。宿主没有图像处理能力就不给，view 遇到这种图会明说做不了。 */
  resizeImage?: (request: ImageResizeRequest) => Promise<ImageResizeResult>
}

/** 项目证据源只复用当前项目内核，不获得模型或任意文件系统端口。 */
export interface ProjectContextSourceOptions {
  /** 宿主登记的证据源 ID。 */
  readonly id: string
  /** 已限定工作空间的真实项目内核。 */
  readonly kernel: AgentProjectKernelPort
  /** 可选的单会话发布范围。 */
  readonly sessionId?: string
}

/**
 * 注入面：宿主必须或可以塞进来的东西。
 * 本包不认宿主，只认这三个口子：一次语言查询的上下文、它借的只读内核端口，以及可选的代码图谱后端。
 */

/**
 * 语言查询借的只读内核端口：列文件、读正文、列符号，三件事而已。
 *
 * 写成这个别名是要写死「语言查询不消耗项目的修改、执行与审批能力」——宿主给的内核就算带着写入口，
 * 本包也够不着。谁给：宿主在 `LanguageToolContext.project.kernel()` 里给；每次查询都要。
 */
export type LanguageReadPort = Pick<AgentProjectKernelPort, 'listFiles' | 'read' | 'listSymbols'>

/**
 * 一次语言查询的上下文。谁给：宿主（Desktop / Workbench / Termel）在每次查询时给；必须。
 *
 * 路径一律相对项目根，没有「按目录执行」这回事：语言查询不改变任何进程状态。
 */
export interface LanguageToolContext {
  /** 中止信号；本包在每次列目录、读文件与逐文件诊断之间检查它。 */
  abortSignal: AbortSignal
  /** 项目面：项目根与只读内核。 */
  project: {
    /** 项目根的绝对路径。 */
    getRootPath(): string
    /** 取只读内核端口；每次查询取一次，宿主可以在这里做懒装配。 */
    kernel(): Promise<LanguageReadPort>
  }
}

/**
 * 宿主的代码图谱后端。谁给：宿主在 `createProjectCodeQuery` 建查询时给；可选——
 * 给一个永远不可用的空实现也合法（Termel 就是），此时代码图谱类动作抛 `UNAVAILABLE`，
 * 内置的七个语言动作照常可用。
 */
export interface ProjectCodeIndexApi {
  /** 图谱后端现在能不能用；为假时本包不调 `query`，直接抛 `UNAVAILABLE`。 */
  isAvailable(): boolean
  /** 执行一次代码图谱查询；返回值原样交给调用方，本包只给它加上 `source` 字段。 */
  query(input: ProjectCodeIndexQuery, context: ProjectOperationContext): Promise<unknown>
}
