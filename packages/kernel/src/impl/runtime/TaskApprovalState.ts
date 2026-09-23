import { Log, mapDefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { TaskApprovalRecord, ToolConfirmationDecisionOptions } from '../../types/approval.js'

/**
 * 任务内唯一的授权账本：谁被批准了什么、谁被拒了、拒的理由是什么，全在这一份里。
 *
 * 一次任务一份，主执行与它派出的子执行**共享同一个对象**（子跟踪器 fork 时把引用接过去），
 * 所以批准、拒绝、收回对双方立即同时生效。任务被删除时 `dispose`，此后任何读写都抛 `EXECUTION_ABORTED`——
 * 迟到的审批回执不会把一个已删任务的授权复活。
 */
export interface TaskApprovalStateApi {
  /** 当前版本号，每次账本变动 +1；界面层拿它做「有没有变」的最廉价判断，不必比对整张记录表。 */
  getRevision(): number
  /**
   * 订阅账本变动，返回退订函数。
   *
   * 授权面板用它刷新。账本已 dispose 时返回一个空退订函数、不再回调；监听器自身抛错只记 warn，不影响其他监听器。
   */
  subscribe(listener: () => void): () => void
  /** 这个作用域此刻是不是「已批准」（拒绝与收回都算否）；任务已删除时抛 `EXECUTION_ABORTED`。 */
  has(scope: string): boolean
  /** 当前处于已批准状态的全部作用域键；供快照与「已授权哪些能力」的展示用。 */
  scopes(): string[]
  /** 已批准作用域里属于工具类别（`tool-category:` 前缀）的那些，去掉前缀后的类别 id。 */
  getApprovedToolCategories(): string[]
  /** 全部授权记录的深拷贝（含已拒绝、已收回）；界面按它渲染授权列表，改返回值不影响账本。 */
  list(): TaskApprovalRecord[]
  /**
   * 落一条审批结论：同一个 key 重复落时沿用首次分配的记录 id（界面上还是同一张卡），只改状态与理由。
   *
   * `approved` 决定记为 approved 还是 denied；`message` 是拒绝理由（空白视同没写）。落完即通知订阅者。
   */
  record(
    key: string,
    approved: boolean,
    options: ToolConfirmationDecisionOptions,
    message?: LooseOptional<string>
  ): void
  /**
   * 这个 key 是不是被拒了；是则返回给模型看的理由文案（用户没写理由时给一句默认的「请换方案或等用户改授权」）。
   *
   * 没记录或不是 denied 时返回 null，调用方据此走正常请求授权流程。
   */
  denial(key: string): Nullable<string>
  /** 这个 key 的原始状态（approved / denied / revoked）；从没记过返回 undefined，用来区分「拒过」和「还没问过」。 */
  status(key: string): TaskApprovalRecord['status'] | undefined
  /**
   * 按记录 id 收回一条授权，成功返回 true。
   *
   * 找不到或已经是 revoked 时返回 false（不重复通知订阅者）。用户在授权面板上点「收回」走这条。
   */
  revoke(id: string): boolean
  /** 任务被删除时调：清空全部记录、通知一次订阅者再摘掉全部监听；此后任何读写都抛 `EXECUTION_ABORTED`。 */
  dispose(): void
}

export class TaskApprovalState implements TaskApprovalStateApi {
  private nextId = 1
  private revision = 0
  private disposed = false
  private readonly records = new Map<string, TaskApprovalRecord>()
  private readonly listeners = new Set<() => void>()

  public getRevision(): number {
    return this.revision
  }
  public subscribe(listener: () => void): () => void {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private changed(): void {
    this.revision++
    this.listeners.forEach((listener) => {
      try {
        listener()
      } catch (error) {
        Log.tag('TaskApprovalState').warn('approval view notification failed', { error })
      }
    })
  }

  public has(scope: string): boolean {
    this.assertActive()
    return this.records.get(scope.trim())?.status === 'approved'
  }

  public scopes(): string[] {
    this.assertActive()
    return [...this.records.entries()]
      .filter(([, record]) => record.status === 'approved')
      .map(([key]) => key)
  }

  public getApprovedToolCategories(): string[] {
    return this.scopes()
      .filter((key) => key.startsWith('tool-category:'))
      .map((key) => key.slice('tool-category:'.length))
  }

  public list(): TaskApprovalRecord[] {
    this.assertActive()
    return [...this.records.values()].map((record) => ({
      ...record,
      requester: mapDefined(record.requester, (requester) => ({ ...requester })),
    }))
  }

  public record(
    key: string,
    approved: boolean,
    options: ToolConfirmationDecisionOptions,
    message?: LooseOptional<string>
  ): void {
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
      ? (record.reason ?? '用户已拒绝本次操作。请选择其他方案，或等待用户修订授权。')
      : null
  }

  public status(key: string): TaskApprovalRecord['status'] | undefined {
    this.assertActive()
    return this.records.get(key)?.status
  }

  public revoke(id: string): boolean {
    this.assertActive()
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

/** 创建一份任务范围的审批账本。 */
export function createTaskApprovalState(): TaskApprovalStateApi {
  return new TaskApprovalState()
}
