import type { ScriptOutputBlock, ScriptOutputConfig } from './output.js'
import type { CodeRunOutcome, CodeRunRequest } from './runner.js'

/** 父进程交给受信 worker 的程序或能力回执。 */
export type ScriptWorkerCommand =
  | ({ readonly type: 'program' } & CodeRunRequest)
  | {
      /** 能力调用回执。 */
      readonly type: 'result'
      /** 同一程序内的调用身份。 */
      readonly callId: number
      /** 操作是否成功。 */
      readonly ok: boolean
      /** 成功返回的 JSON 数据。 */
      readonly value?: unknown
      /** 能力拒绝或失败。 */
      readonly error?: { readonly code: string; readonly message: string }
    }

/** worker 在隔离边界上逐次发出的纯数据事件。 */
export type ScriptWorkerEvent =
  | { readonly type: 'ready'; readonly confined: boolean }
  | { readonly type: 'log'; readonly line: string }
  | {
      readonly type: 'call'
      readonly callId: number
      readonly namespace: string
      readonly operation: string
      readonly input: unknown
    }
  | {
      readonly type: 'output'
      readonly event: {
        readonly config?: ScriptOutputConfig
        readonly block?: Omit<ScriptOutputBlock, 'chars'>
        readonly issue?: string
      }
    }
  | ({ readonly type: 'done' } & CodeRunOutcome)
