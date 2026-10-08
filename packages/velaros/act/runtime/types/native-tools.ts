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
  readonly async?: boolean
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
