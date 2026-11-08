import { describe, expect, test } from 'bun:test'

import type { CampaignEvidence, CampaignRootCauseClass } from '../src/index.js'
import { adaptiveCampaign, labWire } from '../src/index.js'

function task(id: string, overrides: Record<string, unknown> = {}) {
  return labWire.parseRealTaskCase({
    schema: 'agent-lab/real-task-case@3',
    id,
    version: 1,
    createdAt: 1,
    origin: {
      kind: 'curated',
      rationale: 'deterministic real task',
      references: [{ title: 'source', url: 'https://example.com' }],
    },
    title: id,
    prompt: `complete ${id}`,
    source: 'curated',
    surface: 'system',
    coverage: {
      capability: `system.${id}`,
      objective: `complete ${id}`,
      archetype: 'transform',
      dataShapes: ['text'],
      risk: 'reversible-write',
      lifecycle: 'multi-step',
      path: 'happy',
      interaction: 'autonomous',
      modelRequirement: 'text',
      dailyWeight: 1,
      ...((overrides.coverage as object | undefined) ?? {}),
    },
    workspace: { adapter: 'fixture', parameters: {}, reference: 'v1', digest: null },
    acceptance: [{ id: 'truth', kind: 'file', description: 'truth', parameters: {}, gate: true }],
    privacy: { classification: 'shareable', reviewNote: 'synthetic' },
    labels: [],
  })
}

function fixedFailure(classification: CampaignRootCauseClass, proofTaskIds: readonly string[]) {
  const initial = adaptiveCampaign.recordFailure({
    failures: [],
    key: `${classification}:fixture`,
    classification,
    capability: 'system.write',
    taskId: 'a',
    detail: 'fixture failure',
    now: 1,
  })[0]!
  const diagnosed = adaptiveCampaign.transitionFailure({
    failure: initial,
    state: 'diagnosed',
    rootCause: 'proof fixture root cause',
  })
  return adaptiveCampaign.transitionFailure({
    failure: diagnosed,
    state: 'fixed',
    fixReference: 'commit:local',
    proofTaskIds,
  })
}

describe('adaptive real-task campaign', () => {
  test('rejects duplicate revision claims before sampling or a blocked-failure short circuit', () => {
    const cases = [task('a'), task('b')]
    const failures = adaptiveCampaign.recordFailure({
      failures: [],
      key: 'revision:fixture',
      classification: 'evaluation-design',
      capability: 'system.a',
      taskId: 'a',
      detail: 'unresolved fixture',
      now: 1,
    })
    for (const revision of ['r1', 'r2']) {
      const claims = [
        { taskId: 'a', revision: 'r1' },
        { taskId: 'a', revision },
        { taskId: 'b', revision: 'r1' },
      ]
      for (const revisions of [claims, [...claims].reverse()]) {
        for (const pendingFailures of [[], failures]) {
          expect(() =>
            adaptiveCampaign.selectTasks({
              cases,
              revisions,
              evidence: [],
              failures: pendingFailures,
              limit: 2,
            })
          ).toThrow('每条战役用例必须且只能有一个修订版')
        }
      }
    }
    for (const revisions of [
      [{ taskId: 'a', revision: 'r1' }],
      [
        { taskId: 'a', revision: 'r1' },
        { taskId: 'unknown', revision: 'r1' },
      ],
    ])
      expect(() =>
        adaptiveCampaign.selectTasks({ cases, revisions, evidence: [], failures: [], limit: 2 })
      ).toThrow()

    const selection = adaptiveCampaign.selectTasks({
      cases,
      revisions: cases.map((entry) => ({ taskId: entry.id, revision: 'r2' })),
      evidence: [
        { taskId: 'a', taskRevision: 'r1', outcome: 'pass', failureKey: null, updatedAt: 99 },
        { taskId: 'a', taskRevision: 'r2', outcome: 'pass', failureKey: null, updatedAt: 1 },
        {
          taskId: 'a',
          taskRevision: 'r2',
          outcome: 'fail',
          failureKey: 'revision:fixture',
          updatedAt: 2,
        },
        { taskId: 'b', taskRevision: 'r2', outcome: 'pass', failureKey: null, updatedAt: 1 },
      ],
      failures: [],
      limit: 2,
    })
    expect(selection.reusedTaskIds).toEqual(['b'])
    expect(selection.selected.map((entry) => entry.id)).toEqual(['a'])
  })

  test('reuses current passes and chooses diverse unseen evidence', () => {
    const cases = [
      task('a'),
      task('b', { coverage: { archetype: 'inspect', dataShapes: ['tree'], path: 'boundary' } }),
      task('c'),
    ]
    const selection = adaptiveCampaign.selectTasks({
      cases,
      revisions: cases.map((entry) => ({ taskId: entry.id, revision: 'r1' })),
      evidence: [
        { taskId: 'a', taskRevision: 'r1', outcome: 'pass', failureKey: null, updatedAt: 1 },
      ],
      failures: [],
      limit: 1,
    })

    expect(selection.reusedTaskIds).toEqual(['a'])
    expect(selection.selected.map((entry) => entry.id)).toEqual(['b'])
  })

  test('halts new sampling until a failure is diagnosed and fixed', () => {
    const cases = [task('a'), task('b')]
    const failures = adaptiveCampaign.recordFailure({
      failures: [],
      key: 'tool-contract:alias',
      classification: 'tool-contract',
      capability: 'system.a',
      taskId: 'a',
      detail: 'invalid provider tool name',
      now: 1,
    })
    const blocked = adaptiveCampaign.selectTasks({
      cases,
      revisions: cases.map((entry) => ({ taskId: entry.id, revision: 'r1' })),
      evidence: [],
      failures,
      limit: 10,
    })
    expect(blocked.selected).toEqual([])
    expect(blocked.blockedFailureKeys).toEqual(['tool-contract:alias'])
  })

  test('requires diagnosis, a fix reference, and independent proof before closing', () => {
    const initial = adaptiveCampaign.recordFailure({
      failures: [],
      key: 'validation:shape',
      classification: 'parameter-validation',
      capability: 'system.write',
      taskId: 'a',
      detail: 'invalid arguments',
      now: 1,
    })[0]!
    const diagnosed = adaptiveCampaign.transitionFailure({
      failure: initial,
      state: 'diagnosed',
      rootCause: 'schema allowed an ambiguous union',
    })
    const fixed = adaptiveCampaign.transitionFailure({
      failure: diagnosed,
      state: 'fixed',
      fixReference: 'commit:local',
      proofTaskIds: ['a', 'b'],
    })
    const first = adaptiveCampaign.recordProof(fixed, 'a')
    const second = adaptiveCampaign.recordProof(first, 'b')

    expect(first.state).toBe('proving')
    expect(second.state).toBe('closed')
    expect(second.passedProofTaskIds).toEqual(['a', 'b'])
  })

  test('rejects direct closed transitions even after a real partial proof', () => {
    const fixed = fixedFailure('parameter-validation', ['a', 'b'])
    const partial = adaptiveCampaign.recordProof(fixed, 'a')
    const closed = adaptiveCampaign.recordProof(partial, 'b')

    for (const failure of [fixed, partial, closed]) {
      const forbidden = { failure, state: 'closed' } as const
      expect(() => {
        // @ts-expect-error closed 只能由证明产生，普通流转不接受该目标。
        adaptiveCampaign.transitionFailure(forbidden)
      }).toThrow('失败账不允许这样流转')
    }
    expect(fixed.state).toBe('fixed')
    expect(partial.state).toBe('proving')
    expect(partial.passedProofTaskIds).toEqual(['a'])
    expect(closed.state).toBe('closed')
    expect(closed.passedProofTaskIds).toEqual(['a', 'b'])
  })

  test('counts only distinct planned identities toward default and volatile proof thresholds', () => {
    for (const [classification, proofTaskIds] of [
      ['parameter-validation', ['a', 'b']],
      ['model', ['a', 'b', 'c']],
      ['runtime', ['a', 'b', 'c']],
    ] as const) {
      expect(() =>
        fixedFailure(
          classification,
          proofTaskIds.map(() => 'a')
        )
      ).toThrow('互不相同')
      const fixed = fixedFailure(classification, proofTaskIds)
      let current = fixed
      expect(adaptiveCampaign.recordProof(current, 'unplanned')).toBe(current)
      for (let index = 0; index < proofTaskIds.length; index += 1) {
        const taskId = proofTaskIds[index]!
        current = adaptiveCampaign.recordProof(current, taskId)
        expect(current.passedProofTaskIds).toEqual(proofTaskIds.slice(0, index + 1))
        expect(current.state).toBe(index === proofTaskIds.length - 1 ? 'closed' : 'proving')
        expect(adaptiveCampaign.recordProof(current, taskId)).toEqual(current)
        expect(adaptiveCampaign.recordProof(current, 'unplanned')).toBe(current)
      }
      expect(fixed.passedProofTaskIds).toEqual([])
    }
  })

  test('revokes stale proof after a ledger rebase and allows a replacement proof plan', () => {
    const fixed = fixedFailure('evaluation-design', ['a', 'removed-task'])
    const proven = adaptiveCampaign.recordProof(
      adaptiveCampaign.recordProof(fixed, 'a'),
      'removed-task'
    )
    expect(proven.state).toBe('closed')
    const cases = [task('a'), task('replacement-task')]
    const revisions = cases.map((entry) => ({ taskId: entry.id, revision: 'r2' }))
    const evidence: CampaignEvidence[] = [
      { taskId: 'a', taskRevision: 'r1', outcome: 'pass', failureKey: null, updatedAt: 1 },
      {
        taskId: 'removed-task',
        taskRevision: 'r1',
        outcome: 'pass',
        failureKey: null,
        updatedAt: 1,
      },
      {
        taskId: 'replacement-task',
        taskRevision: 'r1',
        outcome: 'pass',
        failureKey: null,
        updatedAt: 1,
      },
    ]
    const rebased = adaptiveCampaign.selectTasks({
      cases,
      revisions,
      evidence,
      failures: [proven],
      limit: 2,
    })
    expect(rebased.reusedTaskIds).toEqual([])

    const invalidated = adaptiveCampaign.reconcileProof(proven, new Set(rebased.reusedTaskIds))
    expect(invalidated.state).toBe('fixed')
    expect(invalidated.passedProofTaskIds).toEqual([])
    expect(invalidated.fixReference).toBe(proven.fixReference)

    const revised = adaptiveCampaign.transitionFailure({
      failure: invalidated,
      state: 'fixed',
      fixReference: 'verifier:line-ending',
      proofTaskIds: ['a', 'replacement-task'],
    })
    const currentEvidence: CampaignEvidence[] = [
      ...evidence,
      { taskId: 'a', taskRevision: 'r2', outcome: 'pass', failureKey: null, updatedAt: 2 },
    ]
    const partialSelection = adaptiveCampaign.selectTasks({
      cases,
      revisions,
      evidence: currentEvidence,
      failures: [revised],
      limit: 2,
    })
    expect(partialSelection.reusedTaskIds).toEqual(['a'])
    const partial = adaptiveCampaign.reconcileProof(
      revised,
      new Set(partialSelection.reusedTaskIds)
    )
    expect(partial.state).toBe('proving')
    expect(partial.passedProofTaskIds).toEqual(['a'])

    const completeSelection = adaptiveCampaign.selectTasks({
      cases,
      revisions,
      failures: [partial],
      limit: 2,
      evidence: [
        ...currentEvidence,
        {
          taskId: 'replacement-task',
          taskRevision: 'r2',
          outcome: 'pass',
          failureKey: null,
          updatedAt: 3,
        },
      ],
    })
    expect(completeSelection.reusedTaskIds).toEqual(['a', 'replacement-task'])
    const closed = adaptiveCampaign.reconcileProof(
      partial,
      new Set(completeSelection.reusedTaskIds)
    )
    expect(closed.state).toBe('closed')
    expect(closed.passedProofTaskIds).toEqual(['a', 'replacement-task'])
  })

  test('reopens a closed notebook entry on recurrence', () => {
    const fixed = fixedFailure('runtime', ['a', 'b', 'c'])
    const closed = ['a', 'b', 'c'].reduce(
      (failure, taskId) => adaptiveCampaign.recordProof(failure, taskId),
      fixed
    )
    expect(closed.state).toBe('closed')
    const repeated = adaptiveCampaign.recordFailure({
      failures: [closed],
      key: closed.key,
      classification: 'runtime',
      capability: closed.capability,
      taskId: 'd',
      detail: 'timeout again',
      now: 2,
    })[0]!

    expect(repeated.state).toBe('open')
    expect(repeated.occurrences).toBe(2)
    expect(repeated.passedProofTaskIds).toEqual([])
    expect(repeated.affectedTaskIds).toEqual(['a', 'd'])
    expect(repeated.lastSeenAt).toBe(2)
    expect(adaptiveCampaign.recordProof(repeated, 'a')).toBe(repeated)
    expect(adaptiveCampaign.reconcileProof(repeated, new Set(['a', 'b', 'c']))).toBe(repeated)
  })
})
