import type { ModelImage } from '../types/model.js'
import type {
  InvocationReceipt,
  InvocationReconciliation,
  InvocationRecord,
  ModuleBinding,
  OperationDescriptor,
  OperationSurface,
  PreparedInvocation,
} from '../types/operations.js'

/** 具体调用的受控上下文；模块资源在挂载时闭包注入。 */
export interface OperationContext {
  /** 已固定的调用身份和参数。 */
  readonly invocation: PreparedInvocation
  /** 取消只要求停止后续工作，不表示撤销已发生的效果。 */
  readonly signal: AbortSignal
  /** 观察适配器确认已正常收束；partial/none 不承诺无副作用。 */
  recordObservation?(evidence: NonNullable<InvocationReceipt['observation']>): void
  /** 处理器在提交效果后更新事实，随最终回执保存。 */
  recordEffect(effect: InvocationReceipt['effect']): void
  /** 独立保存领域诊断；重复调用以最新摘要为准，Kernel 限长并冻结，不改变效果与成败。 */
  recordDiagnostic?(diagnostic: NonNullable<InvocationReceipt['diagnostic']>): void
  /** 把真实图像交给模型；先验证再纳入持久回执。 */
  attach(image: ModelImage): void
}

/** 操作定义；schema、文档与处理器只有这一个登记处。 */
export interface OperationDefinition extends OperationDescriptor {
  /** 观察模式专用的受限实现；写操作只有经此口才能用于观察，保护范围由实现报告。 */
  observe?(input: unknown, context: OperationContext): unknown | Promise<unknown>
  /** 按已固定身份只读核对外部效果；未知返回 null，不能重新执行该操作。 */
  reconcile?(
    invocation: PreparedInvocation,
    signal: AbortSignal
  ): Promise<Nullable<Omit<InvocationReconciliation, 'checkedAt'>>>
  /** 显式准备一次输入；准备不得产生外部副作用。 */
  prepare?(input: unknown, context: { readonly signal: AbortSignal }): unknown | Promise<unknown>
  /** 执行已经准备并校验过的参数。 */
  run(input: unknown, context: OperationContext): unknown | Promise<unknown>
}

/** 模块作者提供的唯一运行时定义。 */
export interface OperationModuleDefinition {
  /** 模块源码随包提供的用法模板；生成代码面可在 surface 中提供。 */
  readonly template?: string
  /** 与操作描述同源的生成合同；省略时从 schema 生成精确声明。 */
  readonly surface?: OperationSurface
  /** 稳定公开身份与挂载代际。 */
  readonly binding: ModuleBinding
  /** 模块的发现摘要。 */
  readonly summary: string
  /** 自有操作表，原型属性不会成为操作。 */
  readonly operations: Readonly<Record<string, OperationDefinition>>
  /** 激活当前挂载的资源。 */
  activate?(): void | Promise<void>
  /** 回收当前挂载的资源。 */
  dispose?(): void | Promise<void>
}

/** 意图和回执的可靠日志；claim 必须跨进程原子去重。 */
export interface InvocationJournal {
  /** 追加已核对事实，不覆盖原回执；缺少此端口时不能持久化恢复结论。 */
  recordReconciliation?(
    sessionId: string,
    id: string,
    result: InvocationReconciliation
  ): Promise<void>
  /** 原子写入意图；已有同号记录时返回它，新写入返回 null。 */
  claim(prepared: PreparedInvocation): Promise<Nullable<InvocationRecord>>
  /** 唯一占用者提交准备后的不可变参数；完成后才允许派发。 */
  prepare(prepared: PreparedInvocation): Promise<void>
  /** 保存最终结果；失败必须抛错，不能宣称已经持久化。 */
  settle(receipt: InvocationReceipt): Promise<void>
  /** 读取同一会话内的调用；缺少终态时效果待核对。 */
  read(sessionId: string, id: string): Promise<Nullable<InvocationRecord>>
}

/** 操作运行时的依赖；所有入口共享这一个实例。 */
export interface OperationRuntimeOptions {
  /** 持久化派发前复核任务执行前提；抛错表示尚无外部效果。 */
  beforeDispatch?(
    invocation: PreparedInvocation,
    descriptor: OperationDescriptor,
    signal: AbortSignal
  ): Promise<void>
  /** 完整挂载定义。 */
  readonly modules: readonly OperationModuleDefinition[]
  /** 副作用派发前必须写入的持久日志。 */
  readonly journal: InvocationJournal
}

// 注入面：宿主与能力包必须或可以塞进内核的东西。
//
// 每个口子一个接口，写清谁给、什么时候给、必不必须。构造参数与回调这类「配套形状」跟着各自的
// 类放在类上方（例如 `KernelOptions`、`KernelUpdaterOptions`），不在这里重抄一遍。
import type {
  Awaitable,
  ExternalKernelModuleIsolation,
  KernelEvent,
  KernelModuleHealth,
  KernelModuleManifest,
  KernelPermissionDecision,
  KernelPermissionRequest,
  KernelServiceHealth,
  ScopeRef,
} from '../types/kernel.js'
import type { RemoteNodeCredentials } from '../types/remote-client.js'
import type {
  RemoteNodeActivityEvent,
  RemoteNodeAuditEntry,
  RemoteNodeCapabilityInvokeRequest,
  RemoteNodeCapabilityInvokeResult,
  RemoteNodePairedCredential,
} from '../types/remote-node.js'
import type {
  KernelClientAccessDecision,
  KernelClientCapabilityBindRequest,
} from '../types/serve.js'
import type {
  KernelArtifactExtractionContext,
  KernelArtifactSignatureContext,
  KernelArtifactSignatureResult,
  KernelFetchRequest,
  KernelFetchResponse,
  KernelHealthCheckContext,
} from '../types/updater.js'
import type { RemoteNodeManifest } from '../types/wire.js'
import type {
  CapabilityCallRequest,
  CapabilityCallResponse,
  CapabilitySessionCloseRequest,
  CapabilitySessionCloseResponse,
  CapabilitySessionOpenRequest,
  CapabilitySessionOpenResponse,
  KernelHandshake,
  ModsInstallFromDirectoryRequest,
  ModsInstallFromDirectoryResponse,
  ModsListRequest,
  ModsListResponse,
  ModsSetEnabledRequest,
  ModsSetEnabledResponse,
} from '../types/wire.js'

import type { KernelEventSubscription, KernelModuleActivateContext } from './provides.js'

/**
 * 宿主的权限权威：谁给、什么时候给——宿主装配内核时经 `createKernel({ permissionBroker })`
 * 或 `bootKernelDaemon({ permissionBroker })` 给；不给就是全拒，这是安全默认。
 *
 * 模块永远实现不了也替换不了它：模块拿到的是收窄过的 {@link KernelModulePermissionBroker}。
 */
export interface KernelPermissionBroker {
  /** 判一次权限；准了可以给授权 id，拒了必须说原因。判定本身抛错时内核按 `PERMISSION_CHECK_FAILED` 处理。 */
  request(request: KernelPermissionRequest): Promise<KernelPermissionDecision>
}

/**
 * 模块状态的持久化后端：宿主装配内核时给；不给就用进程内内存，进程一没就没了。
 *
 * 命名空间由内核绑死成模块 id，实现方不需要也不应该自己判断调用方是谁。
 */
export interface KernelStateBackend {
  /** 读一个命名空间下的键；没有就给 undefined。 */
  get(namespace: string, key: string): Promise<unknown>
  /** 写一个命名空间下的键。 */
  set(namespace: string, key: string, value: unknown): Promise<void>
  /** 删一个命名空间下的键；返回原来有没有这个键。 */
  delete(namespace: string, key: string): Promise<boolean>
  /** 列出一个命名空间下的键，可以按前缀过滤。 */
  list(namespace: string, prefix?: string): Promise<readonly string[]>
}

/**
 * 模块激活后交回的生命周期钩子：能力包在 `activate` 里返回；四个钩子都可选，
 * 只做注册的模块可以一个都不返回。
 */
export interface KernelModuleLifecycle {
  /** 全部模块都激活完之后调；这里做要跨模块的收尾。失败会让整次启动回滚。 */
  ready?(): Awaitable<void>
  /** 宿主挂起时调；释放可重建的资源，别丢状态。 */
  suspend?(): Awaitable<void>
  /** 宿主释放或本模块被替换时调；只会调一次。 */
  dispose?(): Awaitable<void>
  /** 宿主问健康度时调；抛错等于 unhealthy，不影响别的模块。 */
  health?(): Awaitable<KernelModuleHealth>
}

/**
 * 能力包交给内核的可执行模块：宿主注册模块时给，必须。
 *
 * worker 与远程装载器实现的是同一条边界，所以宿主不认识任何传输细节。
 */
export interface KernelModuleDefinition {
  /** 模块的静态清单；内核在模块代码跑起来之前就靠它解析依赖图。 */
  readonly manifest: KernelModuleManifest
  /** 激活模块；拿到的上下文是收窄过的宿主面，返回生命周期钩子或什么都不返回。 */
  activate(context: KernelModuleActivateContext): Awaitable<KernelModuleLifecycle | void>
}

/** 一次能力调用的上下文；算权限理由时可以按它变文案。 */
export interface KernelCapabilityOperationContext {
  /** 这次调的操作名。 */
  readonly operation: string
  /** 这次调用落在哪个作用域上。 */
  readonly scope?: ScopeRef
  /** 这次调用的入参。 */
  readonly input: unknown
}

/** 权限理由：常量串，或按本次调用算出来的一句话。 */
export type KernelCapabilityOperationReason =
  string | ((context: KernelCapabilityOperationContext) => string)

/** 一条可调用操作声明的权限策略。 */
export interface KernelCapabilityOperationMetadata {
  /** 这条操作要的权限位；每一条都会在 provider 代码跑之前逐条判定。 */
  readonly permissions: readonly string[]
  /** 给人看的理由，进确认弹窗；可以按调用上下文算。 */
  readonly reason?: KernelCapabilityOperationReason
}

/** 一条可调用操作：权限声明加它自己的执行体；能力包写模块时用 `kernelModules.callable` 产出。 */
export interface KernelCallableCapabilityOperation {
  /** 这条操作的权限声明。 */
  readonly metadata: KernelCapabilityOperationMetadata
  /** 执行体；`signal` 承载取消与超时，provider 自己负责响应它。 */
  invoke(
    scope: LooseOptional<ScopeRef>,
    input: unknown,
    signal: AbortSignal
  ): unknown | Promise<unknown>
}

/**
 * 内核服务边界认的可调用面：能力包把它注册成服务，内核才调得动。
 *
 * 服务面先取操作元数据再求权限，所以 `getOperationMetadata` 返回 undefined 就等于
 * 「在求权限之前拒绝这个未知操作」。
 */
export interface KernelCallableCapabilityService {
  /** 取一条操作的权限声明；没登记过就返回 undefined。 */
  getOperationMetadata(operation: string): Optional<KernelCapabilityOperationMetadata>
  /** 执行一条已登记的操作；未知操作与已中止的调用都不进 provider 代码。 */
  invoke(
    operation: string,
    scope: LooseOptional<ScopeRef>,
    input: unknown,
    signal: AbortSignal
  ): unknown | Promise<unknown>
}

/**
 * 非进程内模块的激活适配器：宿主装配内核时按隔离形态各给一个，声明了对应形态的模块才装得上。
 *
 * 适配器负责进程创建、传输，以及把对端的生命周期映射回 {@link KernelModuleLifecycle}。
 */
export interface KernelModuleIsolationAdapter {
  /** 这个适配器认哪一种隔离形态。 */
  readonly isolation: ExternalKernelModuleIsolation
  /** 激活一个非本地模块；拿到的上下文与进程内模块的完全一样。 */
  activate(
    module: KernelModuleDefinition,
    context: KernelModuleActivateContext
  ): Awaitable<KernelModuleLifecycle | void>
}

/** 事件订阅回调：订阅方在 `subscribe` 时给；它抛错只记日志，不影响发布方与别的订阅者。 */
export type KernelEventHandler<TPayload = unknown> = (
  event: KernelEvent<TPayload>
) => Awaitable<void>

// ── 瘦客户端的传输实现（`./client`、`./serve`）────────────────────────────
/**
 * 注入面：内核 RPC 的传输实现要满足的完整线上契约。
 *
 * 这是**给传输实现者看的**那一面（unix socket、进程内适配器、将来的远程认证通道），实例由
 * 宿主装配好之后塞给 `KernelClient`。产品用 `KernelClient`，不要直接调这里的方法——尤其是
 * 能力那几条线。
 */
export interface KernelClientTransport {
  // --- 连接 ---
  /** 握手：拿到对端的协议版本、内核版本与能力清单；连不上时抛 KernelClientError。 */
  handshake(): Promise<KernelHandshake>
  /** 取内核服务的健康快照；连不上时抛 KernelClientError。 */
  health(): Promise<KernelServiceHealth>

  // --- 能力线（RPC：capability.session.open/close、capability.call）---
  // 产品路径：KernelClient.openCapabilitySession → CapabilitySession.call/dispose
  /** 开一条能力会话，回应里带会话 id 与实际绑上的能力；被拒时回应本身是失败信封，不抛。 */
  openCapabilitySession(
    request: CapabilitySessionOpenRequest
  ): Promise<CapabilitySessionOpenResponse>
  /** 关掉一条能力会话；会话已经不在时回应里的 `closed` 是 false。 */
  closeCapabilitySession(
    request: CapabilitySessionCloseRequest
  ): Promise<CapabilitySessionCloseResponse>
  /** 在一条已开的会话上调一次能力；`signal` 中止时以 AbortError 结束并往对端发取消帧。 */
  call(request: CapabilityCallRequest, signal?: AbortSignal): Promise<CapabilityCallResponse>

  // --- mod 仓库线（RPC：mods.*）---
  /** 列出对端已知的全部 mod 与它们的启停状态。 */
  listMods(request: ModsListRequest): Promise<ModsListResponse>
  /** 启用或停用一个 mod；对端不认这个 id 时回应是失败信封。 */
  setModEnabled(request: ModsSetEnabledRequest): Promise<ModsSetEnabledResponse>
  /** 从一个本机目录安装 mod；目录不合法时回应是失败信封。 */
  installModFromDirectory(
    request: ModsInstallFromDirectoryRequest
  ): Promise<ModsInstallFromDirectoryResponse>

  // --- 事件 ---
  /** 订阅一类内核事件，返回可关闭的句柄；断线重连后由传输自己把订阅补回来。 */
  subscribe(eventType: string, handler: KernelClientEventHandler): Promise<KernelEventSubscription>

  /** 关掉这条传输：断开连接、清空订阅，在途请求一律以 TRANSPORT_CLOSED 落空。 */
  dispose(): void | Promise<void>
}

/** 订阅到的每一条内核事件都交给它；抛出的错误只记日志，不影响别的订阅者。 */
export type KernelClientEventHandler = (event: KernelEvent) => void | Promise<void>

/**
 * 注入面：清单与制品的字节来源。
 *
 * 更新器读安装根以外的任何东西都经这个函数，测试与离线宿主由此换成自己的传输，不碰网络。
 */
export type KernelFetch = (request: KernelFetchRequest) => Promise<KernelFetchResponse>

/**
 * 注入面：判断刚激活的内核能不能用。
 *
 * 返回 false 或抛错都算没过，更新器会把指针恢复成上一个版本再报失败。
 */
export type KernelHealthCheck = (context: KernelHealthCheckContext) => Promise<boolean> | boolean

/**
 * 注入面：把校验过的制品展开成一个暂存目录。
 *
 * 实现只许往 `destinationDirectory` 里写；抛错就整次安装失败，暂存目录会被清掉。
 */
export interface KernelArtifactExtractor {
  /** 把 `context.payloadPath` 展开到 `context.destinationDirectory`；失败就抛。 */
  extract(context: KernelArtifactExtractionContext): Promise<void>
}

/**
 * 注入面：摘要核对之后、任何东西落位之前的签名校验。
 *
 * 内核自己不带密码学实现：部署方装一个绑定自己信任根与轮换策略的校验器，装好之后再打开
 * `requireSignature`。
 */
export interface KernelArtifactSignatureVerifier {
  /** 校验 `context` 里那份制品的签名；返回结论，校验不了也要给出 `verified: false` 与原因。 */
  verify(context: KernelArtifactSignatureContext): Promise<KernelArtifactSignatureResult>
}

/**
 * 装第三方 mod pack 时用的模块导入函数：起守护进程的宿主给，装 installed pack 时必须。
 *
 * 「按运行期才知道的路径加载代码」静态依赖图表达不了，所以包内一条动态 `import()` 都不留，
 * 由 `bin/velaros-kernel-daemon.mjs` 这类在 `src` 之外的可执行文件交进来。不给它时，
 * 随包编译的 bundled pack 照常装，installed pack 逐个登记成装载失败，守护进程仍然起得来。
 */
export type KernelModuleImporter = (url: string) => Promise<Record<string, unknown>>

// ── 守护进程的客户端准入（`./serve`）────────────────────────────────────
/**
 * 外部 Client 把能力绑进会话时的准入策略，由产品或组合根注入；实例归宿主。
 *
 * 与模块权限 broker 不是一回事：那一条管「模块能不能做某个操作」，这一条管「连上来的 Client
 * 能不能把一件已装载的能力绑进自己的会话」。
 */
export interface KernelClientAccessBroker {
  /** 判一次绑定请求：准了回 granted，不准回 denied 并带上给人看的原因；判不出来时抛错，由调用方按「判不出授权结果」处理。 */
  requestBind(request: KernelClientCapabilityBindRequest): Promise<KernelClientAccessDecision>
}

// ── 远程能力节点两端（`./remote`）────────────────────────────────────────
/**
 * socket 端口。
 *
 * 只声明本传输真正用到的方法,形状对齐 `ws` 的 EventEmitter 面(Electron 主进程没有可用的
 * DOM WebSocket)。收窄成端口是为了让测试替身与未来的 TLS/代理实现可以整体换掉。
 */
export interface RemoteNodeSocket {
  /** 把一帧文本写上线；写不出去由实现自己抛。 */
  send(data: string): void
  /** 主动断开，带 WebSocket 关闭码与原因。 */
  close(code?: number, reason?: string): void
  /** 连接建立。 */
  on(event: 'open', listener: () => void): unknown
  /** 收到一帧；载荷不做解释，原样交出。 */
  on(event: 'message', listener: (data: unknown) => void): unknown
  /** 连接关闭，带关闭码与原因。 */
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown
  /** 传输层出错。 */
  on(event: 'error', listener: (error: Error) => void): unknown
  /** 摘掉本 socket 上的全部监听；换连接之前必须先摘。 */
  removeAllListeners(): unknown
}

/** 按 url 建一条 socket；缺省实现走 `ws`，测试与替代传输注入自己的。 */
export type RemoteNodeSocketFactory = (url: string) => RemoteNodeSocket

/**
 * 凭据存储端口。
 *
 * 刻意只有三个动作:Desktop 后续换 Electron `safeStorage` 时只需换实现,调用点零改动。
 * `load` 在缺席与损坏时都返回 `null`——损坏等同未配对,重新走人工配对仪式,不半信半疑地用。
 */
export interface RemoteNodeClientCredentialStore {
  /** 读本机凭据；缺席与损坏都返回 `null`（损坏等同未配对，重走人工仪式）。 */
  load(): Promise<Nullable<RemoteNodeCredentials>>
  /** 落盘一份凭据；失败抛，由调用方降级记日志。 */
  save(credentials: RemoteNodeCredentials): Promise<void>
  /** 清掉本机凭据；Node 判「不认得你」时调。 */
  clear(): Promise<void>
}

/** 能力派发端口:把 wire 上的调用交给宿主 Kernel,`signal` 承载取消与超时。 */
export interface RemoteNodeCapabilityInvoker {
  /** 派发一次能力调用，只兑现 `success` / `denied` 两态；`signal` 承载取消与超时。 */
  invoke(
    request: RemoteNodeCapabilityInvokeRequest,
    signal: AbortSignal
  ): Promise<RemoteNodeCapabilityInvokeResult>
}

/**
 * 清单来源。
 *
 * `current()` 必须是同步的:握手末尾要在同一个 tick 内把清单塞进 `ready` 帧,中间插入 await
 * 会让「授予能力面」与「宣告能力面」之间出现可观测的空窗。
 */
export interface RemoteNodeManifestSource {
  /** 同步给出当前能力清单；握手末尾要在同一个 tick 内把它塞进 `ready` 帧。 */
  current(): RemoteNodeManifest
  /** 订阅清单变更，返回退订函数；单向推送，没有问答。 */
  onChange(listener: (manifest: RemoteNodeManifest) => void): () => void
}

/**
 * 凭据持久化端口。
 *
 * `load()` 语义是**失败即未配对**:任何读取或校验失败都返回 `null` 而不是抛,让 Node 退回到
 * 「需要重新配对」这一最小权限状态,而不是带着半个凭据继续服务。
 */
export interface RemoteNodeServerCredentialStore {
  /** 读已配对客户端的凭据；任何读取或校验失败都返回 `null`，退回「需要重新配对」。 */
  load(): Promise<Nullable<RemoteNodePairedCredential>>
  /** 落盘已配对客户端的公钥与展示名；失败抛，配对流程据此判失败。 */
  save(credential: RemoteNodePairedCredential): Promise<void>
  /** 解除配对时清掉落盘凭据。 */
  clear(): Promise<void>
}

/**
 * 审计落盘端口。
 *
 * 返回 `void` 而不是 Promise 是有意的:审计写盘绝不能进入调用路径的关键路径,更不能因为磁盘
 * 满或权限错误把一次正常的能力调用带塌。实现方自行排队并吞掉自身故障(降级为告警)。
 */
export interface RemoteNodeAuditSink {
  /** 记一条审计行；返回 `void`，实现方自行排队并吞掉自身故障。 */
  record(entry: RemoteNodeAuditEntry): void
}

/**
 * 产品执行流落点端口。
 *
 * 与审计端口一样是「只进不出」的单向口:返回 `void`,实现方自行吞掉自身故障。它只做可观测性,
 * 任何失败都不许反向影响权威审计或调用结果。
 */
export interface RemoteNodeActivitySink {
  /** 记一条执行流事件;失败自行吞掉,不抛回调用路径。 */
  record(event: RemoteNodeActivityEvent): void
}

import type {
  ModelDriverLimits,
  ModelInputEstimate,
  ModelTurnDelta,
  ModelTurnRequest,
} from '../types/model.js'

/** 主干依赖的中立模型驱动；供应商编码与使用量归驱动负责。 */
export interface ModelDriver {
  /** 驱动会在准备及排队之后、实际发送之前等待 beforeDispatch；旧驱动按调用入口保守记账。 */
  readonly dispatchAware?: boolean
  /** 支持完整的原生工具往返；未声明的自定义驱动使用文本协议。 */
  readonly nativeTools?: boolean
  /** 请求所用的模型身份。 */
  readonly id: string
  /** 模型独立的输入、输出和总窗口限制。 */
  readonly limits: ModelDriverLimits
  /** 按最终编码估算输入，包括工具 schema 与协议开销。 */
  estimate(request: ModelTurnRequest): Promise<ModelInputEstimate>
  /** 发起一轮请求；工具参数完整到达后才能输出 call。 */
  stream(
    request: ModelTurnRequest,
    signal: AbortSignal,
    beforeDispatch?: () => Promise<void>
  ): AsyncIterable<ModelTurnDelta>
}

import type { ApprovalDecision, ToolConfirmationDecisionOptions } from '../types/approval.js'
/** 操作审批端口；缺席必须默认拒绝。 */
export interface ApprovalPort {
  /** 被拒绝时终止当前操作。 */
  awaitConfirmation(
    message: string,
    signal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ): Promise<void>
  /** 返回绑定当前操作的明确审批结论。 */
  awaitConfirmationDecision(
    message: string,
    signal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ): Promise<ApprovalDecision>
}
