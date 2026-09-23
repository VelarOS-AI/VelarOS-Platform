/**
 * 通用轮询驱动：适配器只回答「执行体现在怎么样」，预算、审批策略、稳定空闲判定与看门狗都在这里。
 * 它不认任何宿主协议——认协议的驱动由宿主实现，经 `LabDriversApi.register` 接进来。
 */
import { setTimeout as delay } from 'node:timers/promises'

import type { ObservationPhase } from '../contract/constants.js'
import type { LabDriver, PollingDriverAdapter, SettleRequest } from '../contract/requires.js'
import type {
  DriverCapabilities,
  ExecutorIdentity,
  JourneySetup,
  LegSpec,
  Observation,
  PollingDriverPolicy,
  SessionHandle,
  SessionSpec,
  SettleOutcome,
} from '../types/agent-lab.js'
import { exceededBudget } from '../utils/budget.js'

export class PollingDriver implements LabDriver {
  /** 按策略拒绝一次审批时发给被测执行体的理由；它是模型看得到的文字。 */
  private static readonly RejectionMessage = '评测策略拒绝了这个操作'

  /** 调用方中断时报出去的说明。 */
  private static readonly InterruptedDetail = '运行被中断信号终止'

  /** 每个会话上一次收敛时看到的原生栅栏，用来判断这一段有没有推进。 */
  private readonly fences = new Map<string, string | null>()

  constructor(
    private readonly adapter: PollingDriverAdapter,
    private readonly policy: PollingDriverPolicy
  ) {}

  public get id(): string {
    return this.adapter.id
  }

  public capabilities(): Promise<DriverCapabilities> {
    return this.adapter.capabilities()
  }

  public identity(): Promise<ExecutorIdentity> {
    return this.adapter.identity()
  }

  public async openSession(spec: SessionSpec): Promise<SessionHandle> {
    const session = await this.adapter.openSession(spec)
    const initial = await this.adapter.readState(session)
    this.fences.set(session.id, initial.revision)
    return session
  }

  public prepare(session: SessionHandle, setup: JourneySetup | null): Promise<void> {
    return this.adapter.prepare(session, setup)
  }

  public send(session: SessionHandle, leg: LegSpec): Promise<void> {
    return this.adapter.send(session, leg)
  }

  public collect(session: SessionHandle, phase: ObservationPhase): Promise<Observation> {
    return this.adapter.collect(session, phase)
  }

  public abort(session: SessionHandle, reason: string): Promise<void> {
    return this.adapter.abort(session, reason)
  }

  public async closeSession(session: SessionHandle): Promise<void> {
    this.fences.delete(session.id)
    await this.adapter.closeSession(session)
  }

  public async waitSettled(session: SessionHandle, request: SettleRequest): Promise<SettleOutcome> {
    const startedAt = Date.now()
    const wallClockLimit = request.budget.wallClockMs ?? this.policy.defaultWallClockMs
    const deadline = startedAt + wallClockLimit
    const beforeRevision = this.fences.get(session.id) ?? null
    let stablePolls = 0
    let sawRunning = false

    while (Date.now() <= deadline) {
      if (request.signal.aborted)
        return {
          kind: 'unavailable',
          cause: 'interrupted',
          detail: PollingDriver.InterruptedDetail,
        }
      const state = await this.adapter.readState(session)
      if (state.unavailable)
        return { kind: 'unavailable', cause: 'agent-unavailable', detail: state.unavailable.detail }
      sawRunning ||= state.running

      if (state.awaitingConfirmation) {
        if (this.policy.confirmation === 'wait' || !this.adapter.resolveConfirmation)
          return { kind: 'awaiting-input' }
        const approved = this.policy.confirmation === 'approve'
        await this.adapter.resolveConfirmation(
          session,
          approved,
          approved ? null : PollingDriver.RejectionMessage,
          state.confirmationId
        )
        stablePolls = 0
        const interrupted = await this.pause(request)
        if (interrupted) return interrupted
        continue
      }
      if (state.awaitingInput) return { kind: 'awaiting-input' }

      const observation = await this.adapter.collect(session, state.running ? 'running' : 'idle')
      const usage = {
        ...state.usage,
        wallClockMs: Math.max(state.usage.wallClockMs ?? 0, Date.now() - startedAt),
      }
      const decision = await request.onSample({ observation, usage })
      if (decision.kind === 'abort')
        return { kind: 'aborted', detectorId: decision.detectorId, reason: decision.reason }
      const budgetLimit = exceededBudget(usage, request.budget)
      if (budgetLimit) return { kind: 'budget-exhausted', limit: budgetLimit }

      const revisionAdvanced = state.revision !== null && state.revision !== beforeRevision
      const completed = !state.running && (revisionAdvanced || sawRunning)
      stablePolls = completed ? stablePolls + 1 : 0
      if (stablePolls >= Math.max(1, this.policy.settlePolls)) {
        this.fences.set(session.id, state.revision)
        return { kind: 'settled' }
      }
      const interrupted = await this.pause(request)
      if (interrupted) return interrupted
    }
    return { kind: 'timeout' }
  }

  /** 等一个轮询间隔；等的过程中被中断就把「中断」这个结局交回去，不把中断当成别的失败。 */
  private async pause(request: SettleRequest): Promise<SettleOutcome | null> {
    try {
      await delay(this.policy.pollMs, undefined, { signal: request.signal })
      return null
    } catch (error) {
      if (request.signal.aborted)
        return {
          kind: 'unavailable',
          cause: 'interrupted',
          detail: PollingDriver.InterruptedDetail,
        }
      throw error
    }
  }
}
