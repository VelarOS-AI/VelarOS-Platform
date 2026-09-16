/**
 * 约定的常量表（对外合同的一部分）：工具身份与类别、内核能力与模块身份、资源布局、错误码、环境变量表、公开的上限。
 * 宿主按这里的名字登记工具、按错误码判断失败、按环境变量表配置本包；上限直接被工具说明与 schema 引用，是模型看到的数字。
 * 包内可调、不对外承诺的参数不在这里，在 `utils/tuning.ts`。
 * 不 import 任何东西、不用 Node 专属类型，整个文件随 `./contracts` 入口出包。
 */

/** 六个桌面控制工具的 canonical 名字。 */
export const ComputerToolNames = Object.freeze({
  screenshot: 'computer:screenshot',
  screenSize: 'computer:screen_size',
  move: 'computer:move',
  click: 'computer:click',
  type: 'computer:type',
  key: 'computer:key',
} as const)

export type ComputerToolName = (typeof ComputerToolNames)[keyof typeof ComputerToolNames]

/** 六个工具共用的职责类别：桌面控制整组默认关闭，要用得显式打开。 */
export const ComputerToolCategoryId = 'computer-control' as const

/** 桌面控制能力服务在内核里的身份。 */
export const ComputerCapabilityId = 'velaros.computer' as const

/** 本包作为内核模块的身份。 */
export const ComputerKernelModuleId = 'velaros.computer.sidecar' as const

/** 内核模块清单里的版本号；宿主的安装器按它判断随包 helper 资产要不要重装。 */
export const ComputerKernelModuleVersion = '0.2.8' as const

/**
 * 随插件分发的桌面控制平台包在磁盘上的布局。
 * 宿主的打包脚本与插件市场按这张表写盘，本包按同一张表找 helper：两边只有这一个约定。
 */
export const ComputerResourceLayout = Object.freeze({
  /** 该插件在宿主插件表里的 id，也是停用开关认的 id。 */
  pluginId: 'computeruse',
  /** 资源根下的一级目录名。 */
  toolDirectory: 'computer-use',
  /** 平台包目录名前缀，完整名字是 `<前缀>-<平台>-<架构>`。 */
  packageNamePrefix: 'computeruse',
  /** 本包自带的 helper 资产目录名（相对包根），里面是各平台的 Python 脚本。 */
  bundledRuntimeDirectory: 'runtime',
} as const)

/**
 * 内核能力面每个操作的权限与理由，宿主的发现界面与审批按它展示。
 *
 * 内核按工具名登记操作，每个操作真正生效的权限与理由来自工具定义本身（工具的 `permissions` 与能力声明的 `reason`）；
 * 这张表是同一份事实的只读副本，给不持有工具集合、只读合同的宿主看。整个模块要拉起 helper 子进程，
 * 这层权限写在内核模块清单的 `process:exec` 上，不再逐操作重复。
 */
export const ComputerOperationMetadata = Object.freeze({
  'computer:screenshot': Object.freeze({
    permissions: Object.freeze(['screen:capture']),
    reason: '观察桌面画面（截图与屏幕几何）。',
  }),
  'computer:screen_size': Object.freeze({
    permissions: Object.freeze(['screen:capture']),
    reason: '观察桌面画面（截图与屏幕几何）。',
  }),
  'computer:move': Object.freeze({
    permissions: Object.freeze(['input:control']),
    reason: '控制桌面输入（鼠标与键盘）。',
  }),
  'computer:click': Object.freeze({
    permissions: Object.freeze(['input:control']),
    reason: '控制桌面输入（鼠标与键盘）。',
  }),
  'computer:type': Object.freeze({
    permissions: Object.freeze(['input:control']),
    reason: '控制桌面输入（鼠标与键盘）。',
  }),
  'computer:key': Object.freeze({
    permissions: Object.freeze(['input:control']),
    reason: '控制桌面输入（鼠标与键盘）。',
  }),
} as const)

export type ComputerOperation = keyof typeof ComputerOperationMetadata

/**
 * 工具名到内核操作名的映射。内核已改成按工具名登记操作，两边逐一相同，这张表只为按它路由的老宿主留着。
 *
 * @deprecated 直接用工具名调内核操作；这张表在入口收口那一轮删除。
 */
export const ComputerToolOperations = Object.freeze({
  'computer:screenshot': 'computer:screenshot',
  'computer:screen_size': 'computer:screen_size',
  'computer:move': 'computer:move',
  'computer:click': 'computer:click',
  'computer:type': 'computer:type',
  'computer:key': 'computer:key',
} as const)

/**
 * 桌面控制对外承诺的错误语义。
 *
 * 失败关闭是默认姿态：辅助进程没准备好、管道断了、协议对不上时一律拒绝这次动作，绝不静默降级成「没点到」。
 * 除下面这些专属码外还会出现通用 `AppError` 码：`VALIDATION`（入参或截图绑定不合法）、
 * `PERMISSION`（桌面控制不可用，含系统权限缺失）、`TIMEOUT`（helper 在超时内没有回应）。
 */
export const ComputerErrorCodes = Object.freeze({
  /** sidecar 已释放，不再接受任何请求；宿主要重新创建一个运行时。 */
  sidecarDisposed: 'COMPUTER_SIDECAR_DISPOSED',
  /** 当前平台上找不到已安装的桌面控制平台包（helper 脚本或自带 venv 缺失）。 */
  helperMissing: 'COMPUTER_HELPER_MISSING',
  /** 拉起 helper 子进程本身失败（解释器不存在、权限不足等）。 */
  sidecarSpawnFailed: 'COMPUTER_SIDECAR_SPAWN_FAILED',
  /** helper 进程退出：可能在握手前，也可能在动作执行中途。 */
  sidecarExited: 'COMPUTER_SIDECAR_EXITED',
  /** helper 在启动超时内没有完成握手，本次启动已终止；下一次调用重新拉起。 */
  sidecarStartupTimeout: 'COMPUTER_SIDECAR_STARTUP_TIMEOUT',
  /** 请求写不进 helper 的输入管道（管道已断）；在飞的请求一次性拒绝。 */
  sidecarWriteFailed: 'COMPUTER_SIDECAR_WRITE_FAILED',
  /** helper 的应答不是合法的行分隔 JSON 信封。 */
  protocolInvalid: 'COMPUTER_PROTOCOL_INVALID',
  /** helper 报告的领域失败，`cause.details.helperErrorCode` 是下面那张 helper 错误码表里的码。 */
  helperError: 'COMPUTER_HELPER_ERROR',
} as const)

export type ComputerErrorCode = (typeof ComputerErrorCodes)[keyof typeof ComputerErrorCodes]

/**
 * Python helper 报告的领域错误码（随应答的 `error.code` 回来）。
 *
 * 这张表是 helper 资产与本包之间的唯一约定：sidecar 按码决定报 `VALIDATION` 还是 `COMPUTER_HELPER_ERROR`，
 * 并把 helper 的英文原文换成模型看得懂的中文说明。改 helper 的文案不影响判定，改这张表才影响。
 */
export const ComputerHelperErrorCodes = Object.freeze({
  /** 点主屏坐标却没带 snapshotId：必须先截图，再用同一次截图的 snapshotId。 */
  snapshotRequired: 'screen_snapshot_required',
  /** snapshotId 对不上当前画面：主屏、分辨率、缩放或原点变过，旧坐标作废。 */
  snapshotStale: 'screen_snapshot_stale',
  /** 全局坐标不该带 snapshotId。 */
  snapshotUnexpected: 'screen_snapshot_unexpected',
  /** 坐标落在截图或屏幕之外。 */
  coordinateOutOfBounds: 'screen_coordinate_out_of_bounds',
  /** 坐标空间不是 primary-display 或 global。 */
  coordinateSpaceInvalid: 'screen_coordinate_space_invalid',
  /** 取不到当前屏幕状态，无法校验坐标。 */
  screenStateInvalid: 'screen_state_invalid',
} as const)

export type ComputerHelperErrorCode =
  (typeof ComputerHelperErrorCodes)[keyof typeof ComputerHelperErrorCodes]

/**
 * 本包读写的全部环境变量。环境变量也是注入：宿主设什么、本包读什么都在这张表里，别处不许再冒出新的变量名。
 *
 * 三个都是 `input`：宿主或开发者设，本包只读。
 */
export const ComputerEnvironmentVariables = Object.freeze({
  resourceRoot: {
    name: 'VELAROS_COMPUTER_RESOURCE_ROOT',
    direction: 'input',
    description: '桌面控制平台包的资源根，多个用路径分隔符连接；设了就整组接管，不再与默认根合并。',
  },
  python: {
    name: 'VELAROS_COMPUTER_PYTHON',
    direction: 'input',
    description: '显式指定 Python 解释器，绕开「只认平台包自带 venv」这道门；开发者自证用。',
  },
  runtimeSourceRoot: {
    name: 'VELAROS_COMPUTER_RUNTIME_SOURCE_ROOT',
    direction: 'input',
    description: '随包 helper 资产目录的位置，宿主的安装器把资产装到别处时用它指路。',
  },
} as const)

/** 环境变量表里的一项。 */
export type ComputerEnvironmentVariable =
  (typeof ComputerEnvironmentVariables)[keyof typeof ComputerEnvironmentVariables]

/**
 * 输入类工具对外承诺的上限；工具说明与 schema 直接引用这里，改了模型看到的数字跟着变。
 * 内核按工具 schema 解析入参，所以线上调用受同一组上限约束，不存在第二套。
 */
export const ComputerInputLimits = Object.freeze({
  /** 坐标绝对值上限：虚拟桌面再大也不会超过它，超出即入参错误。 */
  coordinateBound: 20_000,
  /** 一次 computer:type 最多输入多少字符。 */
  typeTextChars: 10_000,
  /** 一次 computer:key 的按键串最多多少字符。 */
  keyChordChars: 100,
  /** 一次 computer:click 最多连击几次（双击 2、三击 3）；再多是误用。 */
  clickCount: 3,
  /** snapshotId 的最短长度。 */
  snapshotIdMinChars: 8,
  /** snapshotId 的最长长度。 */
  snapshotIdMaxChars: 128,
} as const)
