/**
 * 本地内核给宿主界面的数据里，引用到 shell 能力数据（后台任务状态、shell 描述）的那几个：终止后台任务的结果、
 * 控制台的增量输出与控制结果、环境体检。它们要从 `@velaros-ai/shell-command/contracts` 取类型，所以不在可移植文件里；从根入口导出。
 */

import type { ShellBackgroundTaskStatus, ShellCommandKind, ShellDescriptor, ShellRecommendation } from '@velaros-ai/shell-command/contracts'

import type { SystemEnvironmentCommandAvailability, SystemRuntimePlatform } from './system.js'

/** 终止后台任务的结果：记录终止前后的状态，`terminated` 为 false 时看 `message`。 */
export interface SystemBackgroundTaskTerminateResult {
  taskId: string
  sessionId: Nullable<string>
  pid: number
  signal: 'SIGTERM' | 'SIGKILL'
  statusBefore: ShellBackgroundTaskStatus
  statusAfter: ShellBackgroundTaskStatus
  terminated: boolean
  message: string
}

/** 控制台的一段增量输出。 */
export interface SystemConsoleOutputChunk {
  taskId: string
  /** 从请求的 cursor 起新产生的输出。 */
  text: string
  /** 下一次请求把这个值当 cursor 传回来。 */
  cursor: number
  /** 缓冲区放不下、已经丢掉的字符数；大于 0 表示中间有一段永远看不到了。 */
  droppedChars: number
  /** 任务此刻的状态。 */
  status: ShellBackgroundTaskStatus
  /** 现在还能不能写输入。 */
  acceptsInput: boolean
}

/** 写输入或发中断的结果：`accepted` 为 false 时看 `message`，不猜原因。 */
export interface SystemConsoleControlResult {
  taskId: string
  accepted: boolean
  status: ShellBackgroundTaskStatus
  message: string
}

/**
 * 一次环境体检的完整结果：操作系统、shell 与关心的命令是否齐备。
 *
 * `shell` 是默认用的那个，`shells` 是本机可用的全部。宿主把这两样写进每回合给模型的环境报告，模型才知道
 * `run` 的 `shell` 字段能填哪几个、不填时用的是哪个；POSIX 机器上 `shells` 只有 `posix` 一项，模型就不会去填。
 */
export interface SystemEnvironmentInspection {
  os: { platform: SystemRuntimePlatform; arch: string; release: string; homeDir: string }
  /** 本机可用的全部 shell，按挑选优先顺序（Windows 是 Git Bash、PowerShell 7、Windows PowerShell、CMD），第一个就是 `shell` 那个默认的。 */
  shells: ShellDescriptor[]
  shell: {
    path: string
    variableCount: number
    pathEntries: string[]
    kind?: ShellCommandKind
    name?: string
    readiness?: ShellDescriptor['readiness']
    version?: LooseOptional<string>
    recommendation?: LooseOptional<ShellRecommendation>
    revision?: string
  }
  commands: SystemEnvironmentCommandAvailability[]
}
