/**
 * 注入面：宿主必须或可以塞进来的东西，每个注入点一个接口。本单元只从这些口子接收外部能力，别处不留钩子。
 *
 * - 调用上下文 `ComputerOperationContext`：必须。空间每次分发 `velaros:computer` 的调用时给，里面是空间端口 `ComputerSpacePort` 与交图通道。
 * - 运行时选项 `ComputerSidecarManagerOptions`：可选，创建 sidecar 时给，可以整个替换 helper 定位与子进程启动。
 * - helper 定位选项 `ComputerHelperLocatorOptions` 与资源来源端口 `ComputerResourcePort`：可选，宿主自己掌握资源根与停用开关时给。
 * - 环境变量：可选，全部登记在 `contract/constants.ts` 的 `ComputerEnvironmentVariables`。
 *
 * 这里的每个接口都必须从入口导出。
 */

import type { ImageAttachment } from '@velaros-ai/velaros/images'

import type {
  ComputerAvailability,
  ComputerClickOptions,
  ComputerClickResult,
  ComputerHelperLaunchSpec,
  ComputerKeyResult,
  ComputerMoveOptions,
  ComputerMoveResult,
  ComputerScreenshot,
  ComputerTypeResult,
} from '../types/computer.js'

// ── 调用上下文与空间端口 ────────────────────────────────────────

/** 每次调用拿到的上下文：取消信号、空间端口与交图通道。 */
export interface ComputerOperationContext {
  /** 本次调用的取消信号；用户取消或上层超时时触发，操作和宿主都要尽快收手。 */
  abortSignal: AbortSignal
  /** 空间端口：操作经它向宿主要桌面控制能力，写作 `ctx.computer`。 */
  computer: ComputerSpacePort
  /** 把一张图交给模型看（screenshot 用它）；宿主收着，在这次结果后面按顺序放出来。不给就用不了 screenshot。 */
  attachImage?: (image: ImageAttachment) => void
}

/**
 * 空间端口：`velaros:computer` 的操作在运行时能向宿主要什么，写作 `ctx.computer`。全仓唯一权威。
 *
 * 宿主把本单元的运行时（`createComputerRuntime` 造的那份）直接交进来就行：运行时的接口比这个端口宽，结构上满足它。
 * 端口里只有操作真会调的方法，门禁按操作文件核对。
 */
export interface ComputerSpacePort {
  /** 探测桌面控制是否可用（含操作系统权限），永不抛错，一切失败都在结果里。 */
  ensureAvailable: () => Promise<ComputerAvailability>
  /** 截取主显示器，始终按逻辑分辨率，保证图上量出的像素与点击坐标 1:1。 */
  screenshot: () => Promise<ComputerScreenshot>
  /**
   * 移动指针，不点击。与点击同一套坐标契约：主屏坐标必须带上给出这组坐标的那次截图的
   * snapshotId，运行时在真正移动之前再校验一次绑定，布局变了就拒绝。
   */
  mouseMove: (x: number, y: number, options?: ComputerMoveOptions) => Promise<ComputerMoveResult>
  /**
   * 在指定坐标空间点击。主屏坐标必须带上给出这组坐标的那次截图的 snapshotId，
   * 运行时在真正按下之前再校验一次绑定，布局变了就拒绝。
   */
  click: (x: number, y: number, options?: ComputerClickOptions) => Promise<ComputerClickResult>
  /** 在当前焦点处原样输入文本。 */
  typeText: (text: string) => Promise<ComputerTypeResult>
  /** 按下一个键或组合键（例如 `cmd+a`、`enter`）。 */
  key: (keys: string) => Promise<ComputerKeyResult>
}

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
export type ComputerSidecarSpawner = (spec: ComputerHelperLaunchSpec) => ComputerSidecarProcess

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
  /** 宿主自己的资源来源：资源根与停用开关；不给就只认平台约定的那几个根，且认为没有被停用。 */
  resources?: ComputerResourcePort
}

/** 桌面控制运行资源的标识。 */
export type ComputerResourceId = 'computeruse'

/** 宿主提供资源根与启用状态，定位器只读取此端口。 */
export interface ComputerResourcePort {
  /** 宿主登记的额外资源安装根，按登记顺序优先于平台约定的共享根。 */
  extraResourceRoots(): string[]
  /** 该资源是不是被用户停用了；停用时 `resolve()` 视为不可用，但「物理上装了没有」仍答得出来。 */
  isDisabled(id: ComputerResourceId): boolean
}
