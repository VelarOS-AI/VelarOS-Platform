import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AgentJob } from '@velaros-ai/agent'
import type { ContextInputFile, ContextRef, ContextStorage } from '@velaros-ai/context'
import { ContextLimits, createContextRuntime } from '@velaros-ai/context'
import { isNull } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ParentTaskSnapshot, ParentTaskSource } from '../types/parent-task.js'

/** 子运行独占的原文快照，只在该运行存活期间提供普通文件入口。 */
export interface ChildTaskMaterialsApi {
  /** 固定当前父任务的全部原始输入，返回普通文件索引和可归档的来源清单。 */
  open(job: AgentJob, signal: AbortSignal): Promise<{ path: string; snapshot: ParentTaskSnapshot }>
  /** 子运行收束后删除其独占快照；重复清理安全。 */
  close(): Promise<void>
}

/** 从权威输入归档导出父任务材料，不依赖模型摘要或截断的工作帧。 */
export class ChildTaskMaterials implements ChildTaskMaterialsApi {
  private directory?: string

  public constructor(
    private readonly storage: ContextStorage,
    private readonly archive: string
  ) {}

  public async open(job: AgentJob, signal: AbortSignal) {
    signal.throwIfAborted()
    const state = await this.storage.load(job.parentSessionId)
    if (!state?.task?.id || state.task.id !== job.parentTaskId)
      throw new AppError('CONFLICT', '父任务已经变化，无法建立子任务材料快照')
    if (this.directory) throw new AppError('CONFLICT', '子任务材料快照已经建立')
    await mkdir(this.archive, { recursive: true })
    this.directory = await mkdtemp(join(this.archive, 'parent-task-'))
    const context = createContextRuntime({ sessionId: job.parentSessionId, storage: this.storage })
    const records = new Map(state.records.map((record) => [record.ref.id, record]))
    const goals: Array<ParentTaskSnapshot['goals'][number]> = []
    let nextFile = 0
    const copy = async (ref: ContextRef, user: boolean): Promise<ParentTaskSource> => {
      signal.throwIfAborted()
      const record = records.get(ref.id)
      if (ref.sessionId !== job.parentSessionId || !record || (user && record.kind !== 'user'))
        throw new AppError('PERMISSION', '父任务材料引用超出当前输入范围')
      const path = join(this.directory!, `${user ? 'goal' : 'attachment'}-${nextFile++}.txt`)
      const file = await open(path, 'wx', 0o400)
      const hash = createHash('sha256')
      let chars = 0
      let tail = ''
      try {
        for (;;) {
          signal.throwIfAborted()
          const part = await context.readInput(ref, {
            offset: chars,
            limit: ContextLimits.readChars,
          })
          if (!part.text.length && chars < part.totalChars)
            throw new AppError('INVARIANT', '父任务原文归档不完整')
          chars += part.text.length
          let text = tail + part.text
          tail = ''
          if (chars < part.totalChars && /[\uD800-\uDBFF]$/u.test(text)) {
            tail = text.slice(-1)
            text = text.slice(0, -1)
          }
          const bytes = Buffer.from(text)
          hash.update(bytes)
          await file.writeFile(bytes)
          if (chars >= part.totalChars) break
        }
      } finally {
        await file.close()
      }
      return { ref, objectId: record.objectId, path, chars, sha256: hash.digest('hex') }
    }
    try {
      for (const ref of state.task.goals) {
        const source = await copy(ref, true)
        const record = records.get(ref.id)!
        const attachments: Array<ParentTaskSnapshot['goals'][number]['attachments'][number]> = []
        if (record.title === 'user:manifest') {
          const body = await this.storage.get(ref.sessionId, record.objectId)
          if (isNull(body)) throw new AppError('NOT_FOUND', '父任务输入清单缺失')
          const manifest = JSON.parse(body) as { files: readonly ContextInputFile[] }
          for (const file of manifest.files) {
            if (
              !record.sources.some(
                (source) => source.sessionId === file.ref.sessionId && source.id === file.ref.id
              )
            )
              throw new AppError('PERMISSION', '附件没有绑定到父任务输入')
            attachments.push({ ...file, ...(await copy(file.ref, false)) })
          }
        }
        goals.push({ ...source, attachments })
      }
      signal.throwIfAborted()
      if ((await this.storage.load(job.parentSessionId))?.task?.id !== state.task.id)
        throw new AppError('CONFLICT', '建立材料快照期间父任务已经变化')
      const snapshot: ParentTaskSnapshot = {
        schemaVersion: 1,
        parentSessionId: job.parentSessionId,
        parentTaskId: state.task.id,
        parentRevision: state.task.revision,
        childSessionId: job.sessionId,
        capturedAt: new Date().toISOString(),
        goals,
      }
      const path = join(this.directory, 'index.json')
      await writeFile(path, JSON.stringify(snapshot), { flag: 'wx', mode: 0o400, signal })
      return { path, snapshot }
    } catch (error) {
      try {
        await this.close()
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], '父任务材料建立和清理失败')
      }
      throw error
    }
  }

  public async close(): Promise<void> {
    if (!this.directory) return
    await rm(this.directory, { recursive: true, force: true })
    this.directory = undefined
  }
}
