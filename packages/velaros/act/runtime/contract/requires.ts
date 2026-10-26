import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'

import type { ActContextPolicy, ActRunLimits, ActRunEvent, AgentJob } from '@velaros-ai/agent'
import type {
  ContextCompletionPort,
  ContextSourcePort,
  ContextStorage,
  ContextVerificationFingerprint,
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
import type { ShellHostPort } from '@velaros-ai/velaros/execution'
import type { ImageSpacePort } from '@velaros-ai/velaros/images'
import type { MemoryScopePort } from '@velaros-ai/velaros/memory'
import type { ProjectCodeIndexApi, ProjectSpacePort } from '@velaros-ai/velaros/project'
import type { SkillCapabilityModuleOptions } from '@velaros-ai/velaros/skills'

import type { CompletionEvidenceApi } from '../impl/CompletionEvidence.js'
import type { CompletionValidationApi } from '../impl/CompletionValidation.js'
import type { McpClientConnectionApi } from '../impl/McpClientConnection.js'
import type { CompletionExecutionEntry } from '../types/completion-evidence.js'
import type {
  CompletionValidationInput,
  CompletionValidationOutcome,
} from '../types/completion-validation.js'
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
  readonly completion?: ContextCompletionPort | CompletionReviewOptions
}

/** 独立模型核查只读材料；区分完整正文与仅含元数据的证明，指纹覆盖产物与授权。 */
export interface CompletionArtifactSnapshot {
  /** 完整依赖的可靠变化代次；无法覆盖时必须返回 unknown。 */
  readonly fingerprint: ContextVerificationFingerprint
  /** 正文完整；大产物可仅提供宿主流式核对的元数据，此时 text 严格为 JSON.stringify(metadata)。 */
  readonly materials: ReadonlyArray<{
    readonly identity: string
    readonly text: string
    /** 只证明字节存在与完整性，不代表模型已读正文或内容通过；sha256 绑定全部原始字节。 */
    readonly metadata?: { readonly bytes: number; readonly sha256: string }
  }>
  /** 缺失、截断、权限或不稳定读取保持显式缺口，不伪造空文件。 */
  readonly issues: readonly string[]
  /** 可选的有界目录定位提示；只含实际条目，不是文件正文或验收证据，目标仍须重新 capture。 */
  readonly locations?: ReadonlyArray<{
    readonly directory: string
    readonly files: readonly string[]
    readonly directories: readonly string[]
    readonly truncated: boolean
  }>
}

/** 宿主提供限定工作区内的完整文本或明确的文件元数据；模型不能通过此口执行命令。 */
export interface CompletionArtifactSource {
  /** identities 为 file: 后接工作区路径；maxBytes 限制送入模型的 UTF-8 材料字节，含元数据。 */
  capture(
    identities: readonly string[],
    maxBytes: number,
    signal: AbortSignal
  ): Promise<CompletionArtifactSnapshot>
  /** 按需读取同一授权快照中的一份完整 UTF-8 原文，供 Runtime 选择连续片段；不直接全部送给模型。最大 16777216 字节，返回指纹仍覆盖 expected 的全部依赖。旧宿主可省略，缺口保持显式。 */
  read?(
    identity: string,
    expected: ContextVerificationFingerprint,
    maxBytes: number,
    signal: AbortSignal
  ): Promise<CompletionArtifactSnapshot>
}

/** 普通任务的有界独立模型复核；执行验证仅由显式宿主端口提供。 */
export interface CompletionReviewOptions {
  /** 在统一完成接口中选择有界的独立模型复核。 */
  readonly kind: 'model-review'
  /** 宿主拥有的工作区读取与变化代次权威。 */
  readonly artifacts: CompletionArtifactSource
  /** 在裁定前独立补充契约和调用链文件，最多两轮；只扩展宿主已授权工作区的证据，不增加用户交付要求。 */
  readonly discoverEvidence?: boolean
  /** 可选反例调查：裁定前共用既有取证和隔离验证额度，先实际尝试独立检查；须同时提供 validation，默认关闭。 */
  readonly counterexampleReview?: boolean
  /** 省略时复用主会话的驱动，仍使用独立请求和共同预算。 */
  readonly model?: ModelDriver
  /** 可选隔离执行验证；省略时复核保持只读，不回退普通执行器。 */
  readonly validation?: CompletionValidationHost
}

/** 宿主收到已授权输入与完整版本；不接受模型决定的命令、路径、环境或额度。 */
export interface CompletionValidationRequest extends CompletionValidationInput {
  /** 输入属于该完整快照，宿主读取前后都须保持一致。 */
  readonly fingerprint: ContextVerificationFingerprint
  /** 包括准备和进程执行的墙钟上限，仍受父任务取消约束。 */
  readonly timeoutMs: number
  /** 两路输出合计允许返回的 UTF-8 字节数。 */
  readonly maxOutputBytes: number
}

/** 独立验证的宿主权威；拒绝缺少约束的后端，取消后须等待进程清理再返回。 */
export interface CompletionValidationHost {
  /** 只在授权产物副本中运行；固定运行时与隔离、文件准备及清理由宿主负责。 */
  execute(
    request: CompletionValidationRequest,
    signal: AbortSignal
  ): Promise<CompletionValidationOutcome>
}

/** Node 宿主对同一工作区快照、固定运行时和授权生命周期的绑定。 */
export interface NodeCompletionValidationOptions {
  /** 当前授权工作区的根目录。 */
  readonly workspace: string
  /** 已有只读产物提供者；验证与取证必须共享同一实例及版本权威。 */
  readonly artifacts: CompletionArtifactSource
  /** 宿主提供的 Node.js 执行文件。 */
  readonly executable: string
  /** 宿主授权撤销时终止正在进行的准备和验证。 */
  readonly signal?: AbortSignal
}

/** 单次完成复核使用的验证配额、需求版本和文件授权集合。 */
export interface CompletionValidationDependencies {
  /** 显式宿主验证端口。 */
  readonly host?: CompletionValidationHost
  /** 当前授权快照。 */
  readonly snapshot: CompletionArtifactSnapshot
  /** 当前固定需求身份。 */
  readonly requirementIds: readonly string[]
  /** 完整需求清单的 SHA256。 */
  readonly requirementsSha256: string
  /** 核对完整文件和授权代次。 */
  assertCurrent(signal: AbortSignal): Promise<void>
}

/** 验证操作的专用上下文；不含主任务普通命令执行能力。 */
export interface CompletionValidationOperationContext {
  /** 复核生命周期和父任务取消信号。 */
  readonly abortSignal: AbortSignal
  /** 当前版本与调用次数的接收门。 */
  readonly validation: CompletionValidationApi
}

/** 一次复核的冻结证据依赖；来源、原始执行记录与当前版本核对全部由宿主注入。 */
export interface CompletionEvidenceDependencies {
  /** 固定授权集合及其完整字节哈希、变化代次。 */
  readonly snapshot: CompletionArtifactSnapshot
  /** 当前宿主的只读文件快照入口。 */
  readonly artifacts: CompletionArtifactSource
  /** 当前根任务所有可访问的不可变源码/回执对。 */
  readonly executions: readonly CompletionExecutionEntry[]
  /** 按不可变对象身份读取实际执行存档。 */
  readonly storage: ContextStorage
  /** 每批读取前后核对完整依赖及授权，变化须抛出错误。 */
  assertCurrent(signal: AbortSignal): Promise<void>
}

/** 只读复核的专用操作上下文，不含任何执行、网络或文件写入端口。 */
export interface CompletionEvidenceOperationContext {
  /** 同时受父任务、复核期限和本轮调用取消约束。 */
  readonly abortSignal: AbortSignal
  /** 本次冻结证据及共享读取预算。 */
  readonly evidence: CompletionEvidenceApi
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
  /** 宿主直接挂通用 velaros:images 并绑定项目路径，独立于 Skill 选择；macOS 上用 sips 缩图和裁图。 */
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
  /** 当前轮次固定的 Skill 组合；Skill 声明的宿主能力经授权桥装配。 */
  readonly skills?: Omit<SkillCapabilityModuleOptions, 'node'>
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
  /** Node 执行环境；内部观察和维护复用该环境的只读进程口。 */
  readonly node?: RuntimeNodeOptions
  /** agent 的持久 npm 环境；默认使用 dataDir/environments/default 与 node.npm，false 关闭。 */
  readonly packageEnvironment?: EnvironmentRegistryApi | false
  /** 宿主挂载的领域模块；标准模块由运行时提供。 */
  readonly modules?: readonly OperationModuleDefinition[]
  /** 使用共享驱动接入模型；纯脚本宿主可以不给。 */
  readonly model?: ModelDriver | RuntimeModelConfiguration
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
