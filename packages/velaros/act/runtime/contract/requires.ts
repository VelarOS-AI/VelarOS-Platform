import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'

import type { ActContextPolicy, ActRunLimits } from '@velaros-ai/agent'
import type {
  ContextCompletionPort,
  ContextSourcePort,
  ContextStorage,
  ContextViewLimits,
} from '@velaros-ai/context'
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
import type { ImageSpacePort } from '@velaros-ai/velaros/images'
import type { MemoryScopePort } from '@velaros-ai/velaros/memory'
import type { ProjectCodeIndexApi, ProjectSpacePort } from '@velaros-ai/velaros/project'
import type {
  ShellHostPort,
  ShellOperationContext,
  ShellSpacePort,
} from '@velaros-ai/velaros/shell'

import type { McpClientConnectionApi } from '../impl/McpClientConnection.js'
import type { McpToolDescriptor, McpTransportKind } from '../types/mcp.js'
import type { ContextMemoryPolicy } from '../types/memory.js'
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

/** 项目文件操作的标准装配；读取版本与写事务共享原项目内核。 */
export interface ProjectCapabilityModuleOptions {
  /** 当前项目实例身份。 */
  readonly instanceId: string
  /** 实例重建时推进的代次。 */
  readonly generation?: number
  /** 宿主已限制范围的项目端口。 */
  readonly project: ProjectSpacePort
}

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
  /** 领域拥有的纯快照目录；逐轮真实捕获，只复用相同完整值的固定派生。工作区默认装配 Project files。 */
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
  /** 领域完成验证；省略时明确标为未验证。 */
  readonly completion?: ContextCompletionPort
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
  /** 可覆盖充分但有限的默认资源档位。 */
  readonly profile?: Partial<ContextMaintenanceProfile>
}

/** 项目上的看图模块：项目端口之外，可选宿主的裁图缩图（macOS 上是系统自带的 sips）。 */
export interface ProjectImagesModuleOptions extends ProjectCapabilityModuleOptions {
  /** 看超过上限的图、只看一块区域时用；不给时 view 遇到这种图会明说做不了。 */
  readonly resizeImage?: ImageSpacePort['resizeImage']
}

/** 工作区项目上另挂的能力：都用运行时自己的那个项目内核，钳在项目根里。 */
export interface VelarosProjectOptions {
  /**
   * 挂 velaros:code：内置的 JS/TS、Python 语言服务答大纲、定义、引用、诊断与波及面；
   * 给了代码图谱后端时调用关系与四类分析也能答，不给时它们报 UNAVAILABLE。
   */
  readonly code?: boolean | ProjectCodeIndexApi
  /** 挂 velaros:images：只看项目里的图；macOS 上超限的图与区域裁图用系统自带的 sips 缩。 */
  readonly images?: boolean
}

/** 正式 Runtime 的单一装配入口。 */
export interface VelarosRuntimeOptions {
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
  /** 常规本地工作区；框架装配已有 Project 内核与只读证据来源。 */
  readonly workspace?: string
  /**
   * 是否挂载工作区的默认 Project 与证据来源；false 保留工作区绑定但关闭这两项能力。
   * 给对象时照样挂这两项，另按项挂上同一个项目内核上的能力（见 VelarosProjectOptions）。
   */
  readonly project?: boolean | VelarosProjectOptions
  /** 框架状态目录，放在业务工作区之外；未注入 storage 时必填。 */
  readonly dataDir?: string
  /** 固定主会话存储边界、创建权限和已授予空间；返回 undefined 关闭。 */
  stores?(sessionId: string): Optional<StoreConfiguration>
  /** 为每个主会话固定长期记忆作用域；复用 createMemoryStore().scope()，搜索、整理和子任务不继承。 */
  readonly memory?: false | ((sessionId: string) => MemoryScopePort)
  /** 主线、搜索和业务支线共享的树形调度上限。 */
  readonly modelTools?: ModelToolPolicy
  /** 同一 Act 工厂上的通用子任务；工作区预设默认提供 worker，false 可关闭。 */
  readonly agents?: boolean | VelarosAgentsOptions
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
  /** 有界高级搜索的模型与预算；工作区预设默认开启，false 可关闭。 */
  readonly search?: boolean | VelarosSearchOptions
  /** 本运行时固定的文本协议配置，与主循环共用同一解析器。 */
  readonly protocol?: ScriptProtocolOptions
  /** 每帧按会话读取宿主参数；解析器立即冻结数据快照。 */
  inputs?(sessionId: string): Readonly<Record<string, unknown>>
  /** 任务事实与领域适配器；省略时使用用户目标、脚本观察和执行材料。 */
  readonly context?: VelarosContextOptions
  /** 数据库无关的 ContextStorage；省略时由 dataDir 创建 SQLite。创建成功后 Runtime 持有并关闭此连接，多个实例使用各自的连接或池租约；初始化失败时注入连接仍由调用方持有。 */
  readonly storage?: ContextStorage
  /** 显式注入隔离执行器。 */
  readonly runner?: CodeRunnerApi
  /** Shell 与 Node 执行环境；内部观察和维护复用该环境的只读进程口。 */
  readonly node?: NodeCodeRunnerOptions
  /** 宿主挂载的领域模块；标准模块由运行时提供。 */
  readonly modules?: readonly OperationModuleDefinition[]
  /** 使用共享驱动接入模型；纯脚本宿主可以不给。 */
  readonly model?: ModelDriver | RuntimeModelConfiguration
  /** 覆盖明确的回合和上下文预算。 */
  readonly limits?: Partial<ActRunLimits>
}

/** 通过已授权的 Shell 宿主启动标准 Node 业务进程。 */
export interface ShellNodeEnvironmentOptions {
  /** 标准进程的绝对工作目录。 */
  readonly cwd: string
  /** 执行日志与能力目录的宿主存储位置。 */
  readonly directory: string
  /** 沿用当前工作区授权与约束的命令宿主。 */
  readonly shell: ShellHostPort
  /** 真实 Node 可执行文件；Electron 宿主提供随产品分发的独立 Node 路径。 */
  readonly executable?: string
  /** 本次原生进程的宿主环境覆盖。 */
  readonly environment?: Readonly<Record<string, string | undefined>>
  /** 在启动前审批本次源码，拒绝时不派发。 */
  readonly authorize?: NodeCodeRunnerOptions['authorize']
  /** 宿主脚本卡使用本次执行身份显示实时输出。 */
  readonly output?: (output: ShellInvocationOutput) => void
}

/** 在同一 Kernel 注册 Shell 的正常执行及受限观察实现。 */
export interface ShellCapabilityModuleOptions {
  /** 宿主资源身份。 */
  readonly instanceId: string
  /** 同一空间的命令能力，观察时必须实现 runObservationCommand。 */
  readonly shell: ShellSpacePort
  /** 一次性危险操作仍使用现有审批端口。 */
  readonly approval: ShellOperationContext['approval']
  /** 宿主要在界面上显示命令跑着时的输出就给：前台命令每吐出一段回调一次，带上是哪段执行的哪次调用。 */
  readonly output?: (output: ShellInvocationOutput) => void
}

/** 一次 `velaros:shell` 调用跑着时吐出的一段输出。 */
export interface ShellInvocationOutput {
  /** 调用所属会话。 */
  readonly sessionId: string
  /** 调用所在的那段执行，与回合追踪里的 `executionId` 相同。 */
  readonly executionId: string
  /** 这次调用，与回合追踪里调用的 `id` 相同。 */
  readonly invocationId: string
  /** 新吐出的一段，stdout、stderr 按到达顺序。 */
  readonly text: string
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
  /** 显式继承父任务的标准 Node 操作系统范围；能力目录仍受 modules 白名单约束。 */
  readonly node?: boolean
  /** 给主模型选择配置时看的任务用途。 */
  readonly description?: string
  /** 子任务模型总额度；仍受全部祖先的剩余总额约束。 */
  readonly budget?: Partial<Pick<ContextViewLimits, 'modelCalls' | 'modelTokens'>>
  /** 真实模型驱动，使用同一编译和计费路径。 */
  readonly model: ModelDriver
  /** 精确模块白名单，续跑时重新检查。 */
  readonly modules: readonly string[]
  /** 子任务的分区配额和近期窗口。 */
  readonly memory?: ContextMemoryPolicy
  /** 单次运行上限。 */
  readonly limits?: Partial<ActRunLimits>
}

/** 子任务调度的宿主配置。 */
export interface VelarosAgentsOptions {
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
