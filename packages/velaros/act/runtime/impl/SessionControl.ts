import { createContextInvocationJournal } from '@velaros-ai/context'
import { isNonBlankString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { GoalControl, GoalState } from '../../system/types/goal.js'
import type { WorkspaceEntry } from '../../system/types/workspace.js'
import type { SessionControlOptions } from '../contract/requires.js'
import type { RuntimeNoteContent, RuntimeNoteRead } from '../types/memory.js'
import type { ActTracePage, ActTraceQuery } from '../types/trace.js'
import { notePageLimit, noteReadRange } from '../utils/session-notes.js'

import { RuntimeTrace } from './RuntimeTrace.js'
import { SessionExecutionBinding } from './SessionExecutionBinding.js'
import { SessionGoal } from './SessionGoal.js'
import { SessionNotes } from './SessionNotes.js'

/** 宿主的持久会话控制；不装配或授权任何执行能力。 */
export interface SessionControlLease {
  /** 已通过身份核验的主会话。 */
  readonly id: string
  /** 按现有 key/revision 和任务水位读取笔记目录；不存在会话返回空页。 */
  listNotes(input?: {
    after?: string
    limit?: number
  }): Promise<{ items: readonly WorkspaceEntry[]; nextAfter: Nullable<string> }>
  /** 读取确定版本的笔记正文；不存在时为 NOT_FOUND。 */
  readNote(input: RuntimeNoteRead): Promise<RuntimeNoteContent>
  /** 读取原目标及删除墓碑；尚无目标时为 null。 */
  getGoal(): Promise<Nullable<GoalState>>
  /** 按 baseRevision 改变目标事实；resume 不启动或恢复模型。 */
  controlGoal(input: GoalControl): Promise<GoalState>
  /** 分页读取根会话或持久归属支线的现存事实；沿用共享正文预算，不重建模型请求。 */
  trace(input?: ActTraceQuery): Promise<ActTracePage>
  /** 只读当前任务的支线目录，不加载请求或正文。 */
  traceBranches(): Promise<ActTracePage['branches']>
  /** 停止新准入、等待已受理操作落定，再释放本次存储连接；重复调用安全。 */
  close(): Promise<void>
}

class SessionControl implements SessionControlLease {
  public readonly id: string
  private readonly binding: SessionExecutionBinding
  private readonly notes: SessionNotes
  private readonly goal: SessionGoal
  private readonly traceReader: RuntimeTrace
  private readonly signal = new AbortController().signal
  private readonly pending = new Set<Promise<unknown>>()
  private closing?: Promise<void>

  public constructor(private readonly options: SessionControlOptions) {
    this.id = options.sessionId
    this.binding = new SessionExecutionBinding(options.storage, { ...options.binding }, [])
    this.notes = new SessionNotes(this.id, options.storage)
    this.goal = new SessionGoal(this.id, options.storage)
    this.traceReader = new RuntimeTrace(
      this.id,
      options.storage,
      createContextInvocationJournal(options.storage)
    )
  }

  public listNotes(input: { after?: string; limit?: number } = {}) {
    const request = { ...input }
    return this.perform(async () => {
      if (!(await this.binding.assertControl(this.id))) {
        notePageLimit(request.limit)
        return { items: [], nextAfter: null }
      }
      return this.notes.list(request, this.signal)
    })
  }

  public readNote(input: RuntimeNoteRead) {
    const request = { ...input }
    return this.perform(async () => {
      if (!(await this.binding.assertControl(this.id))) {
        noteReadRange(request)
        throw new AppError('NOT_FOUND', '会话笔记不存在')
      }
      try {
        return await this.notes.readNote(request, this.signal)
      } catch (error) {
        if (error instanceof AppError && error.code === 'MEMORY_NOT_FOUND')
          throw new AppError('NOT_FOUND', error.message)
        throw error
      }
    })
  }

  public getGoal() {
    return this.perform(async () => {
      if (!(await this.binding.assertControl(this.id))) return null
      return this.goal.get(this.signal)
    })
  }

  public controlGoal(input: GoalControl) {
    const request = { ...input }
    return this.perform(async () => {
      if (!(await this.binding.assertControl(this.id)) || !(await this.goal.get(this.signal)))
        throw new AppError('NOT_FOUND', '会话目标不存在')
      return this.goal.control(request, this.signal)
    })
  }

  public trace(input: ActTraceQuery = {}) {
    const request = { ...input }
    return this.perform(async () => {
      await this.binding.assertControl(this.id)
      return this.traceReader.page(request)
    })
  }

  public traceBranches() {
    return this.perform(async () => {
      await this.binding.assertControl(this.id)
      return this.traceReader.branches()
    })
  }

  private async perform<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) throw new AppError('CLOSED', '会话控制 lease 已关闭')
    const running = operation()
    this.pending.add(running)
    try {
      return await running
    } finally {
      this.pending.delete(running)
    }
  }

  public close(): Promise<void> {
    this.closing ??= this.shutdown()
    return this.closing
  }

  private async shutdown(): Promise<void> {
    await Promise.allSettled([...this.pending])
    await this.options.storage.close()
  }
}

/** 打开持久会话的最小控制范围；失败时不接管调用方存储，不创建缺失会话。 */
export async function openSessionControl(
  options: SessionControlOptions
): Promise<SessionControlLease> {
  if (
    !isNonBlankString(options.sessionId) ||
    ['search:', 'agent:', 'context:', 'store-material:'].some((prefix) =>
      options.sessionId.startsWith(prefix)
    )
  )
    throw new AppError('VALIDATION', '需要有效的主会话身份')
  if (
    !options.storage ||
    !isNonBlankString(options.binding?.executionIdentity) ||
    !isNonBlankString(options.binding?.authorizationScope)
  )
    throw new AppError('VALIDATION', '需要显式存储及已核验的执行身份、授权范围')
  const configured = { ...options, binding: Object.freeze({ ...options.binding }) }
  await new SessionExecutionBinding(configured.storage, configured.binding, []).assertControl(
    configured.sessionId
  )
  return new SessionControl(configured)
}
