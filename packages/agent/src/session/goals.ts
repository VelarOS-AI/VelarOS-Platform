import { randomUUID } from 'node:crypto'

import type { AgentSessionEventPort } from './event-port'

export type AgentGoalStatus = 'active' | 'complete' | 'blocked' | 'cancelled'

export interface AgentGoal {
  readonly id: string
  readonly sessionId: string
  readonly objective: string
  readonly status: AgentGoalStatus
  readonly createdAt: number
  readonly updatedAt: number
}

export class AgentGoalService {
  public constructor(
    private readonly sessions: AgentSessionEventPort,
    private readonly now: () => number = Date.now,
    private readonly nextId: () => string = randomUUID
  ) {}

  public get(sessionId: string): AgentGoal | null {
    let goal: AgentGoal | null = null
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
    if (!normalized) throw new Error('Goal objective cannot be empty.')
    const current = this.get(sessionId)
    if (current?.status === 'active') throw new Error('An active goal already exists. Complete or cancel it first.')
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
    if (!current) throw new Error('No goal exists for this session.')
    if (current.status !== 'active') throw new Error(`Goal is already ${current.status}.`)
    this.sessions.appendEvent(sessionId, {
      type: 'goal.updated',
      payload: { id: current.id, status },
    })
    return this.get(sessionId)!
  }
}

function isGoal(value: unknown): value is AgentGoal {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.objective === 'string'
    && value.status === 'active'
    && typeof value.createdAt === 'number'
    && typeof value.updatedAt === 'number'
}

function isGoalUpdate(value: unknown): value is Pick<AgentGoal, 'id' | 'status'> {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.status === 'complete' || value.status === 'blocked' || value.status === 'cancelled')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
