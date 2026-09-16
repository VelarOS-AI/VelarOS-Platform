// 域：内核对外公开的可移植数据。
//
// 这里只放数据形状：不 import（除了常量表的类型）、不用 Node 专属类型、不带任何函数成员。
// 带行为的接口在 `contract/provides.ts` 与 `contract/requires.ts`，只在包内流动的 wire 帧在
// `types/wire.ts`。`./contracts` 入口 = 本文件 + `contract/constants.ts`。
import type { KernelModuleIsolation } from '../contract/constants.js'

/** 任何可以同步也可以异步给出的结果；模块生命周期钩子普遍用它。 */
export type Awaitable<T> = T | Promise<T>

/**
 * 稳定的服务身份：运行时只有 id 与 version 两个字段，编译期额外带住服务类型。
 *
 * 服务类型靠可选的幽灵字段 `serviceType` 带住——它永远不会被赋值，运行时对象里也没有这个键；
 * 原来用 `declare const ... : unique symbol` 做品牌，那是一条值声明，可移植数据文件里不许有。
 */
export interface CapabilityToken<TService extends object = object> {
  /** 能力的稳定身份，跨版本不变。 */
  readonly id: string
  /** 能力协议的语义版本；调用方按它判断提供方合不合用。 */
  readonly version: string
  /** 只在编译期带住服务类型的幽灵字段；运行时永远缺席，不要读它。 */
  readonly serviceType?: TService
}

/** 声明对另一件能力的依赖，只写身份与版本范围，不引它的实现包。 */
export interface CapabilityRequirement {
  /** 依赖的能力身份。 */
  readonly id: string
  /** 可接受的版本范围（caret、tilde 或 `||` 写法）；不写表示任意版本。 */
  readonly versionRange?: string
}

/** 不透明的作用域句柄：模块状态与授权按它分区，内核不解释 `kind` 的取值。 */
export interface ScopeRef {
  /** 作用域身份，只在发出它的模块里有意义。 */
  readonly id: string
  /** 发出这个作用域的模块 id。 */
  readonly ownerModuleId: string
  /** 模块自己用来路由或诊断的种类标记；内核不枚举它。 */
  readonly kind?: string
}

/**
 * 模块拥有的资源句柄。
 *
 * 拿到它的一方只能经发出它的那件能力去解引用；内核不解释它指向的载荷，
 * 本地路径、页面实例、数据库主键都不穿透信任边界。
 */
export interface ResourceRef {
  /** 资源身份，只在发出它的模块里有意义。 */
  readonly id: string
  /** 发出这个资源句柄的模块 id。 */
  readonly ownerModuleId: string
  /** 资源所属的作用域。 */
  readonly scope?: ScopeRef
  /** 资源内容的 MIME 类型，给消费方挑解码方式用。 */
  readonly mediaType?: string
}

/**
 * 模块代码跑起来之前就能解析出依赖图的静态声明。
 *
 * 能力 id 是稳定的契约身份；模块 id 标识具体提供方，在一个宿主里必须唯一。
 */
export interface KernelModuleManifest {
  /** 模块身份，一个宿主里唯一。 */
  readonly id: string
  /** 模块自身的语义版本。 */
  readonly version: string
  /** 模块清单 ABI 版本；与宿主认的那一个不同就拒绝注册。 */
  readonly apiVersion: number
  /** 本模块提供的能力令牌。 */
  readonly provides: readonly CapabilityToken[]
  /** 必需的能力依赖；缺一个就整图起不来。 */
  readonly requires: readonly CapabilityRequirement[]
  /** 可选的能力依赖；缺席只是拿不到，不影响启动。 */
  readonly optionalRequires: readonly CapabilityRequirement[]
  /** 本模块声明会用到的权限位；没声明过的权限一律拒绝。 */
  readonly permissions: readonly string[]
  /** 部署决策：进程内、worker 还是远程。 */
  readonly isolation: KernelModuleIsolation
}

/** 非进程内的隔离形态；这几种要宿主注入对应的适配器才激活得了。 */
export type ExternalKernelModuleIsolation = Exclude<
  KernelModuleIsolation,
  'in-process'
>

/** 模块健康度的四态；`unknown` 表示还没问过。 */
export type KernelModuleHealthStatus =
  | 'unknown'
  | 'healthy'
  | 'degraded'
  | 'unhealthy'

/**
 * 宿主状态机持有的模块生命周期状态。
 *
 * 声明在这里是因为宿主与服务面契约说的是同一套；抄成两份的那次，新状态到了宿主，
 * wire 上的视图却悄悄过期了。
 */
export type KernelModuleStatus =
  | 'registered'
  | 'activating'
  | 'active'
  | 'readying'
  | 'ready'
  | 'suspending'
  | 'suspended'
  | 'disposing'
  | 'disposed'
  | 'failed'

/** 一个模块自报的健康度。 */
export interface KernelModuleHealth {
  /** 健康度状态。 */
  readonly status: KernelModuleHealthStatus
  /** 给人看的一句话；不健康时说清楚哪里不对。 */
  readonly message?: string
  /** 诊断细节，随模块自己定义。 */
  readonly details?: Readonly<Record<string, unknown>>
}

/** 内核里流过的一条事件；来源模块与代际由宿主补上，模块伪造不了。 */
export interface KernelEvent<TPayload = unknown> {
  /** 事件类型名。 */
  readonly type: string
  /** 事件载荷，形状由发布方的能力协议定义。 */
  readonly payload: TPayload
  /** 发布这条事件的模块 id。 */
  readonly sourceModuleId: string
  /** 发布时该模块的代际。 */
  readonly sourceGeneration: number
  /** 本内核里单调递增的序号。 */
  readonly sequence: number
}

/** 宿主的权限判定收到的完整请求；模块身份与代际由宿主填。 */
export interface KernelPermissionRequest {
  /** **提供**这件能力的模块。 */
  readonly moduleId: string
  /** 提供方模块当前的代际。 */
  readonly generation: number
  /**
   * 这次调用是「代谁」发起的——宿主认得出调用方时才填。
   *
   * 只看 `moduleId` 回答不了「授权账本该记在谁头上」：它是能力的提供方，于是 mod A 调模块 B
   * 提供的能力时授权记在 B 名下，之后每个调 B 的 mod 都被静默放行。宿主专用字段，
   * 刻意不出现在 {@link KernelModulePermissionRequest} 里：模块永远不能指名自己以外的调用方。
   */
  readonly callerModuleId?: string
  /** 要判的权限位。 */
  readonly permission: string
  /** 给人看的理由，会进确认弹窗。 */
  readonly reason?: string
  /** 这次调用落在哪个作用域上。 */
  readonly scope?: ScopeRef
  /** 这次调用碰的资源。 */
  readonly resource?: ResourceRef
  /** 宿主策略要用的补充事实。 */
  readonly details?: Readonly<Record<string, unknown>>
}

/** 模块自己的作用域 broker 能填的部分；模块身份与调用方归属都不在这里。 */
export interface KernelModulePermissionRequest {
  /** 要判的权限位。 */
  readonly permission: string
  /** 给人看的理由，会进确认弹窗。 */
  readonly reason?: string
  /** 这次调用落在哪个作用域上。 */
  readonly scope?: ScopeRef
  /** 这次调用碰的资源。 */
  readonly resource?: ResourceRef
  /** 宿主策略要用的补充事实。 */
  readonly details?: Readonly<Record<string, unknown>>
}

/** 权限判定的结果：准了给授权 id，拒了必须说原因。 */
export type KernelPermissionDecision =
  | {
      readonly status: 'granted'
      readonly grantId?: string
    }
  | {
      readonly status: 'denied'
      readonly reason: string
    }

/** 健康检查里一个模块的那一行。 */
export interface KernelServiceModuleHealth {
  /** 模块 id。 */
  readonly id: string
  /** 模块版本。 */
  readonly version: string
  /** 模块当前代际。 */
  readonly generation: number
  /** 模块生命周期状态。 */
  readonly status: KernelModuleStatus
  /** 模块自报的健康度。 */
  readonly health: KernelModuleHealth
  /** 模块失败时留下的原因。 */
  readonly error?: string
}

/** 服务面的整体健康度：一个总状态加逐模块明细。 */
export interface KernelServiceHealth {
  /** 总状态：全好、部分降级、已停。 */
  readonly status: 'healthy' | 'degraded' | 'stopped'
  /** 逐个模块的明细。 */
  readonly modules: readonly KernelServiceModuleHealth[]
}

/** 一个模块的只读快照。 */
export interface KernelModuleSnapshot {
  /** 模块清单（已冻结）。 */
  readonly manifest: KernelModuleManifest
  /** 模块生命周期状态。 */
  readonly status: KernelModuleStatus
  /** 模块自报的健康度。 */
  readonly health: KernelModuleHealth
  /** 模块当前代际。 */
  readonly generation: number
  /** 失败时留下的原因。 */
  readonly error?: string
}

/** 组合快照里一件能力的那一行。 */
export interface KernelCompositionCapabilitySnapshot {
  /** 能力身份。 */
  readonly id: string
  /** 声明提供这件能力的版本。 */
  readonly version: string
  /** 声明提供它的模块 id。 */
  readonly providerModuleId: string
  /** 现在是否真的有活动服务在提供它。 */
  readonly active: boolean
  /** 活动服务所属的代际；没有活动服务时是 `null`。 */
  readonly activeGeneration: Nullable<number>
}

/**
 * 运行组合的只读机器视图：装了什么、按什么顺序、哪些服务真的活动。
 *
 * 它不接受 patch，因而绕不过模块注册、权限与生命周期裁决。
 */
export interface KernelCompositionSnapshot {
  /** 快照自身的结构版本。 */
  readonly schemaVersion: 1
  /** 宿主认的模块 ABI 版本。 */
  readonly apiVersion: number
  /** 模块的激活顺序；解析不出来时退回登记顺序。 */
  readonly moduleOrder: readonly string[]
  /** 每个模块的快照，按 id 排序。 */
  readonly modules: readonly KernelModuleSnapshot[]
  /** 每件能力的快照，按 id 排序。 */
  readonly capabilities: readonly KernelCompositionCapabilitySnapshot[]
  /**
   * 依赖图这一次没解析出来的原因；解析成功是 `null`。
   *
   * 快照最该有用的时刻就是降级态（`lifecycleFailureMode: 'degrade'` 的宿主启动失败后正要
   * 看诊断），所以解析失败不再向外抛，而是把原因摆在这里。
   */
  readonly resolutionError: Nullable<string>
}


/** 内核门面的生命周期状态。 */
export type KernelStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'disposing'
  | 'disposed'

/** 本机 RPC 端点：Unix 域套接字。 */
export interface UnixKernelRpcEndpoint {
  /** 端点种类。 */
  readonly kind: 'unix'
  /** 套接字文件路径。 */
  readonly path: string
}

/** 本机 RPC 端点：回环 TCP（Windows 上没有 Unix 域套接字时用）。 */
export interface TcpKernelRpcEndpoint {
  /** 端点种类。 */
  readonly kind: 'tcp'
  /** 只允许回环地址。 */
  readonly host: '127.0.0.1'
  /** 监听端口。 */
  readonly port: number
}

/** 本机 Kernel RPC 的端点地址；缺省 Unix 域套接字，Windows 上退回回环 TCP。 */
export type KernelRpcEndpoint =
  | UnixKernelRpcEndpoint
  | TcpKernelRpcEndpoint

/** 单实例守护进程在盘上的三个位置。 */
export interface KernelDaemonPaths {
  /** 端点 descriptor 文件。 */
  readonly descriptorPath: string
  /** 单实例锁文件。 */
  readonly lockPath: string
  /** Unix 域套接字文件。 */
  readonly socketPath: string
}

/**
 * 在跑的守护进程发布出来的端点 descriptor。
 *
 * 守护进程写、客户端读，两边共用这一份定义，盘上的约定就漂移不了。
 */
export interface KernelDaemonEndpointDescriptor {
  /** 连接时要带的认证令牌。 */
  readonly authToken: string
  /** 本次守护进程实例的身份。 */
  readonly instanceId: string
  /** 守护进程说的 wire 协议版本。 */
  readonly protocolVersion: number
  /** 守护进程自报的内核版本。 */
  readonly kernelVersion: string
  /** 守护进程的进程号，用来判活。 */
  readonly pid: number
  /** 启动时刻（毫秒时间戳）。 */
  readonly startedAt: number
  /** 实际监听到的端点地址。 */
  readonly endpoint: KernelRpcEndpoint
}
