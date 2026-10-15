import type { ScriptRetention } from './results.js'
import type { ScriptObservationEdit, ScriptSnapshotObservation } from './runtime.js'

/** 与文本声明头同源的程序选项；组合约束由共用编译器核对。 */
export interface NativeProgramOptions {
  readonly language?: 'node'
  readonly input?: unknown
  readonly inputRef?: string
  readonly modules?: Readonly<Record<string, string>>
  readonly blobs?: Readonly<Record<string, string>>
  readonly sourceRef?: string
  readonly edits?: ScriptObservationEdit['edits']
  readonly format?: 'program'
}

/** 一次性执行独有的调度与租约选项。 */
export interface NativeExecutionOptions extends NativeProgramOptions {
  /** 省略时短等待后返回作业身份，true 立即后台受理，false 优先等待完整结果；新输入、并行程序收束或子任务进展可提前返回，原程序继续且同批依赖顺序不变。 */
  readonly async?: boolean
  /** 空 code 时检查、等待或停止已有执行；等待通道与检查/停止通道独立，可在普通执行槽满时使用。 */
  readonly control?: NativeExecutionControl
  /** 本次程序计时，整数毫秒 1..86400000；省略为 120000，父任务期限和取消优先。 */
  readonly timeoutMs?: number
  readonly retain?: ScriptRetention
}

/** 持续观察独有的刷新、快照与清除选项。 */
export interface NativeObservationOptions extends NativeProgramOptions {
  readonly snapshot?: ScriptSnapshotObservation['snapshot']
  readonly refresh?: boolean
  readonly clear?: true
}

/** exec 的源码与选项载荷。 */
export interface NativeExecutionInput {
  /** 原样执行的 JavaScript ESM 源码。 */
  readonly code: string
  readonly options?: NativeExecutionOptions
}

/** observe 不暴露一次性执行的调度与结果租约字段。 */
export interface NativeObservationInput {
  readonly code: string
  readonly options?: NativeObservationOptions
}

/** 同一完整响应内供程序读取的原文绑定。 */
export interface NativeBlobInput {
  readonly name: string
  readonly text: string
}

/** 显式完成声明；完成依据与展示答复分别传递。 */
export interface NativeDoneInput {
  readonly completion?: string
  readonly message?: string
}

/** 当前任务作业控制，源码由宿主固定；调用者不能在控制通道运行自定义代码。 */
export type NativeExecutionControl =
  | {
      readonly kind: 'read'
      readonly executionId: string
      readonly cursor?: number
      readonly limit?: number
    }
  | { readonly kind: 'stop'; readonly executionId: string }
  | {
      readonly kind: 'wait'
      readonly executionId: string
      /** 有界等待终态，整数毫秒 1..60000，默认 60000；到期返回当前状态。 */
      readonly waitMs?: number
      readonly cursor?: number
      readonly limit?: number
    }
