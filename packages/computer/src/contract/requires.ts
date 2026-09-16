/**
 * 注入面：宿主必须或可以塞进来的东西，每个注入点一个接口。本包只从这些口子接收外部能力，别处不留钩子。
 *
 * - 工具上下文 `ComputerToolContext`：必须。宿主每次调工具时给，里面是宿主端口 `ComputerToolComputerApi`。
 * - 上下文解析器 `ComputerToolContextResolver`：挂进内核且要按工具名调用时必须，放在 `CreateComputerKernelModuleOptions` 里给。
 * - 运行时选项 `ComputerSidecarManagerOptions`：可选，创建 sidecar 时给，可以整个替换 helper 定位与子进程启动。
 * - helper 定位选项 `ComputerHelperResolverOptions`：可选，宿主自己掌握资源根与停用开关时给。
 * - 环境变量：可选，全部登记在 `contract/constants.ts` 的 `ComputerEnvironmentVariables`。
 *
 * 这里的每个接口都必须从入口导出。
 */

import type { ScopeRef } from '@velaros-ai/kernel/contracts/abi'

import type {
  ComputerAvailability,
  ComputerClickOptions,
  ComputerClickResult,
  ComputerHelperLaunchSpec,
  ComputerKeyResult,
  ComputerMoveResult,
  ComputerScreenshot,
  ComputerScreenSize,
  ComputerTypeResult,
} from '../types/computer.js'

// ── 工具上下文与宿主端口 ────────────────────────────────────────

/** 每次工具调用拿到的上下文：取消信号与宿主端口。 */
export interface ComputerToolContext {
  /** 本次调用的取消信号；用户取消或上层超时时触发，工具和宿主都要尽快收手。 */
  abortSignal: AbortSignal
  /** 宿主端口：工具经它向宿主要桌面控制能力。 */
  computer: ComputerToolComputerApi
}

/**
 * 宿主端口：工具在运行时能向宿主要什么，工具里写作 `ctx.computer`。全仓唯一权威。
 *
 * 两个宿主（Desktop、Termel）都是把本包的 sidecar 运行时薄映射成这个形状。
 * 端口里只有工具真会调的方法，门禁按工具文件与它委托的 impl 类核对。
 */
export interface ComputerToolComputerApi {
  /** 探测桌面控制是否可用（含操作系统权限），永不抛错，一切失败都在结果里。 */
  ensureAvailable: () => Promise<ComputerAvailability>
  /** 主显示器的逻辑几何；主屏局部坐标换算成全局坐标要用它的原点。 */
  screenSize: () => Promise<ComputerScreenSize>
  /** 截取主显示器，始终按逻辑分辨率，保证图上量出的像素与点击坐标 1:1。 */
  screenshot: () => Promise<ComputerScreenshot>
  /** 把指针移动到虚拟桌面的全局逻辑坐标，不点击。 */
  mouseMove: (x: number, y: number) => Promise<ComputerMoveResult>
  /**
   * 在指定坐标空间点击。主屏坐标必须带上给出这组坐标的那次截图的 snapshotId，
   * 运行时在真正按下之前再校验一次绑定，布局变了就拒绝。
   */
  click: (
    x: number,
    y: number,
    options?: ComputerClickOptions
  ) => Promise<ComputerClickResult>
  /** 在当前焦点处原样输入文本。 */
  typeText: (text: string) => Promise<ComputerTypeResult>
  /** 按下一个键或组合键（例如 `cmd+a`、`enter`）。 */
  key: (keys: string) => Promise<ComputerKeyResult>
}

/**
 * 宿主端口的旧名字。
 *
 * @deprecated 用 `ComputerToolComputerApi`；这个别名在入口收口那一轮删除。
 */
export type ToolComputerApi = ComputerToolComputerApi

/**
 * 工具上下文的旧名字。
 *
 * @deprecated 用 `ComputerToolContext`；这个别名在入口收口那一轮删除。
 */
export type ToolContext = ComputerToolContext

/**
 * 上下文解析器：内核按工具名调用时，先向宿主要一份工具上下文。
 * 宿主不给就一个操作都不登记，能力服务只能读工具说明。
 */
export type ComputerToolContextResolver = (
  scope: LooseOptional<ScopeRef>,
  signal: AbortSignal
) => Promise<ComputerToolContext> | ComputerToolContext

// ── 运行时的注入口 ──────────────────────────────────────────────

/** manager 依赖的最小子进程接口，测试中可注入替身。 */
export interface ComputerSidecarProcess {
  /** 请求写进这里；真实 child 的写入是异步的，写失败经 `on('error')` 到达。 */
  stdin: {
    /** 写一行请求。 */
    write(chunk: string): void
    /** 关闭输入管道，示意 helper 收工。 */
    end(): void
    /**
     * 管道写错误（helper 关掉 stdin 或已退出时的 `EPIPE`）只经这个事件异步到达：
     * `write()` 外面的 try/catch 接不住它，没有监听者就是**宿主进程的未捕获异常**
     * （Electron 主进程会弹错误框）。替身可以不实现，真实 child 一定有。
     */
    on?(event: 'error', listener: (error: Error) => void): void
  }
  /** helper 的应答流，一行一帧。 */
  stdout: {
    /** 订阅应答数据；行的切分由调用方自己做。 */
    on(event: 'data', listener: (chunk: Buffer | string) => void): void
  }
  /** helper 的诊断流，只留尾部给启动失败当 detail。 */
  stderr: {
    /** 订阅诊断数据。 */
    on(event: 'data', listener: (chunk: Buffer | string) => void): void
  }
  /** 进程级错误（spawn 失败等）。 */
  on(event: 'error', listener: (error: Error) => void): void
  /** 进程退出，带退出码。 */
  on(event: 'exit', listener: (code: Nullable<number>) => void): void
  /** 终止进程。 */
  kill(signal?: NodeJS.Signals): void
}

/** 子进程启动器：按解析出来的 helper 规格拉起一个 sidecar 进程。 */
export type ComputerSidecarSpawner = (
  spec: ComputerHelperLaunchSpec
) => ComputerSidecarProcess

/** 创建 sidecar 运行时时可以塞进来的东西，一个都不给就用随包默认值。 */
export interface ComputerSidecarManagerOptions {
  /** 覆盖 helper 解析逻辑，用于测试或自定义打包。 */
  resolveHelper?: () => Nullable<ComputerHelperLaunchSpec>
  /** 覆盖子进程创建逻辑，测试中注入假 duplex，也可以换成完全不是 Python 的 sidecar。 */
  spawnProcess?: ComputerSidecarSpawner
  /** 单个请求超时时间，单位毫秒，默认见 `ComputerTuning.requestTimeoutMs`。 */
  requestTimeoutMs?: number
  /** 启动握手超时时间，单位毫秒，默认见 `ComputerTuning.startupTimeoutMs`。 */
  startupTimeoutMs?: number
  /** 可选诊断日志接收器。 */
  onLog?: (message: string) => void
}

/** 创建 helper 定位器时可以塞进来的东西。 */
export interface ComputerHelperLocatorOptions {
  /** 覆盖资源根目录；默认从共享资源根、Electron resourcesPath 与 cwd 推导。 */
  resourceRoots?: string[]
  /** 覆盖平台，主要供测试使用。 */
  platform?: NodeJS.Platform
  /** 宿主自己的资源来源：按需安装根与停用开关；不给就只认平台约定的那几个根，且认为没有被停用。 */
  resources?: ComputerResourcePort
}

/**
 * helper 定位选项的旧名字。
 *
 * @deprecated 用 `ComputerHelperLocatorOptions`；这个别名在入口收口那一轮删除。
 */
export type ComputerHelperResolverOptions = ComputerHelperLocatorOptions

/** 宿主可以登记的资源 id，目前只有桌面控制插件自己。 */
export type ComputerResourceId = 'computeruse'

/**
 * 资源来源端口：宿主告诉本包按需安装根在哪、哪些插件被用户停用了。
 *
 * 以前这是本包里一张模块级的可变登记表，宿主（Desktop）把安装根登记在**它自己**的表里，
 * 本包的那张永远是空的——装好的插件因此找不到。现在由宿主在创建定位器时把自己的表包成这个端口传进来。
 */
export interface ComputerResourcePort {
  /** 宿主登记的额外资源安装根，按登记顺序优先于平台约定的共享根。 */
  extraResourceRoots(): string[]
  /** 该资源是不是被用户停用了；停用时 `resolve()` 视为不可用，但「物理上装了没有」仍答得出来。 */
  isDisabled(id: ComputerResourceId): boolean
}

// ── 内核模块的注入口 ────────────────────────────────────────────

/** 创建内核模块时可以塞进来的东西。 */
export interface CreateComputerKernelModuleOptions {
  /** 内核按工具名调用工具时，向宿主要一份工具上下文；不给就只登记零个操作。 */
  resolveContext?: ComputerToolContextResolver
  /** 宿主已经有一份运行时单例时注入它，模块就不再自己造。 */
  runtime?: ComputerRuntimePort
  /** 注入进来的运行时默认归调用方所有，显式打开才在模块释放时一并释放。 */
  disposeInjectedRuntime?: boolean
  /** 模块自己造 sidecar 时用的选项。 */
  sidecar?: ComputerSidecarManagerOptions
}

/**
 * 桌面控制运行时的注入口形状：宿主注入自己的运行时时按它写。
 *
 * 本包的实现是 `ComputerSidecarManager`；Desktop 与 Termel 都持有它并把它薄映射成工具的宿主端口。
 */
export interface ComputerRuntimePort {
  /** sidecar 是否完成了 ready 握手。 */
  isReady(): boolean
  /** 探测可用性，永不抛错。 */
  ensureAvailable(): Promise<ComputerAvailability>
  /** 主显示器的逻辑几何。 */
  screenSize(): Promise<ComputerScreenSize>
  /** 截取主显示器。 */
  screenshot(): Promise<ComputerScreenshot>
  /** 把指针移动到全局逻辑坐标。 */
  mouseMove(x: number, y: number): Promise<ComputerMoveResult>
  /** 在指定坐标空间点击；主屏坐标要带截图绑定。 */
  leftClick(
    x: number,
    y: number,
    options?: ComputerClickOptions,
  ): Promise<ComputerClickResult>
  /** 在当前焦点处输入文本。 */
  typeText(text: string): Promise<ComputerTypeResult>
  /** 按下一个键或组合键。 */
  key(keys: string): Promise<ComputerKeyResult>
  /** 终止 sidecar 并拒绝在飞请求；置位后不再有任何状态迁移。 */
  dispose(): void
}
