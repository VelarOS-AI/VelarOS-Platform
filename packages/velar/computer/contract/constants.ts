/**
 * 约定的常量表（对外合同的一部分）：helper 资产的版本与布局、错误码、环境变量表、公开的上限。
 * 宿主按错误码判断失败、按资源布局装 helper、按环境变量表配置本单元；上限是模型在声明里看到的数字，操作按它们核对入参。
 * 单元内可调、不对外承诺的参数不在这里，在 `utils/tuning.ts`。
 * 不 import 任何东西、不用 Node 专属类型，整个文件随 `./computer/contracts` 入口出单元。
 */

/**
 * 随本单元发布的 helper 资产（`runtime/` 里各平台的 Python 脚本）的版本：宿主的安装器按它判断装过的那份要不要重装。
 * 改了 helper 脚本就升这个号。
 */
export const ComputerHelperVersion = '0.3.0' as const

/**
 * 随插件分发的桌面控制平台包在磁盘上的布局。
 * 宿主的打包脚本与插件市场按这张表写盘，本单元按同一张表找 helper：两边只有这一个约定。
 */
export const ComputerResourceLayout = Object.freeze({
  /** 该插件在宿主插件表里的 id，也是停用开关认的 id。 */
  pluginId: 'computeruse',
  /** 资源根下的一级目录名。 */
  toolDirectory: 'computer-use',
  /** 平台包目录名前缀，完整名字是 `<前缀>-<平台>-<架构>`。 */
  packageNamePrefix: 'computeruse',
  /** 随本单元发布的 helper 资产目录（相对 @velaros-ai/velar 的包根），里面是各平台的 Python 脚本。 */
  bundledRuntimeDirectory: 'computer/runtime',
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
 * 这张表是 helper 资产与本单元之间的唯一约定：sidecar 按码决定报 `VALIDATION` 还是 `COMPUTER_HELPER_ERROR`，
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
 * 本单元读写的全部环境变量。环境变量也是注入：宿主设什么、本单元读什么都在这张表里，别处不许再冒出新的变量名。
 *
 * 三个都是 `input`：宿主或开发者设，本单元只读。
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
 * 输入类操作对外承诺的上限：模型在声明里看到的就是这些数（两边一致由验收核对），操作按它们核对入参。
 */
export const ComputerInputLimits = Object.freeze({
  /** 坐标绝对值上限：虚拟桌面再大也不会超过它，超出即入参错误。 */
  coordinateBound: 20_000,
  /** 一次 typeText 最多输入多少字符。 */
  typeTextChars: 10_000,
  /** 一次 key 的按键串最多多少字符。 */
  keyChordChars: 100,
  /** 一次 click 最多连击几次（双击 2、三击 3）；再多是误用。 */
  clickCount: 3,
  /** snapshotId 的最短长度。 */
  snapshotIdMinChars: 8,
  /** snapshotId 的最长长度。 */
  snapshotIdMaxChars: 128,
} as const)
