import { describe, expect, test } from 'bun:test'

import {
  AgentGoalService,
  AgentPlanService,
  AgentQuestionService,
  type AgentSessionApplicationEvent,
  type AgentSessionEventPort,
  evaluateAgentPermissionRules,
  normalizeAgentPermissionRequest,
} from '../src/session'

class MemoryEventPort implements AgentSessionEventPort {
  readonly events = new Map<string, AgentSessionApplicationEvent[]>()
  public readEvents(sessionId: string): readonly AgentSessionApplicationEvent[] {
    return this.events.get(sessionId) ?? []
  }
  public appendEvent(sessionId: string, input: {
    readonly type: string
    readonly payload: unknown
    readonly createdAt?: number
  }): void {
    const events = this.events.get(sessionId) ?? []
    events.push({ type: input.type, payload: input.payload, createdAt: input.createdAt ?? events.length + 1 })
    this.events.set(sessionId, events)
  }
}

describe('Agent Session application services', () => {
  test('owns durable Goal and Plan transitions over a product event port', () => {
    const events = new MemoryEventPort()
    const goals = new AgentGoalService(events, () => 10, () => 'goal-1')
    expect(goals.create('session-1', 'Ship common owner').id).toBe('goal-1')
    expect(goals.update('session-1', 'complete').status).toBe('complete')

    const plans = new AgentPlanService(events)
    const draft = plans.saveDraft('session-1', { objective: 'Migrate', steps: ['Build', 'Verify'] })
    const approved = plans.approve('session-1')
    expect(approved.status).toBe('approved')
    plans.updateStep('session-1', draft.steps[0]!.id, 'in_progress')
    expect(plans.complete('session-1')).toMatchObject({
      status: 'complete',
      steps: [{ status: 'complete' }, { status: 'complete' }],
    })
  })

  test('owns one durable question channel and resolution', async () => {
    const events = new MemoryEventPort()
    const questions = new AgentQuestionService(events)
    const answer = questions.ask({
      sessionId: 'session-1',
      question: 'Proceed?',
      options: ['Proceed', 'Cancel'],
      allowCustom: false,
    })
    const pending = questions.listPending()[0]!
    questions.resolve(pending.id, 'Proceed')

    expect(await answer).toBe('Proceed')
    expect(events.readEvents('session-1').map((event) => event.type))
      .toEqual(['question.requested', 'question.resolved'])
  })

  test('owns normalized permission requests and fail-closed rule precedence', () => {
    const request = normalizeAgentPermissionRequest({
      id: 'permission-1',
      sessionId: 'session-1',
      projectRoot: '/project',
      mode: 'auto',
      permission: 'project:write',
      toolName: 'project:edit',
      patterns: ['src/*'],
      readOnly: false,
    }, { now: () => 10 })
    expect(request).toMatchObject({ risk: 'high', alwaysPatterns: ['src/*'], createdAt: 10 })
    expect(evaluateAgentPermissionRules(request, [
      { permission: 'project:*', pattern: '*', action: 'ask' },
      { permission: 'project:write', pattern: 'src/*', action: 'deny' },
    ], () => 'allow')).toEqual({ action: 'deny', source: 'rule' })
  })
})
