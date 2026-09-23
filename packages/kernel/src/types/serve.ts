import type { KernelModuleDefinition } from '../contract/requires.js'

import type { KernelModPackDescriptor, KernelModPackKind, ScopeRef } from './wire.js'

/** 外部 Client 请求把一件能力绑进会话时交上来的东西。 */
export interface KernelClientCapabilityBindRequest {
  /** 要绑的能力 id。 */
  readonly capabilityId: string
  /** 只绑这几个操作；`null` 表示这件能力上的全部操作。 */
  readonly operations: Nullable<readonly string[]>
  /** 只在这个作用域内绑；`null` 表示不限作用域。 */
  readonly scope: Nullable<ScopeRef>
}

/** 客户端准入策略对一次绑定请求的判定：准或不准，不准时带原因。 */
export type KernelClientAccessDecision =
  { readonly status: 'granted' } | { readonly status: 'denied'; readonly reason: string }

/** 一条已经绑进会话的能力要求：调用来时按它判断这次调用在不在授权范围里。 */
export interface BoundCapabilityRequirement {
  /** 绑的是哪件能力。 */
  readonly capabilityId: string
  /** 准许的操作集合；`null` 表示这件能力上的全部操作。 */
  readonly operations: Nullable<ReadonlySet<string>>
  /** 准许的作用域；`null` 表示不限作用域。 */
  readonly scope: Nullable<ScopeRef>
}

/** 一条能力会话的账本记录：会话 id 加它绑下的全部能力要求。 */
export interface CapabilitySessionRecord {
  /** 会话 id，连接内唯一，随连接断开一起作废。 */
  readonly sessionId: string
  /** 本会话绑下的能力要求，逐条判定调用是否被覆盖。 */
  readonly requires: readonly BoundCapabilityRequirement[]
}

/**
 * 服务面的生命周期状态。
 *
 * `failed` 是启动失败后的终态：少了它，启动失败后的状态一直停在 `idle`，于是会话打开与能力
 * 调用都回「可重试」，而 `start()` 只会重放同一个失败——调用方按提示重试，永远得到同一句话。
 */
export type KernelServiceStatus = 'idle' | 'started' | 'failed' | 'disposed'

/** 服务面对 ModStore 的运行期端口：`mods.*` 一族 RPC 只经它，服务面不碰磁盘与安装细节。 */
export interface KernelModCatalog {
  /** 列出仓库里的全部 pack（含停用的），给 `mods.list` 用。 */
  list(): readonly KernelModPackDescriptor[]
  /** 开关一个 pack；返回有没有改动，以及是否要重启才能生效。 */
  setEnabled(
    id: string,
    enabled: boolean
  ): Promise<{ readonly ok: boolean; readonly reloadRequired: boolean }>
  /** 从目录装一个 pack；返回装好的 pack 描述与是否要重启。目录不合法时抛带码的错误。 */
  installFromDirectory(directory: string): Promise<{
    readonly pack: KernelModPackDescriptor
    readonly reloadRequired: boolean
  }>
}

/** ModStore 落盘的两条路径：装好的用户 pack 放哪、持久化的索引写在哪。 */
export interface KernelModStorePaths {
  /** 装好的用户 pack 所在目录（缺省 `~/.velaros/mods`）。 */
  readonly userModsDirectory: string
  /** 覆盖/补充已发现 pack 的 JSON 索引文件；不给就不做持久化。 */
  readonly indexPath?: string
}

/** ModStore 里一个 mod pack 的登记记录（身份、来源、开关位与它自称提供的能力）。 */
export interface KernelModPackRecord {
  /** pack 的 id，仓库内唯一。 */
  readonly id: string
  /** 来源：随包的 system、用户装的 user、第三方 contrib。 */
  readonly kind: KernelModPackKind
  /** pack 的版本号。 */
  readonly version: string
  /**
   * installed pack：指向导出 KernelModuleDefinition 的入口的绝对路径或 file URL。
   * bundled pack：`bundled:<moduleId>` 身份 URI，永远不会被 import（见 {@link KernelModPackRecord.module}）。
   */
  readonly specifier: string
  /** 入口上取哪个导出名，缺省 `default`。 */
  readonly exportName?: string
  /**
   * 编译期就在手的模块实例——只有 bundled pack 有。
   *
   * 有它 = pack 随构建图进来，「装载」就是读一个字段：没有 IO，也没有运行期失败面（坏掉的
   * bundled pack 是构建红，不是降级启动）。没有 = installed pack，按 `specifier` 导入。
   */
  readonly module?: KernelModuleDefinition
  /** 这个 pack 现在是开着还是被用户停用了。 */
  readonly enabled: boolean
  /** pack 自称提供的能力 id（装载前就能拿来做发现）。 */
  readonly provides: readonly string[]
}

/**
 * 一个开着、但这次启动没能变成模块的 pack。
 *
 * 只留在内存里：`mods.*` 的 wire 描述还没有状态字段，原因经 Kernel 日志走；进程内的调用方
 * （启动结果、守护进程装配、测试）从仓库里读它。
 */
export interface KernelModPackLoadFailure {
  /** 装不上的 pack id。 */
  readonly id: string
  /** 这个 pack 的来源。 */
  readonly kind: KernelModPackKind
  /** 这个 pack 的入口标识，用来对上是哪一个。 */
  readonly specifier: string
  /** 人读得懂的原因（导入抛错、导出形状不对……）。 */
  readonly reason: string
}

/** 按 ModStore 里开着的 pack 装载出来的结果：装成的模块、对应的 pack，以及装不上的那些。 */
export interface LoadModsResult {
  /** 这次装出来的模块定义，按 pack 顺序。 */
  readonly modules: readonly KernelModuleDefinition[]
  /** 装出了模块的那些 pack（开着的 pack 的子集），与 {@link LoadModsResult.modules} 按下标一一对应。 */
  readonly packs: readonly KernelModPackRecord[]
  /** 开着却装不上的 pack；永远不会被悄悄吞掉。 */
  readonly failures: readonly KernelModPackLoadFailure[]
}

/** 登记系统 pack 时交进来的一条记录（随包编译的带 `module`，可导入的带 `specifier`）。 */
export interface KernelSystemModPackInput {
  /** pack 的 id。 */
  readonly id: string
  /** pack 的版本号。 */
  readonly version: string
  /** 入口路径或 `bundled:` 身份 URI。 */
  readonly specifier: string
  /** 入口上取哪个导出名，缺省 `default`。 */
  readonly exportName?: string
  /** 编译期就在手的模块实例（随包 pack 才有）。 */
  readonly module?: KernelModuleDefinition
  /** pack 自称提供的能力 id。 */
  readonly provides: readonly string[]
  /** 显式的开关位；不给就沿用仓库里已有的值，仓库里也没有才默认开着。 */
  readonly enabled?: boolean
}

/**
 * 编译期 bundled pack：模块实例随构建图进来，装载零 IO。
 *
 * 宪章 §15.2 层间铁律「`bundled` = 编译期依赖（不是运行时下载物）」+「`importSibling` 退役」：
 * bundled pack 不再是「一个 .mjs 入口文件 + 运行时按磁盘布局算路径 import」，而是一个
 * **数组常量**——谁编进来谁负责，构建图解析不了就是构建期红，运行时没有这一类失败面。
 *
 * 依赖方向（§15.2 ⑤→④→③→②）决定了**谁能编进来**：本包是第 ② 层的 serve 配件，不认识任何
 * 具体能力包，所以内核自己一个 bundled pack 都不带；具体能力的 bundled pack 归**宿主**的构建图。
 */
export interface KernelBundledPack {
  /** pack 的 id。 */
  readonly id: string
  /** pack 的版本号；不给就取模块清单里的版本。 */
  readonly version: string
  /** 这个 pack 提供的能力 id。 */
  readonly provides: readonly string[]
  /** 编译期就在手的模块定义；`specifier` 只是身份回显，永不被 import。 */
  readonly module: KernelModuleDefinition
}

/**
 * 启动器要跑哪个已安装的 Kernel 版本，由它回答。
 *
 * 启动器刻意不认识安装布局；那是 `kernel-updater` 的事，由它把解析好的入口交过来。两边分开，
 * 换版本就永远不会和起进程抢同一份状态。
 */
export interface KernelVersionResolver {
  /** 解析当前激活的版本；解析不出来时抛错，启动器不再往下 spawn。 */
  resolveActiveVersion(): Promise<KernelVersionTarget>
}

/** 一个可以被 spawn 起来的 Kernel 版本：版本号加起它要用的入口、解释器、参数与环境。 */
export interface KernelVersionTarget {
  /** 这个目标的版本号，失败信息里回显它。 */
  readonly version: string
  /** Kernel 入口脚本或可执行文件的绝对路径。 */
  readonly entryPoint: string
  /** 用哪个解释器跑，缺省是当前进程的 `process.execPath`。 */
  readonly execPath?: string
  /** 追加在入口之后的命令行参数。 */
  readonly args?: readonly string[]
  /** 叠加在当前进程环境之上的环境变量。 */
  readonly env?: Readonly<Record<string, string>>
}
