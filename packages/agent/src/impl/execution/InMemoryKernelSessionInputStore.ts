import { isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { KernelSessionInputStore } from '../../contract/requires.js'
import type { AdmitKernelSessionInput, KernelAdmittedInput, KernelSessionInputSnapshot, PromoteKernelInputOptions } from '../../types/execution.js'
import { assertInputContent, cloneInput, cloneSnapshot, isSameAdmission, sortInputs } from '../../utils/execution/session-lane'

/**
 * 内存版会话输入账本的对外面：在 `KernelSessionInputStore` 之上多一个 `snapshot`。
 *
 * 落盘版把它当内核用（每次写完取一份快照交给持久化层），所以快照必须留在接口里；
 * 而快照不属于通用的输入账本合同——别的实现没有义务提供它，因此只写在这一层。
 */
export interface InMemoryKernelSessionInputStoreApi extends KernelSessionInputStore {
  /** 导出当前全量输入的深拷贝，按 sessionId、seq 稳定排序。给落盘版在每次写入后取一份用；调用方拿到的是副本，改它不影响账本。 */
  snapshot(): KernelSessionInputSnapshot
}

export class InMemoryKernelSessionInputStore implements InMemoryKernelSessionInputStoreApi {
  private readonly inputsBySession = new Map<string, KernelAdmittedInput[]>()
  private readonly seqBySession = new Map<string, number>()

  public constructor(snapshot?: LooseOptional<KernelSessionInputSnapshot>) {
    const seenIds = new Set<string>()
    for (const input of cloneSnapshot(snapshot).inputs) {
      const sessionInputs = this.inputsBySession.get(input.sessionId) ?? []
      if (seenIds.has(input.id)) {
        throw new AppError(
          'VALIDATION',
          `快照里的会话输入 "${input.id}" 出现了两次：输入 id 在一份快照内必须唯一，重复会让重放出的输入序列与真实历史对不上。`,
          undefined,
          { inputId: input.id }
        )
      }
      seenIds.add(input.id)
      sessionInputs.push(input)
      this.inputsBySession.set(input.sessionId, sessionInputs)
      this.seqBySession.set(
        input.sessionId,
        Math.max(this.seqBySession.get(input.sessionId) ?? 0, input.seq)
      )
    }

    for (const inputs of this.inputsBySession.values()) {
      inputs.sort((left, right) => left.seq - right.seq)
    }
  }

  public admit(input: AdmitKernelSessionInput): KernelAdmittedInput {
    assertInputContent(input)

    const role = input.role ?? 'user'
    const delivery = input.delivery ?? 'queue'
    if (input.id) {
      const existing = this.findInputById(input.id)
      if (existing) {
        if (isSameAdmission(existing, input, role, delivery)) return cloneInput(existing)
        throw new AppError('INVARIANT', `会话输入 "${input.id}" 已经被准入过，且这次的内容与上次不一致：同一个输入 id 只能准入一次，要改内容请换一个 id。`)
      }
    }

    const seq = (this.seqBySession.get(input.sessionId) ?? 0) + 1
    const id = input.id ?? `${input.sessionId}:input:${seq}`
    if (this.findInputById(id)) {
      throw new AppError('INVARIANT', `自动分配出的会话输入 id "${id}" 已经被占用：序号分配与既有输入撞车了，这是实现缺陷，不是用户操作错误。`)
    }
    const sessionInputs = this.inputsBySession.get(input.sessionId) ?? []

    const admitted: KernelAdmittedInput = {
      id,
      sessionId: input.sessionId,
      seq,
      role,
      content: input.content,
      delivery,
      status: 'admitted',
      createdAt: input.createdAt ?? Date.now(),
    }
    if (isPresent(input.metadata)) {
      admitted.metadata = { ...input.metadata }
    }

    sessionInputs.push(admitted)
    this.inputsBySession.set(input.sessionId, sessionInputs)
    this.seqBySession.set(input.sessionId, seq)

    return cloneInput(admitted)
  }

  private findInputById(id: string): Nullable<KernelAdmittedInput> {
    for (const inputs of this.inputsBySession.values()) {
      const input = inputs.find((candidate) => candidate.id === id)
      if (input) return input
    }
    return null
  }

  public list(sessionId: string): KernelAdmittedInput[] {
    return (this.inputsBySession.get(sessionId) ?? []).map(cloneInput)
  }

  public countPending(sessionId: string): number {
    return (this.inputsBySession.get(sessionId) ?? []).filter(
      (input) => input.status === 'admitted'
    ).length
  }

  public promoteSteers(
    sessionId: string,
    options: PromoteKernelInputOptions = {}
  ): KernelAdmittedInput[] {
    const promotedAt = Date.now()
    const sessionInputs = this.inputsBySession.get(sessionId) ?? []
    const promoted: KernelAdmittedInput[] = []

    for (const input of sessionInputs) {
      if (input.status !== 'admitted' || input.delivery !== 'steer') {
        continue
      }
      if (isPresent(options.inputId) && input.id !== options.inputId) {
        continue
      }
      if (isPresent(options.cutoffSeq) && input.seq > options.cutoffSeq) {
        continue
      }
      input.status = 'promoted'
      input.promotedAt = promotedAt
      promoted.push(cloneInput(input))
    }

    return promoted
  }

  public promoteNextQueued(sessionId: string): Nullable<KernelAdmittedInput> {
    const sessionInputs = this.inputsBySession.get(sessionId) ?? []
    const input = sessionInputs.find(
      (candidate) => candidate.status === 'admitted' && candidate.delivery === 'queue'
    )
    if (!input) return null

    input.status = 'promoted'
    input.promotedAt = Date.now()
    return cloneInput(input)
  }

  public cancel(sessionId: string, inputId?: string): number {
    const sessionInputs = this.inputsBySession.get(sessionId) ?? []
    const cancelledAt = Date.now()
    let cancelled = 0

    for (const input of sessionInputs) {
      // 指定 inputId 的安全吊销允许撤回刚刚 promote、但尚未被下一轮消费的输入；
      // 未指定 id 的普通 cancel 仍只影响排队中的 admitted 输入。
      const canCancel =
        input.status === 'admitted' || (isPresent(inputId) && input.status === 'promoted')
      if (!canCancel) {
        continue
      }
      if (isPresent(inputId) && input.id !== inputId) {
        continue
      }
      input.status = 'cancelled'
      input.cancelledAt = cancelledAt
      cancelled += 1
    }

    return cancelled
  }

  public dropSession(sessionId: string): number {
    const existing = this.inputsBySession.get(sessionId) ?? []
    this.inputsBySession.delete(sessionId)
    this.seqBySession.delete(sessionId)
    return existing.length
  }

  public snapshot(): KernelSessionInputSnapshot {
    return {
      inputs: sortInputs(
        [...this.inputsBySession.values()].flatMap((inputs) => inputs.map(cloneInput))
      ),
    }
  }
}
