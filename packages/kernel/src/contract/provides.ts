// 产品面：内核交给外面的整件能力。
//
// 类实现的 API 定义在各自类的上方，这里用 `export type { X } from '../impl/<域>/<类>.js'` 登记；
// 没有类的公开接口（宿主交给模块的上下文、对象字面量给出的句柄）直接声明在这里。
// 改这个文件等于改对外契约。
import type { KernelStateStore } from '../impl/runtime/NamespacedKernelStateStore.js'
import type { KernelModuleEventBus } from '../impl/runtime/ScopedKernelEventBus.js'
import type { KernelModulePermissionBroker } from '../impl/runtime/ScopedKernelPermissionBroker.js'
import type { KernelServiceResolver } from '../impl/runtime/ScopedKernelServiceResolver.js'
import type { CapabilityToken } from '../types/kernel.js'

// ── 进程内内核与模块 SDK（根入口 `.`）────────────────────────────────────
export type { KernelApi, KernelOptions } from '../impl/runtime/Kernel.js'
export type { KernelModuleHostOptions } from '../impl/runtime/KernelModuleHost.js'
export type { KernelModuleKitApi } from '../impl/runtime/KernelModuleKit.js'
export type { KernelStateStore } from '../impl/runtime/NamespacedKernelStateStore.js'
export type { KernelModuleEventBus } from '../impl/runtime/ScopedKernelEventBus.js'
export type { KernelModulePermissionBroker } from '../impl/runtime/ScopedKernelPermissionBroker.js'
export type { KernelServiceResolver } from '../impl/runtime/ScopedKernelServiceResolver.js'
export type { VelarosModEnvelopeApi } from '../impl/runtime/VelarosModEnvelopeParser.js'

// ── serve 部署组合（`./serve`）──────────────────────────────────────────
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
export type { KernelModStoreApi } from '../impl/serve/KernelModStore.js'
export type { KernelServiceApi } from '../impl/serve/KernelService.js'
export type { KernelUpdaterApi } from '../impl/updater/KernelUpdater.js'

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
