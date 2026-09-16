import { randomUUID } from 'node:crypto'

import { isNumber, isPlainObject, isString } from '@velaros-ai/core'

import type { AgentSessionEventPort } from '../../contract/requires.js'
import type { AgentGoal,AgentGoalStatus } from '../../types/product-session.js'

/**
 * 会话目标服务：一个会话同时只允许有一个「进行中」的目标，目标本身不单独存库，
 * 而是以 `goal.created` / `goal.updated` 两种事件写进会话事件流，读的时候按事件顺序重放出当前状态。
 *
 * 实现是 `AgentGoalService`，由产品侧会话层持有；写入失败按 `Error` 抛出，调用方自己决定是否提示用户。
 */
export interface AgentGoalServiceApi {
  /** 重放这个会话的事件流，给出当前那个目标；从来没建过目标时返回 null。 */
  get(sessionId: string): Nullable<AgentGoal>
  /** 新建目标：`objective` 去掉首尾空白后不能为空，且这个会话上不能已经有 `active` 的目标，两条任一不满足都抛错。成功时追加 `goal.created` 并返回刚建好的目标。 */
  create(sessionId: string, objective: string): AgentGoal
  /** 把当前目标改成一个终态（`complete` / `blocked` / `cancelled`）：没有目标、或目标已经不是 `active` 时抛错。成功时追加 `goal.updated` 并返回重放后的目标。 */
  update(sessionId: string, status: Exclude<AgentGoalStatus, 'active'>): AgentGoal
}

export class AgentGoalService implements AgentGoalServiceApi {
  public constructor(
    private readonly sessions: AgentSessionEventPort,
    private readonly now: () => number = Date.now,
    private readonly nextId: () => string = randomUUID
  ) {}

  public get(sessionId: string): Nullable<AgentGoal> {
    let goal: Nullable<AgentGoal> = null
    for (const event of this.sessions.readEvents(sessionId)) {
      if (event.type === 'goal.created' && isGoal(event.payload)) goal = event.payload
      if (event.type === 'goal.updated' && goal && isGoalUpdate(event.payload)) {
        goal = { ...goal, ...event.payload, updatedAt: event.createdAt }
      }
    }
    return goal
  }

  public create(sessionId: string, objective: string): AgentGoal {
    const normalized = objective.trim()
    if (!normalized) throw new Error('目标描述不能为空：去掉首尾空白后至少要留下一句话，说明这个会话要达成什么。')
    const current = this.get(sessionId)
    if (current?.status === 'active') throw new Error('这个会话已经有一个进行中的目标，同一时刻只允许有一个。请先把它 complete 或 cancel，再建新目标。')
    const now = this.now()
    const goal: AgentGoal = {
      id: this.nextId(),
      sessionId,
      objective: normalized,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }
    this.sessions.appendEvent(sessionId, { type: 'goal.created', payload: goal, createdAt: now })
    return goal
  }

  public update(sessionId: string, status: Exclude<AgentGoalStatus, 'active'>): AgentGoal {
    const current = this.get(sessionId)
    if (!current) throw new Error('这个会话还没建过目标，没有可更新的对象：请先创建目标。')
    if (current.status !== 'active') throw new Error(`目标已经是 ${current.status} 终态，不能再改状态：只有 active 的目标才允许更新。`)
    this.sessions.appendEvent(sessionId, {
      type: 'goal.updated',
      payload: { id: current.id, status },
    })
    return this.get(sessionId)!
  }
}

function isGoal(value: unknown): value is AgentGoal {
  return isRecord(value)
    && isString(value.id)
    && isString(value.sessionId)
    && isString(value.objective)
    && value.status === 'active'
    && isNumber(value.createdAt)
    && isNumber(value.updatedAt)
}

function isGoalUpdate(value: unknown): value is Pick<AgentGoal, 'id' | 'status'> {
  return isRecord(value)
    && isString(value.id)
    && (value.status === 'complete' || value.status === 'blocked' || value.status === 'cancelled')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value)
}
