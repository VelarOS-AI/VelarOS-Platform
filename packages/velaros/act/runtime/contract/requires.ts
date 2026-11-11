import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'

import type {
  ActContextPolicy,
  ActRunEvent,
  ActRunLimits,
  AgentJob,
  AgentStart,
} from '@velaros-ai/agent'
import type { ContextSourcePort, ContextStorage, ContextViewLimits } from '@velaros-ai/context'
import type {
  ModuleBinding,
  OperationContext,
  OperationDefinition,
  OperationDescriptor,
  OperationModuleDefinition,
  OperationSurface,
  PreparedInvocation,
} from '@velaros-ai/kernel'
import type { ModelAdapterConfig, ModelDriver, ModelDriverLimits } from '@velaros-ai/model'
import type { CodeProgramRequest, CodeRunnerApi, NodeCodeRunnerOptions } from '@velaros-ai/script'
import type { WidgetHost } from '@velaros-ai/velaros/act/agents'
import type { VelarosSearchOptions } from '@velaros-ai/velaros/act/search'
import type { StoreConfiguration } from '@velaros-ai/velaros/act/system'
import type { LocalShellHostOptions, ShellHostPort } from '@velaros-ai/velaros/execution'
import type { MemoryScopePort } from '@velaros-ai/velaros/memory'

import type { McpClientConnectionApi } from '../impl/McpClientConnection.js'
import type { VelarosSession } from '../impl/RuntimeSession.js'
import type { McpToolDescriptor, McpTransportKind } from '../types/mcp.js'
import type { ContextMemoryPolicy, RuntimeCompletedTask } from '../types/memory.js'
import type { ModelToolPolicy } from '../types/model-tools.js'
import type { ContextMaintenanceProfile } from '../types/model-tools.js'
import type { ScriptProtocolOptions } from '../types/runtime.js'
import type { RuntimeMetric } from '../types/trace.js'

/** 从领域方法的最后一个参数推导宿主上下文，使装配参数在编译期受原接口约束。 */
export type CapabilityContext<T extends object> = {
  [K in keyof T]: T[K] extends (...args: infer P) => unknown
    ? P extends [...infer _Args, infer C]
      ? C
      : never
    : never
}[keyof T]

/** 将已有领域操作接到统一 Kernel；模型合同由同一份领域接口生成。 */
export interface CapabilityModuleOptions<T extends object> {
  /** 领域随包发布的声明、schema、效果及示例。 */
  readonly surface: OperationSurface
  /** 已有领域操作实例，方法不重新实现。 */
  readonly implementation: T
  /** 宿主选择的稳定资源身份。 */
  readonly instanceId: string
  /** 资源重新绑定后的代际，默认 1。 */
  readonly generation?: number
  /** 发现卡片摘要，默认模块身份。 */
  readonly summary?: string
  /** 给每次真实调用注入领域上下文，可使用回执记录口。 */
  context(operation: OperationContext): CapabilityContext<T> | Promise<CapabilityContext<T>>
  /** 领域提供可验证的只读核对能力；省略时未知效果保持未决。 */
  readonly reconcile?: Readonly<Partial<Record<keyof T, OperationDefinition['reconcile']>>>
  /** 某些能力在观察模式下的受限实现，例如使用受限进程的命令执行。 */
  readonly observation?: Readonly<Partial<Record<keyof T, OperationDefinition['run']>>>
  /**
   * 认出发生在任何写入之前的失败（入参不对、版本冲突、没有授权），回执记成没有效果。带 `effect: 'none'` 或
   * `executionOutcome: 'not-applied'` 标记的错误不用在这里认，公共入口已经认了；两样都不认的写操作失败是效果未知。
   */
  withoutEffect?(error: unknown): boolean
  /** 挂载资源的激活。 */
  activate?(): void | Promise<void>
  /** 挂载资源的释放。 */
  dispose?(): void | Promise<void>
}

/** 宿主只选择实例资源，公共机制由 Velaros 统一装配。 */
/** 任务事实与只读证据源的配置，宿主装配领域只读源。 */
export interface VelarosContextOptions {
  /** 领域拥有的纯快照目录；逐轮真实捕获，只复用相同完整值的固定派生。宿主显式装配。 */
  readonly snapshots?: readonly SnapshotObservationProvider[]
  /** 仅对宿主预登记、完整覆盖依赖的观察启用可靠代次复用；省略时每个业务轮实际采集。 */
  readonly observation?: ObservationReuseOptions
  /** 独立整理工具；默认复用业务模型驱动，false 时仅使用确定性引用降级。 */
  readonly maintenance?: false | ContextMaintenanceOptions
  /** 五分区工作内存的正文配额和近期记录窗口。 */
  readonly memory?: ContextMemoryPolicy
  /** 主运行时视图的预警与恢复配置。 */
  readonly policy?: ActContextPolicy
  /** 各领域负责实际读取与空间边界。 */
  readonly sources?: readonly ContextSourcePort[]
  /** 共享任务预算与证据上限。 */
  readonly limits?: Partial<ContextViewLimits>
}

/** 领域只登记固定纯计划及捕获操作；实际读取仍由授权 Kernel 派发。 */
export interface SnapshotObservationProvider {
  /** 领域目录的稳定提供者名称。 */
  readonly id: string
  /** 真实捕获所属的授权 Kernel 模块。 */
  readonly moduleId: string
  /** 领域固定的完整捕获操作。 */
  readonly operation: string
  /** 纯计划与派生代码的内容代次。 */
  readonly revision: string
  /** 当前提供者公开的固定计划名；输入从对应领域操作的生成合同发现。 */
  readonly plans: readonly string[]
  /** 领域保证只依赖 {plan,capture} 当前值的固定确定性纯程序；不能通过计划注入源码，派生不能调用 Kernel。 */
  readonly source: string
  /** 完整核对领域输入，返回可持久化的计划参数。 */
  prepare(plan: string, input: unknown): unknown
}

/** 程序目录归档共用正式检查器与当前授权挂载，不运行程序。 */
export interface ProgramCatalogValidator {
  /** 使用当前声明检查源码，并返回实际可达 import 的授权挂载。 */
  validate(program: CodeProgramRequest, signal: AbortSignal): Promise<readonly ModuleBinding[]>
  /** 当前授权与发布时挂载完全一致可沿用已通过的语法/import 事实；变化则重新检查正文。 */
  unchanged(dependencies: readonly ModuleBinding[], signal: AbortSignal): Promise<boolean>
}

/** 观察复用只决定是否采集，不授予读取、写入或完成权限。 */
export interface ObservationReusePort {
  /** 明确覆盖已登记程序的原生文件、网络、进程与环境依赖；省略时 Node 每轮重新采集。 */
  readonly coversNativeIO?: boolean
  /**
   * 仅给预登记并核对全部有效依赖的指纹返回 versioned；其他程序返回 unknown。
   * providerId 绑定提供者本次生命周期，token 是可识别 ABA 变化的可靠代次。
   * 方法只读且必须响应取消；失败或超时转为真实采集，迟到结果不建立基线。
   */
  probe(
    input: {
      readonly sessionId: string
      readonly sourceHash: string
      readonly inputHash: string
      readonly scopeFingerprint: string
    },
    signal: AbortSignal
  ): Promise<
    | { readonly kind: 'versioned'; readonly providerId: string; readonly token: string }
    | { readonly kind: 'unknown'; readonly reason: string }
  >
}

/** 宿主保证覆盖权限、可见范围、模块绑定及观察的全部数据依赖。 */
export interface ObservationReuseOptions {
  /** 宿主已核查完整程序覆盖范围的可靠版本端口。 */
  readonly reuse: ObservationReusePort
  /**
   * 返回权限与可见范围的可靠代次；未知返回 undefined。Runtime 再绑定当前任务、
   * 授权重置水位、允许模块及实例代际。范围变更必须推进，不能用路径或静态角色名代替。
   */
  scope(sessionId: string, signal: AbortSignal): Promise<Optional<string>>
  /** 单次范围与代次联合探测上限，缺省 250ms，最大 30000ms。 */
  readonly probeTimeoutMs?: number
  /** 最长复用年龄；省略时仅依赖可靠代次，年龄不证明内容未变化。 */
  readonly maxAgeMs?: number
}

/** 上下文模型工具的宿主配置，任务数据仍来自已有存储。 */
export interface ContextMaintenanceOptions {
  /** 独立模型选择；省略时使用调用会话的模型驱动。 */
  readonly model?: ModelDriver
  /** 原生工具模型默认用 data，只接收 list/read/submit 数据，不启动脚本进程；script 保留已有受限 ScriptAct 路径。 */
  readonly execution?: 'data' | 'script'
  /** 可覆盖充分但有限的默认资源档位。 */
  readonly profile?: Partial<ContextMaintenanceProfile>
}

/** 正式 Runtime 的单一装配入口。 */
export interface VelarosRuntimeOptions {
  /** 用户选择的执行深度；省略为 medium，独立于供应商推理参数回退，业务子任务继承。 */
  readonly executionDepth?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** 宿主可信的主会话产品指令；追加到运行协议说明，参与真实请求预算，不传给专项模型工具。 */
  readonly instructions?: string
  /**
   * 常驻合同：{module} 提供完整声明；{module, exports} 选择导出及其依赖类型，
   * 均由正式声明生成，模型可直接 import 使用。示例经 modules.describe 按需读取，
   * template: true 显式常驻整模块示例；同模块的重复配置合并，任一项显式启用即附带一次。
   * 仅限主会话已授权模块。
   * 随会话配置固定，全部计入模型请求预算；选择任务常用的操作以减少发现往返。
   */
  readonly residentModules?: ReadonlyArray<{
    readonly module: string
    readonly exports?: readonly string[]
    readonly template?: boolean
  }>
  /**
   * 宿主环境条目（如操作系统），每帧和运行时读的当地时间、时区一起放进 runtime.environment；
   * 在帧尾，不影响前缀缓存。读取失败的那一帧只给时间。
   */
  readonly environment?: () => Readonly<Record<string, string>>
  /** 恢复时固定的执行身份和授权范围；由宿主从已授权资源派生，不能取模型输入。 */
  readonly binding: RuntimeSessionBinding
  /** 成功创建后移交的资源；等待会话及能力完全收束后关闭，初始化失败仍归调用者。 */
  readonly resources?: readonly RuntimeResource[]
  /** 固定主会话存储边界、创建权限和已授予空间；返回 undefined 关闭。 */
  stores?(sessionId: string): Optional<StoreConfiguration>
  /** 为每个主会话固定长期记忆作用域；复用 createMemoryStore().scope()，搜索、整理和子任务不继承。 */
  readonly memory?: (sessionId: string) => MemoryScopePort
  /** 主线、搜索和业务支线共享的树形调度上限。 */
  readonly modelTools?: ModelToolPolicy
  /** 同一 Act 工厂上的通用子任务；仅显式配置时挂载。 */
  readonly agents?: VelarosAgentsOptions
  /** 宿主能在对话里显示小部件时给：模型用 velaros:widget 的 show 交来 HTML 或 SVG，宿主负责显示；不给就不挂这个模块。 */
  readonly widgets?: WidgetHost
  /** 每次派发前的宿主权限检查，拒绝时尚未执行。 */
  authorize?(
    invocation: PreparedInvocation,
    descriptor: OperationDescriptor,
    signal: AbortSignal
  ): Promise<void>
  /** 宿主证明写操作完整的冲突资源集合，使用规范化身份覆盖读写依赖及别名；省略返回值时与全部写操作互斥。仅优化实例内调度，不授予权限或跨进程锁。 */
  effectResources?(invocation: PreparedInvocation): readonly string[] | undefined
  /** 接收无正文的阶段计量；回调应快速返回，异常与异步拒绝不改变业务结果。宿主决定保留和聚合，不向模型授予能力。 */
  onMetric?(metric: RuntimeMetric): void | Promise<void>
  /** 有界高级搜索的模型与预算；仅显式配置时挂载。 */
  readonly search?: VelarosSearchOptions
  /** 本运行时固定的文本协议配置，与主循环共用同一解析器。 */
  readonly protocol?: ScriptProtocolOptions
  /** 每帧按会话读取宿主参数；解析器立即冻结数据快照。 */
  inputs?(sessionId: string): Readonly<Record<string, unknown>>
  /** 任务事实与领域适配器；省略时使用用户目标、脚本观察和执行材料。 */
  readonly context?: VelarosContextOptions
  /** 数据库无关的 ContextStorage；由宿主显式建立。创建成功后 Runtime 持有并关闭此连接，多个实例使用各自的连接或池租约；初始化失败时注入连接仍由调用方持有。 */
  readonly storage: ContextStorage
  /** 显式注入隔离执行器。 */
  readonly runner?: CodeRunnerApi
  /** Node 执行环境；内部观察和维护复用该环境的只读进程口。 */
  readonly node?: RuntimeNodeOptions
  /** agent 的持久 npm 环境；宿主显式建立；省略时不提供包管理。 */
  readonly packageEnvironment?: EnvironmentRegistryApi
  /** 宿主挂载的领域模块；标准模块由运行时提供。 */
  readonly modules?: readonly OperationModuleDefinition[]
  /** 宿主对已挂载模块的会话可见性；发现与派发使用同一检查，不会扩大实际装配。 */
  moduleAccess?(sessionId: string, moduleId: string): boolean
  /** 使用共享驱动接入模型；纯脚本宿主可以不给。 */
  readonly model?: ModelDriver
  /** 覆盖明确的回合和上下文预算。 */
  readonly limits?: Partial<ActRunLimits>
}

/**
 * 标准代码进程与可选的同策略 npm 进程入口。
 * Runtime 也会在模型请求前短暂调用 acquireRuntime 读取环境索引，读取完成即释放；此调用不代表启动了代码进程。
 */
export interface RuntimeNodeOptions extends NodeCodeRunnerOptions {
  /** 与 Node 共用宿主策略的 npm 客户端；由 createNodeExecutionEnvironment 提供。 */
  readonly npm?: NpmClientApi
}

/** 通过 execution 宿主启动标准 Node 业务进程。 */
export interface NodeExecutionEnvironmentOptions {
  /** 随宿主分发的 npm-cli.js；省略时按 Node 安装与 PATH 发现。 */
  readonly npmCli?: string
  /** npm 私有缓存；省略时使用 directory/npm-cache。 */
  readonly npmCacheDirectory?: string
  /** 标准进程的绝对工作目录。 */
  readonly cwd: string
  /** 执行日志与能力目录的宿主存储位置。 */
  readonly directory: string
  /** 默认 npm 环境的绝对根目录；发行宿主提供可由独立 Node 读取的实际文件。 */
  readonly packageDirectory?: string
  /** 会话固定的标准依赖与 Skill 发现目录。 */
  readonly runtime?: NodeCodeRunnerOptions['runtime']
  /** 沿用当前工作区授权与约束的命令宿主。 */
  readonly host: ShellHostPort
  /** 真实 Node 可执行文件；Electron 宿主提供随产品分发的独立 Node 路径。 */
  readonly executable?: string
  /** 本次原生进程的宿主环境覆盖。 */
  readonly environment?: Readonly<Record<string, string | undefined>>
  /** 在启动前审批本次源码，拒绝时不派发。 */
  readonly authorize?: NodeCodeRunnerOptions['authorize']
  /** 宿主脚本卡使用本次执行身份显示实时输出。 */
  readonly output?: (output: NodeExecutionOutput) => void
}

/** Node 执行时交给宿主界面的一段输出。 */
export interface NodeExecutionOutput {
  /** 调用所属会话。 */
  readonly sessionId: string
  /** 调用所在的那段执行，与回合追踪里的 `executionId` 相同。 */
  readonly executionId: string
  /** 这次调用，与回合追踪里调用的 `id` 相同。 */
  readonly invocationId: string
  /** 新吐出的一段，stdout、stderr 按到达顺序。 */
  readonly text: string
  /** 不支持流区分的旧宿主可以省略。 */
  readonly stream?: 'stdout' | 'stderr' | 'combined'
}

/** 宿主持有 OAuth 凭据与交互。 */
export interface McpAuthorizationProvider extends OAuthClientProvider {
  /** 等待用户打开的授权地址。 */
  readonly authorizationUrl?: LooseOptional<URL>
}

/** host 无关的 MCP 连接规格；enabled/autoApprove/retry 等宿主策略不在此层。 */
export interface McpConnectionSpec {
  /** 缺省保持历史行为：stdio。auto 按 Streamable HTTP -> SSE 回退。 */
  transport?: McpTransportKind
  /** 本地服务器可执行文件。 */
  command: string
  /** 本地服务器参数。 */
  args: readonly string[]
  /** 宿主允许传给子进程的环境。 */
  env: Readonly<Record<string, string>>
  /** 本地工作目录。 */
  cwd: Nullable<string>
  /** 远程服务器地址。 */
  url?: LooseOptional<string>
  /** 宿主提供的 HTTP 请求头。 */
  headers?: Readonly<Record<string, string>>
  /** 宿主持有的 OAuth 提供方。 */
  authProvider?: McpAuthorizationProvider
  /** 对端可见的客户端身份。 */
  client?: {
    /** 客户端名称。 */
    readonly name: string
    /** 客户端版本。 */
    readonly version: string
  }
}

/** MCP 连接的宿主生命周期配置。 */
export interface McpConnectionOptions {
  /** 建立连接超时。 */
  readonly connectTimeoutMs?: number
  /** 单次请求超时。 */
  readonly callTimeoutMs?: number
  /** 对端关闭时通知宿主撤回代际。 */
  onClose?(): void
}

/**
 * 子任务配置由宿主命名，模型不选时用第一个。子任务能用配置里的模块（不能超过父任务），
 * 写入与共享空间跟父任务一样，不用另外授权。
 */
export interface AgentProfile {
  /** 宿主给该类子任务的通用指令；与派发任务分开，不自动继承主任务的角色或执行模式。 */
  readonly instructions?: string
  /** 显式继承父任务的标准 Node 操作系统范围；能力目录仍受 modules 白名单约束。 */
  readonly node?: boolean
  /** 给主模型选择配置时看的任务用途。 */
  readonly description?: string
  /** 子任务模型总额度；仍受全部祖先的剩余总额约束。 */
  readonly budget?: false | Partial<Pick<ContextViewLimits, 'modelCalls' | 'modelTokens'>>
  /** 真实模型驱动，使用同一编译和计费路径。 */
  readonly model: ModelDriver
  /** 精确模块白名单，续跑时重新检查。 */
  readonly modules: readonly string[]
  /** 子任务的分区配额和近期窗口。 */
  readonly memory?: ContextMemoryPolicy
  /** 单次运行上限。 */
  readonly limits?: Partial<ActRunLimits>
}

/** 宿主为单个子会话装配的上下文与资源；业务身份由宿主自行解析。 */
export interface AgentSessionContext {
  /** 替换配置档案中的通用说明，仅作用于当前子会话。 */
  readonly instructions?: string
  /** 当前子会话的独立 Node 工作环境。 */
  readonly node?: RuntimeNodeOptions
  /** 当前子会话每帧的资源环境信息。 */
  readonly environment?: () => Readonly<Record<string, string>>
  /** 子会话关闭或建立失败后释放本次返回的资源。 */
  close?(): Promise<void>
}

/** 子任务调度的宿主配置。 */
export interface VelarosAgentsOptions {
  /** 在子会话运行前解析当前档案，装配独立上下文；准备失败由宿主释放尚未返回的资源。 */
  prepareSession?(
    job: Readonly<AgentJob>,
    input: Optional<AgentStart>,
    signal: AbortSignal
  ): Promise<AgentSessionContext>
  /** 子任务有序实时事件，只用于宿主展示；回调异常记录日志，不改变执行或持久事实。 */
  onEvent?(job: Readonly<AgentJob>, event: ActRunEvent): void
  /** 可选配置及其能力范围。 */
  readonly profiles: Readonly<Record<string, AgentProfile>>
  /** 同时活动的业务子任务数；模型请求另受 modelTools.concurrency 约束。 */
  readonly concurrency: number
  /** 一个父任务生命周期内的子会话上限。 */
  readonly maxChildren: number
}

/** MCP 协议与 Kernel 能力的装配配置。 */
export interface McpModuleOptions {
  /** 模块绑定身份及代际。 */
  readonly binding: ModuleBinding
  /** 持有实际连接的宿主对象。 */
  readonly connection: McpClientConnectionApi
  /** 已列举的固定 schema 快照，目录变化时宿主换代。 */
  readonly tools: readonly McpToolDescriptor[]
  /** 宿主审核确认只读的工具，不能只相信远端 annotation。 */
  readonly readOnly?: readonly string[]
  /** 写入前的人工或宿主政策授权；未提供时默认拒绝写入。 */
  authorize?(call: OperationContext, tool: McpToolDescriptor): Promise<void>
}

/** 声明式 Provider 配置；凭据只用于建立驱动，不进入模型材料和追踪。 */
export interface RuntimeModelConfiguration extends Pick<
  ModelAdapterConfig,
  'provider' | 'apiKey' | 'baseURL' | 'reasoningLevel' | 'openaiExplicitCacheBreakpoints'
> {
  /** 供应商接受的模型标识。 */
  readonly model: string
  /** 当前宿主采用的运行窗口预算，可按供应商实际容量覆盖。 */
  readonly limits?: Partial<ModelDriverLimits>
}

/** 有序事件交付的宿主端口；persist 必须按调用顺序分配持久身份并在真正写入后完成。 */
export interface EventDeliveryOptions<Value, Receipt> {
  /** 持久保存冻结的事件并返回交付回执；可并发等待以合批写入，失败应拒绝。 */
  persist(value: Value): Promise<Receipt>
  /** 将已持久化回执交给传输层；严格按 append 顺序调用，拒绝会封闭后续交付。 */
  deliver(receipt: Receipt): void | Promise<void>
}
import type { EnvironmentRegistryApi } from '@velaros-ai/velaros/act/system'
import type { NpmClientApi } from '@velaros-ai/velaros/execution'

/** 完成任务的后台记忆整理；材料与记忆作用域沿用宿主现有端口。 */
export interface MemoryConsolidationOptions {
  /** 复用宿主解析的模型驱动。 */
  readonly model: ModelDriver
  /** 已完成任务的固定归档范围。 */
  readonly task: RuntimeCompletedTask
  /** 原会话的只读材料端口。 */
  readonly source: Pick<VelarosSession, 'taskMaterials' | 'readTaskMaterial'>
  /** 当前作用域已有记忆。 */
  readonly memory: MemoryScopePort
  /** 宿主退出或取消信号。 */
  readonly signal: AbortSignal
}

/** 与产品导航无关的会话执行边界；模块实例及代际另由真实装配派生。 */
export interface RuntimeSessionBinding {
  /** 已解析的执行主体、环境或远端节点身份；改变主体必须创建新会话。 */
  readonly executionIdentity: string
  /** 已核验的授权范围及策略代际；不能用展示路径代替权限证明。 */
  readonly authorizationScope: string
}

/** 移交给 Runtime 的单一生命周期资源。 */
export interface RuntimeResource {
  /** 仅在执行及能力完全收束后调用；允许幂等关闭。 */
  close(): void | Promise<void>
}

/** 仅操作已有会话的笔记、目标与只读追踪；成功后由控制 lease 持有本次存储连接。 */
export interface SessionControlOptions {
  /** 已经通过产品权限检查的主会话身份。 */
  readonly sessionId: string
  /** 独立连接或池租约，不能让关闭控制 lease 影响仍在执行的 Runtime。 */
  readonly storage: ContextStorage
  /** 与原始 Runtime 相同的已解析身份和授权范围。 */
  readonly binding: RuntimeSessionBinding
}

/** Node 执行身份的无执行资源解析；结果可用于已有会话的控制 lease。 */
export interface NodeRuntimeBindingOptions {
  /** 与原 Node 装配相同的真实执行目录。 */
  readonly cwd: string
  /** 宿主核验的不透明主体和授权范围。 */
  readonly binding: RuntimeSessionBinding
  /** 与原装配相同的 Node 可执行文件；省略时按标准发现。 */
  readonly executable?: string
  /** 自持本机 Host 的原策略；借用外部 Host 时由 binding.authorizationScope 表达其策略。 */
  readonly processConfinement?: LocalShellHostOptions['processConfinement']
}

/** 普通 Node 环境装配；不根据路径或模型推导领域能力。 */
export interface NodeRuntimeOptions extends Omit<
  VelarosRuntimeOptions,
  'storage' | 'runner' | 'node' | 'model'
> {
  /** 真实 Node 进程的绝对工作目录，不代表产品项目。 */
  readonly cwd: string
  /** 运行事实和进程档案的绝对目录，必须位于执行目录之外。 */
  readonly stateDirectory: string
  /** 显式持有的本机或远端执行口；生命周期仍归产品。 */
  readonly host?: ShellHostPort
  /** 由此装配器持有的本机 Host 配置；与 host 互斥，必须明确 processConfinement。 */
  readonly localHost?: Omit<LocalShellHostOptions, 'cwd'>
  /** 覆盖默认 SQLite；成功创建后由 Runtime 关闭，失败仍归调用方。 */
  readonly storage?: ContextStorage
  /** Node 可执行文件、依赖环境和审批；不能改变 cwd、日志目录或另造 Host。 */
  readonly execution?: Omit<NodeExecutionEnvironmentOptions, 'cwd' | 'directory' | 'host'>
  /** 已解析模型或明确的 Provider 配置。 */
  readonly model?: ModelDriver | RuntimeModelConfiguration
}
