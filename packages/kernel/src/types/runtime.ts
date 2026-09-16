// 域：进程内内核的工作类型——带函数成员或宿主类型，所以不进可移植数据文件。
import type {
  KernelEventHandler,
  KernelModuleDefinition,
  KernelModuleLifecycle,
  KernelPermissionBroker,
  KernelStateBackend,
} from '../contract/requires'

import type {
  CapabilityToken,
  KernelModuleHealth,
  KernelModuleManifest,
  KernelModulePermissionRequest,
  KernelModuleStatus,
  ScopeRef,
} from './kernel.js'

/** 宿主为一个模块保存的全部可变状态；只在 `KernelModuleHost` 内部流动。 */
export interface ModuleRecord {
  /** 模块定义，`manifest` 已经克隆冻结过。 */
  readonly definition: KernelModuleDefinition
  /** 这一条记录属于模块的第几代。 */
  readonly generation: number
  /** 生命周期状态。 */
  status: KernelModuleStatus
  /** 最近一次问到的健康度。 */
  health: KernelModuleHealth
  /** 激活上下文还有效吗；失效之后模块的任何回调都被拒。 */
  contextActive: boolean
  /** `dispose` 钩子跑过没有；只跑一次。 */
  lifecycleDisposed: boolean
  /** 失败时留下的原因。 */
  error?: string
  /** 激活返回的生命周期钩子。 */
  lifecycle?: KernelModuleLifecycle
  /** 交给模块的中止控制器，模块被释放或替换时 abort。 */
  controller?: AbortController
}

/** 事件总线里的一条订阅；`isDeliveryEnabled` 让暂存中的新代先不收事件。 */
export interface EventSubscription {
  /** 订阅方模块 id。 */
  readonly ownerModuleId: string
  /** 订阅时该模块的代际。 */
  readonly generation: number
  /** 订阅回调；载荷类型在这一层已经擦掉，投递前由发布方保证形状。 */
  readonly handler: KernelEventHandler
  /** 这一刻要不要真的投递给它。 */
  readonly isDeliveryEnabled: () => boolean
}

/** 服务登记表里的一条服务；不出这张表。 */
export interface ServiceEntry {
  /** 提供方模块 id。 */
  readonly ownerModuleId: string
  /** 提供方代际。 */
  readonly generation: number
  /** 这条服务提供的能力版本。 */
  readonly capabilityVersion: string
  /** 服务实现对象本身。 */
  readonly service: object
}

/** 一次能力调用的描述；`signal` 承载取消与超时。 */
export interface KernelCapabilityCall {
  /** 要调的能力身份。 */
  readonly capabilityId: string
  /** 要调的操作名。 */
  readonly operation: string
  /** 这次调用落在哪个作用域上。 */
  readonly scope?: ScopeRef
  /** 调用入参，形状归各能力协议。 */
  readonly input: unknown
  /** 取消信号。 */
  readonly signal: AbortSignal
  /** 宿主认定的可信事实，原样转给权限判定做策略与审计。 */
  readonly permissionContext?: Omit<
    KernelModulePermissionRequest,
    'permission' | 'scope'
  >
  /**
   * 调用方归属：这次调用是「代谁」发起的，只有宿主给得出。
   *
   * `moduleId` 是能力的**提供方**，回答不了「授权账本该记在谁头上」：mod A 调模块 B 提供的
   * 能力时，授权会记到 B 名下，之后每个调 B 的 mod 都被静默放行。宿主认得出调用方时把它写在
   * 这里，调用器原样交给宿主的授权判定。模块自己永远填不了这一项。
   */
  readonly attribution?: { readonly callerModuleId: string }
}

/** 内核门面在 `throw` / `degrade` 两种失败模式下回调出去的生命周期失败。 */
export interface KernelLifecycleFailure {
  /** 失败发生在启动还是回收。 */
  readonly phase: 'start' | 'dispose'
  /** 归一化之后的错误。 */
  readonly error: Error
}

/** 拆开的语义化版本号；`build` 按 SemVer §10 不参与比较。 */
export interface SemanticVersion {
  /** 主版本号。 */
  readonly major: number
  /** 次版本号。 */
  readonly minor: number
  /** 修订号。 */
  readonly patch: number
  /** `-` 之后的预发布标识；没有就是 undefined（正式版）。 */
  readonly prerelease?: string
  /** `+` 之后的 build 元数据；按 SemVer §10 不参与比较。 */
  readonly build?: string
}

/** 装一个模块作用域权限面要的东西。 */
export interface ScopedKernelPermissionBrokerOptions {
  /** 这个模块的清单；权限位以它声明的为准。 */
  readonly manifest: KernelModuleManifest
  /** 这个模块当前的代际。 */
  readonly generation: number
  /** 宿主的权限权威。 */
  readonly broker: KernelPermissionBroker
  /** 上下文还有效吗；失效时抛错。 */
  readonly assertActive: () => void
}

/** 装一个模块作用域状态面要的东西。 */
export interface NamespacedKernelStateStoreOptions {
  /** 绑死的命名空间，一般就是模块 id。 */
  readonly namespace: string
  /** 宿主注入的状态后端。 */
  readonly backend: KernelStateBackend
  /** 上下文还有效吗；失效时抛错。 */
  readonly assertActive: () => void
}

/**
 * 内核侧失败的补充事实。
 *
 * 原来二十个错误子类各带各的专属字段（阶段、回滚错误、失败模块、能力 id、操作名、权限名、
 * 拒绝原因……），合并成四个类之后统一落在这里；外面要读的 `capabilityId`、`operation`、
 * `permission` 一个没少。
 */
export interface KernelErrorDetails {
  readonly moduleId?: string
  readonly capabilityId?: string
  readonly operation?: string
  readonly permission?: string
  readonly reason?: string
  readonly phase?: 'activate' | 'ready'
  readonly operationKind?: 'suspend' | 'dispose'
  readonly relatedModuleIds?: readonly string[]
  readonly rollbackErrors?: readonly Error[]
  readonly failures?: ReadonlyArray<{ readonly moduleId: string; readonly error: Error }>
  readonly source?: string
  readonly version?: string
  readonly versionRange?: string
  readonly [key: string]: unknown
}

/** 更新器错误上挂的细节。 */
export interface KernelUpdaterErrorDetails {
  readonly actual?: string
  readonly expected?: string
  readonly ownerPid?: number
  readonly path?: string
  readonly previousVersion?: string
  readonly target?: string
  readonly url?: string
  readonly version?: string
  readonly versionRange?: string
}

/** 依赖图解析的结果：稳定的激活顺序加每件能力的提供方。 */
export interface KernelModulePlan {
  /** 模块的激活顺序，同层按 id 字典序，结果确定。 */
  readonly order: readonly string[]
  /** 能力 id 到它的提供方。 */
  readonly capabilityProviders: ReadonlyMap<string, KernelCapabilityProvider>
}

/** 一件能力的提供方：哪个模块、用哪枚令牌提供。 */
export interface KernelCapabilityProvider {
  /** 提供这件能力的模块 id。 */
  readonly moduleId: string
  /** 它声明提供的那枚令牌。 */
  readonly capability: CapabilityToken
}

/** 服务登记表里一条活动服务的只读投影；不暴露实现对象。 */
export interface KernelActiveServiceSnapshot {
  /** 能力身份。 */
  readonly capabilityId: string
  /** 活动服务提供的能力版本。 */
  readonly capabilityVersion: string
  /** 提供方模块 id。 */
  readonly ownerModuleId: string
  /** 提供方当前代际。 */
  readonly generation: number
}
