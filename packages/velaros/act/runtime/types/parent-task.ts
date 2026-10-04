import type { ContextInputFile, ContextRef } from '@velaros-ai/context'

/** 子任务可用普通文件读取的原文快照；来源引用继续归父任务持有。 */
export interface ParentTaskSource {
  readonly ref: ContextRef
  readonly objectId: string
  readonly path: string
  readonly chars: number
  readonly sha256: string
}

/** 一次派发或续跑时固定的父任务输入，goals 按用户输入顺序排列。 */
export interface ParentTaskSnapshot {
  readonly schemaVersion: 1
  readonly parentSessionId: string
  readonly parentTaskId: string
  readonly parentRevision: number
  readonly childSessionId: string
  readonly capturedAt: string
  readonly goals: ReadonlyArray<
    ParentTaskSource & { readonly attachments: ReadonlyArray<ParentTaskSource & ContextInputFile> }
  >
}
