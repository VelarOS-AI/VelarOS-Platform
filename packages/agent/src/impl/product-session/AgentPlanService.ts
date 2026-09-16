import { randomUUID } from 'node:crypto'

import type { AgentSessionEventPort } from '../../contract/requires.js'
import type { AgentPlan, AgentPlanStepStatus } from '../../types/product-session.js'
import { createSteps, freezePlan, isPlan, isPlanDraft, isPlanStepUpdate, isRecord, normalizeSteps, requireText, stringValue } from '../../utils/product-session/plans'

/**
 * 会话计划服务：一个会话同时只有一份计划，计划不单独存库，而是以 `plan.*` 系列事件写进会话事件流，
 * 读的时候按事件顺序重放出当前状态，返回前统一冻结，调用方拿到的都是只读快照。
 *
 * 状态流转是 draft → approved → complete / cancelled；approved 期间不许改写计划本身，只许推进步骤。
 * 实现是 `AgentPlanService`，产品侧会话层持一份；违反流转的调用一律抛 `Error`。
 */
export interface AgentPlanServiceApi {
  /** 重放这个会话的事件流，给出当前那份计划；从来没存过草稿时返回 null。 */
  get(sessionId: string): Nullable<AgentPlan>
  /** 存一份计划草稿：目标和步骤文本都不能为空。当前计划已 `approved` 时抛错（得先完成或取消）；没有计划、或上一份已经 complete / cancelled 时新建一份，否则改写现有这份并把状态打回 draft、清掉上次的审阅意见。 */
  saveDraft(sessionId: string, input: { readonly objective: string; readonly steps: readonly string[] }): AgentPlan
  /** 批准草稿：当前必须是 draft，否则抛错。批准后计划进入执行态，只能推进步骤，不能再改写。 */
  approve(sessionId: string): AgentPlan
  /** 打回草稿：当前必须是 draft，否则抛错。`feedback` 是给模型看的修改意见，留空时不记意见，计划仍停在 draft。 */
  reject(sessionId: string, feedback?: string): AgentPlan
  /** 推进某个步骤的状态：计划必须已 `approved`，且 `stepId` 必须是这份计划里的步骤，否则抛错。这是执行期唯一的写入口。 */
  updateStep(sessionId: string, stepId: string, status: AgentPlanStepStatus): AgentPlan
  /** 把计划整体收成 complete：当前必须是 `approved`，否则抛错。除了已 skipped 的步骤，其余步骤一并置为 complete。 */
  complete(sessionId: string): AgentPlan
  /** 取消计划：已经 complete 或 cancelled 时抛错；draft 和 approved 都可以取消。 */
  cancel(sessionId: string): AgentPlan
  /** 和 `get` 一样重放，但没有计划时直接抛错；调用方确定这会话该有计划时用它，省掉一次判空。 */
  require(sessionId: string): AgentPlan
}

export class AgentPlanService implements AgentPlanServiceApi {
  public constructor(private readonly sessions: AgentSessionEventPort) {}

  public get(sessionId: string): Nullable<AgentPlan> {
    let plan: Nullable<AgentPlan> = null
    for (const event of this.sessions.readEvents(sessionId)) {
      if (event.type === 'plan.created' && isPlan(event.payload)) {
        plan = { ...event.payload, sessionId }
        continue
      }
      if (!plan || !isRecord(event.payload) || event.payload.id !== plan.id) continue
      if (event.type === 'plan.drafted' && isPlanDraft(event.payload)) {
        plan = {
          ...plan,
          objective: event.payload.objective,
          steps: event.payload.steps,
          status: 'draft',
          reviewFeedback: null,
          updatedAt: event.createdAt,
        }
      } else if (event.type === 'plan.approved') {
        plan = { ...plan, status: 'approved', reviewFeedback: null, updatedAt: event.createdAt }
      } else if (event.type === 'plan.rejected') {
        plan = {
          ...plan,
          status: 'draft',
          reviewFeedback: stringValue(event.payload.feedback),
          updatedAt: event.createdAt,
        }
      } else if (event.type === 'plan.step.updated' && isPlanStepUpdate(event.payload)) {
        const update = event.payload
        plan = {
          ...plan,
          steps: plan.steps.map((step) => step.id === update.stepId
            ? { ...step, status: update.status }
            : step),
          updatedAt: event.createdAt,
        }
      } else if (event.type === 'plan.completed') {
        plan = {
          ...plan,
          status: 'complete',
          steps: plan.steps.map((step) => step.status === 'skipped'
            ? step
            : { ...step, status: 'complete' as const }),
          updatedAt: event.createdAt,
        }
      } else if (event.type === 'plan.cancelled') {
        plan = { ...plan, status: 'cancelled', updatedAt: event.createdAt }
      }
    }
    return plan ? freezePlan(plan) : null
  }

  public saveDraft(
    sessionId: string,
    input: { readonly objective: string; readonly steps: readonly string[] },
  ): AgentPlan {
    const objective = requireText(input.objective, '计划目标')
    const stepTexts = normalizeSteps(input.steps)
    const current = this.get(sessionId)
    if (current?.status === 'approved') {
      throw new Error('当前计划已批准并进入执行态，不能直接被新草稿覆盖。请先把这一份 complete 或 cancel 掉，再存新的计划草稿。')
    }
    const now = Date.now()
    if (!current || current.status === 'complete' || current.status === 'cancelled') {
      const plan: AgentPlan = {
        id: randomUUID(),
        sessionId,
        objective,
        steps: createSteps(stepTexts),
        status: 'draft',
        reviewFeedback: null,
        createdAt: now,
        updatedAt: now,
      }
      this.sessions.appendEvent(sessionId, { type: 'plan.created', payload: plan, createdAt: now })
      return freezePlan(plan)
    }
    this.sessions.appendEvent(sessionId, {
      type: 'plan.drafted',
      payload: { id: current.id, objective, steps: createSteps(stepTexts) },
      createdAt: now,
    })
    return this.get(sessionId)!
  }

  public approve(sessionId: string): AgentPlan {
    const plan = this.requireDraft(sessionId)
    this.sessions.appendEvent(sessionId, { type: 'plan.approved', payload: { id: plan.id } })
    return this.get(sessionId)!
  }

  public reject(sessionId: string, feedback?: string): AgentPlan {
    const plan = this.requireDraft(sessionId)
    this.sessions.appendEvent(sessionId, {
      type: 'plan.rejected',
      payload: { id: plan.id, feedback: feedback?.trim() || null },
    })
    return this.get(sessionId)!
  }

  public updateStep(
    sessionId: string,
    stepId: string,
    status: AgentPlanStepStatus,
  ): AgentPlan {
    const plan = this.require(sessionId)
    if (plan.status !== 'approved') throw new Error(`计划当前是 ${plan.status}，还不能记录执行进度：步骤状态只在计划被批准之后才允许推进，请先批准这份计划。`)
    const normalizedId = requireText(stepId, '计划步骤 id')
    if (!plan.steps.some((step) => step.id === normalizedId)) throw new Error(`这份计划里没有步骤 ${normalizedId}：stepId 必须取自当前计划的 steps，草稿被改写过之后旧的 stepId 就失效了，请重新读一次计划再推进。`)
    this.sessions.appendEvent(sessionId, {
      type: 'plan.step.updated',
      payload: { id: plan.id, stepId: normalizedId, status },
    })
    return this.get(sessionId)!
  }

  public complete(sessionId: string): AgentPlan {
    const plan = this.require(sessionId)
    if (plan.status !== 'approved') throw new Error(`只有已批准的计划才能整体收成 complete，当前计划是 ${plan.status}。`)
    this.sessions.appendEvent(sessionId, { type: 'plan.completed', payload: { id: plan.id } })
    return this.get(sessionId)!
  }

  public cancel(sessionId: string): AgentPlan {
    const plan = this.require(sessionId)
    if (plan.status === 'complete' || plan.status === 'cancelled') {
      throw new Error(`计划已经是 ${plan.status} 终态，不能再取消：终态计划不接受任何状态变更。`)
    }
    this.sessions.appendEvent(sessionId, { type: 'plan.cancelled', payload: { id: plan.id } })
    return this.get(sessionId)!
  }

  public require(sessionId: string): AgentPlan {
    const plan = this.get(sessionId)
    if (!plan) throw new Error('这个会话还没有任何计划：请先存一份计划草稿，再来读取或推进它。')
    return plan
  }

  private requireDraft(sessionId: string): AgentPlan {
    const plan = this.require(sessionId)
    if (plan.status !== 'draft') throw new Error(`计划当前是 ${plan.status}，批准和打回只对 draft 有效：想改已批准的计划，请先 cancel 再重新起草。`)
    return plan
  }
}






















