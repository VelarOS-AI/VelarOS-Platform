// 产品面：内核交给外面的整件能力。
//
// 类实现的 API 定义在各自类的上方，这里用 `export type { X } from '../impl/<域>/<类>.js'` 登记；
// 没有类的公开接口（宿主交给模块的上下文、对象字面量给出的句柄）直接声明在这里。
// 改这个文件等于改对外契约。
//
// 标 ★ 的是「这一轮只增不减」留下来的旧名字：它们今天还在入口上，所以照实登记成产品面；
// 入口收口那一轮（12 个入口收成 5 个、版本提到 0.3.0）连同对应的导出一起删。
import type { KernelDaemonDirectoryConnection } from '../impl/client/KernelDaemonDirectory.js'
import type { KernelStateStore } from '../impl/runtime/NamespacedKernelStateStore.js'
import type { KernelModuleEventBus } from '../impl/runtime/ScopedKernelEventBus.js'
import type { KernelModulePermissionBroker } from '../impl/runtime/ScopedKernelPermissionBroker.js'
import type { KernelServiceResolver } from '../impl/runtime/ScopedKernelServiceResolver.js'
import type { InProcessKernelTransportService } from '../impl/serve/InProcessKernelTransport.js'
import type {
  BootedKernelDaemonApi,
  KernelDaemonAssemblyOptions,
} from '../impl/serve/KernelDaemonAssembly.js'
import type { KernelLauncherResult } from '../impl/serve/KernelLauncher.js'
import type { CapabilityToken } from '../types/kernel.js'

// ── 进程内内核与模块 SDK（根入口 `.`）────────────────────────────────────
export type { KernelApi, KernelOptions } from '../impl/runtime/Kernel.js'
export type { KernelCapabilityInvokerApi } from '../impl/runtime/KernelCapabilityInvoker.js'
export type { KernelEventHubApi } from '../impl/runtime/KernelEventHub.js'
export type { KernelModuleHostApi, KernelModuleHostOptions } from '../impl/runtime/KernelModuleHost.js'
export type { KernelModuleKitApi } from '../impl/runtime/KernelModuleKit.js'
export type { KernelServiceStoreApi } from '../impl/runtime/KernelServiceStore.js'
export type { KernelStateStore } from '../impl/runtime/NamespacedKernelStateStore.js'
export type { KernelModuleEventBus } from '../impl/runtime/ScopedKernelEventBus.js'
export type { KernelModulePermissionBroker } from '../impl/runtime/ScopedKernelPermissionBroker.js'
export type { KernelServiceResolver } from '../impl/runtime/ScopedKernelServiceResolver.js'
export type { VelarosModEnvelopeApi } from '../impl/runtime/VelarosModEnvelopeParser.js'

// ── serve 部署组合（`./serve`、`./serve/updater`）────────────────────────
export type { AllowLoadedKernelClientAccessBrokerApi } from '../impl/serve/AllowLoadedKernelClientAccessBroker.js'
export type { CapabilitySessionLedgerApi } from '../impl/serve/CapabilitySessionLedger.js'
export type {
  BootedKernelDaemonApi,
  KernelDaemonAssemblyOptions,
} from '../impl/serve/KernelDaemonAssembly.js'
export type {
  KernelDaemonProcessApi,
  KernelDaemonProcessEnvironment,
} from '../impl/serve/KernelDaemonProcess.js'
export type {
  KernelLauncherApi,
  KernelLauncherOptions,
  KernelLauncherResult,
} from '../impl/serve/KernelLauncher.js'
export type { KernelLocalDaemonApi } from '../impl/serve/KernelLocalDaemon.js'
export type { KernelLocalRpcServerApi } from '../impl/serve/KernelLocalRpcServer.js'
export type { KernelModLoaderApi } from '../impl/serve/KernelModLoader.js'
export type { KernelModStoreApi } from '../impl/serve/KernelModStore.js'
export type { KernelUpdateLockApi } from '../impl/updater/KernelUpdateLock.js'
export type { KernelUpdaterApi } from '../impl/updater/KernelUpdater.js'
// ★ 下面这几个是 serve 内部装配件的配套形状，今天还在 `./serve` 与 `./runtime` 上。
export type {
  InProcessKernelTransportApi,
  InProcessKernelTransportService,
} from '../impl/serve/InProcessKernelTransport.js'
export type { KernelLocalDaemonOptions } from '../impl/serve/KernelLocalDaemon.js'
export type { KernelLocalRpcServerOptions } from '../impl/serve/KernelLocalRpcServer.js'
export type { KernelModStorePaths } from '../impl/serve/KernelModStore.js'
export type { KernelServiceApi, KernelServiceOptions } from '../impl/serve/KernelService.js'

// ── 瘦客户端（`./client`）────────────────────────────────────────────────
export type { CapabilitySessionApi } from '../impl/client/CapabilitySession.js'
export type { KernelClientApi } from '../impl/client/KernelClient.js'
export type {
  KernelDaemonDirectoryApi,
  KernelDaemonDirectoryConnection,
} from '../impl/client/KernelDaemonDirectory.js'

// ── 远程能力节点两端（`./remote`）────────────────────────────────────────
export type { RemoteNodeClientApi } from '../impl/remote-client/RemoteNodeClient.js'
export type { RemoteNodeIsolationAdapterOptions } from '../impl/remote-client/RemoteNodeIsolationAdapter.js'
export type { RemoteNodeProjectionApi } from '../impl/remote-client/RemoteNodeProjection.js'
export type { RemoteNodeServerApi } from '../impl/remote-node/RemoteNodeServer.js'
// ★ 远程两端内部零件的配套形状，今天还在 `./remote` 及其子路径上。
export type {
  RemoteNodePendingCallsApi,
  RemoteNodePendingCallsHost,
} from '../impl/remote-client/RemoteNodePendingCalls.js'
export type {
  RemoteNodeCallRunnerApi,
  RemoteNodeCallRunnerOptions,
} from '../impl/remote-node/RemoteNodeCallRunner.js'
export type { RemoteNodeInvocationPoolApi } from '../impl/remote-node/RemoteNodeInvocationPool.js'
export type {
  RemoteNodePairingGateApi,
  RemoteNodePairingGateOptions,
} from '../impl/remote-node/RemoteNodePairingGate.js'
export type { RemoteNodeResultCacheApi } from '../impl/remote-node/RemoteNodeResultCache.js'

/** 幂等的登记句柄：宿主管的登记表（服务、事件订阅）都用它交回撤销入口。 */
export interface KernelRegistration {
  /** 撤销这次登记；重复调用无副作用。 */
  dispose(): void
}

/**
 * 绑在某一代上的服务租约。
 *
 * 提供方换代之后旧句柄立即失效：再取服务会抛 `MODULE_STATE`，而不是悄悄返回旧对象。
 */
export interface KernelServiceHandle<TService extends object> {
  /** 这件能力的身份。 */
  readonly capabilityId: string
  /** 取到句柄那一刻活动的能力版本。 */
  readonly capabilityVersion: string
  /** 提供这件能力的模块 id。 */
  readonly ownerModuleId: string
  /** 句柄绑住的那一代。 */
  readonly generation: number
  /** 这个句柄还活着吗；换代之后为 false。 */
  isActive(): boolean
  /** 取服务对象；句柄已失效时抛 `MODULE_STATE`。 */
  get(): TService
}

/**
 * 宿主在激活时交给**一个**模块的收窄面。
 *
 * 服务登记与事件订阅都记在 `moduleId` 名下，回滚或释放时自动摘掉；模块伪造不了自己的身份、
 * 代际与调用方归属。
 */
export interface KernelModuleActivateContext {
  /** 本模块的 id，由宿主填。 */
  readonly moduleId: string
  /** 本模块这一次激活属于第几代。 */
  readonly generation: number
  /** 本模块被释放或被替换时 abort 的信号。 */
  readonly signal: AbortSignal
  /** 只能解析自己声明过的能力的服务视图。 */
  readonly services: KernelServiceResolver
  /** 以本模块身份收发事件的总线视图。 */
  readonly events: KernelModuleEventBus
  /** 只能为自己声明过的权限位求授权的权限面。 */
  readonly permissions: KernelModulePermissionBroker
  /** 绑死在本模块命名空间上的状态面。 */
  readonly state: KernelStateStore
  /** 注册一件自己清单里声明提供的能力；没声明过的令牌当场拒绝。 */
  registerService<TService extends object>(
    token: CapabilityToken<TService>,
    service: TService,
  ): KernelRegistration
}

/** 一条事件订阅的句柄；只负责把它关掉。 */
export interface KernelEventSubscription {
  /** 关掉这条订阅；关过之后再关是空操作。 */
  dispose(): void | Promise<void>
}

// ── ★ 只增不减留下来的旧名字：入口收口那一轮连同对应导出一起删 ──────────
/** 旧名字，等于 {@link BootedKernelDaemonApi}；`bootKernelDaemon` 的返回形状。 */
export type BootedKernelDaemon = BootedKernelDaemonApi

/** 旧名字，等于 {@link KernelDaemonAssemblyOptions}；`bootKernelDaemon` 的入参。 */
export type BootKernelDaemonOptions = KernelDaemonAssemblyOptions

/** 旧名字，等于 {@link KernelLauncherResult}；启动器每次动作的回执。 */
export type KernelLaunchResult = KernelLauncherResult

/** 旧名字，等于 {@link InProcessKernelTransportService}；进程内传输认的服务面。 */
export type InProcessKernelService = InProcessKernelTransportService

/** 旧名字，等于 {@link KernelDaemonDirectoryConnection}；连上守护进程之后拿到的三件套。 */
export type ConnectedKernelDaemon = KernelDaemonDirectoryConnection
