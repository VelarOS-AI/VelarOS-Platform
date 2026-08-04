import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { AgentRunEvidenceTracker } from '../src/agent/control-plane/AgentRunEvidenceTracker'
import { AgentIntentPlanner, AgentRunPlanComposer } from '../src/agent/control-plane/AgentRunPlanner'

void describe('agent run evidence gate', () => {
  void test('accepts conversational runs and rejects evidence-required runs without fresh actions', () => {
    const tracker = new AgentRunEvidenceTracker()
    assert.equal(tracker.evaluate().allowed, true)

    tracker.require({
      evidenceRequired: true,
      evidenceCategoryIds: ['system-files'],
      minimumActionIds: [],
      finishingGate: 'remind',
    })
    assert.deepEqual(tracker.evaluate(), {
      allowed: false,
      evidenceRequired: true,
      observedActionIds: [],
      missingActionIds: [],
    })

    tracker.record([{ toolName: 'context:recall', categoryId: 'general', succeeded: true }])
    assert.equal(tracker.evaluate().allowed, false)
    tracker.record([{ toolName: 'system:read', categoryId: 'system-files', succeeded: true }])
    assert.equal(tracker.evaluate().allowed, true)
  })

  void test('accumulates minimum actions across turns in one execution', () => {
    const tracker = new AgentRunEvidenceTracker()
    tracker.require({
      evidenceRequired: true,
      evidenceCategoryIds: ['system-execution', 'system-files'],
      minimumActionIds: ['system:run', 'system:write'],
      finishingGate: 'validate',
    })
    tracker.require({
      evidenceRequired: false,
      evidenceCategoryIds: [],
      minimumActionIds: [],
      finishingGate: 'none',
    })

    tracker.record([{ toolName: 'system:run', categoryId: 'system-execution', succeeded: true }])
    assert.deepEqual(tracker.evaluate().missingActionIds, ['system:write'])
    tracker.record([{ toolName: 'system:write', categoryId: 'system-files', succeeded: true }])
    assert.equal(tracker.evaluate().allowed, true)
  })

  void test('does not count failed or blocked tool calls as completion evidence', () => {
    const tracker = new AgentRunEvidenceTracker()
    tracker.require({
      evidenceRequired: true,
      evidenceCategoryIds: ['office'],
      minimumActionIds: ['office:create_spreadsheet'],
      finishingGate: 'remind',
    })

    tracker.record([
      {
        toolName: 'office:create_spreadsheet',
        categoryId: 'office',
        succeeded: false,
      },
    ])
    assert.deepEqual(tracker.evaluate(), {
      allowed: false,
      evidenceRequired: true,
      observedActionIds: [],
      missingActionIds: ['office:create_spreadsheet'],
    })
  })

  void test('passes capability scope to product classifiers and activates the evidence gate', () => {
    const planner = new AgentIntentPlanner()
    const intent = planner.plan({
      messages: [{ role: 'user', content: 'write the current output' }],
      capabilityScopeId: 'system',
      capabilityPorts: {
        intentClassifiers: [
          {
            id: 'test.workspace',
            classify: (_text, context) =>
              context?.scopeId === 'system'
                ? [
                    {
                      domainId: 'system',
                      requiresEvidence: true,
                      minimumActionIds: ['system:write'],
                    },
                  ]
                : [],
          },
        ],
      },
    })

    assert.deepEqual(intent.domains, ['system'])
    assert.equal(intent.requiresEvidence, true)
    assert.deepEqual(intent.evidenceCategoryIds, [])
    assert.deepEqual(intent.minimumActionIds, ['system:write'])
    assert.equal(
      new AgentRunPlanComposer().buildValidation(intent).finishingGate,
      'remind'
    )
  })
})
