import { Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { TaskApprovalRecord, ToolCategoryId, ToolConfirmationDecisionOptions } from '../protocol'

/** 任务内唯一的授权账本。运行器仅保留此对象，不保留工具、编辑或模型上下文。 */
export class TaskApprovalState {
  private nextId = 1
  private revision = 0
  private disposed = false
  private readonly records = new Map<string, TaskApprovalRecord>()
  private readonly listeners = new Set<() => void>()

  public getRevision(): number { return this.revision }
  public subscribe(listener: () => void): () => void {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private changed(): void {
    this.revision++
    this.listeners.forEach((listener) => {
      try { listener() }
      catch (error) { Log.tag('TaskApprovalState').warn('approval view notification failed', { error }) }
    })
  }

  public has(scope: string): boolean {
    this.assertActive()
    return this.records.get(scope.trim())?.status === 'approved'
  }

  public scopes(): string[] {
    return [...this.records.entries()].filter(([, record]) => record.status === 'approved').map(([key]) => key)
  }

  public getApprovedToolCategories(): ToolCategoryId[] {
    return this.scopes().filter((key) => key.startsWith('tool-category:')).map((key) => key.slice('tool-category:'.length))
  }

  public list(): TaskApprovalRecord[] {
    return [...this.records.values()].map((record) => ({
      ...record,
      ...(record.requester ? { requester: { ...record.requester } } : {}),
    }))
  }

  public record(key: string, approved: boolean, options: ToolConfirmationDecisionOptions, message?: LooseOptional<string>): void {
    this.assertActive()
    const previous = this.records.get(key)
    this.records.set(key, {
      id: previous?.id ?? `approval-${this.nextId++}`,
      label: options.operation?.label ?? options.riskScope ?? '工具操作',
      target: options.operation?.target,
      requester: options.requester ? { ...options.requester } : undefined,
      status: approved ? 'approved' : 'denied',
      reason: message?.trim() || undefined,
      decidedAt: Date.now(),
    })
    this.changed()
  }

  public denial(key: string): Nullable<string> {
    this.assertActive()
    const record = this.records.get(key)
    return record?.status === 'denied'
      ? record.reason ?? '用户已拒绝本次操作。请选择其他方案，或等待用户修订授权。' : null
  }

  public status(key: string): TaskApprovalRecord['status'] | undefined {
    return this.records.get(key)?.status
  }

  public revoke(id: string): boolean {
    const entry = [...this.records.entries()].find(([, record]) => record.id === id)
    if (!entry || entry[1].status === 'revoked') return false
    const [key, record] = entry
    this.records.set(key, { ...record, status: 'revoked', decidedAt: Date.now() })
    this.changed()
    return true
  }

  /** 删除任务后，已有主执行、子执行及迟到审批回执共用的旧授权对象同时失效。 */
  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.records.clear()
    this.changed()
    this.listeners.clear()
  }

  private assertActive(): void {
    if (this.disposed) throw new AppError('EXECUTION_ABORTED', '任务已删除，授权已失效。')
  }
}
