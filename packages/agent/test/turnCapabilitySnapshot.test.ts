import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  captureAgentTurnCapabilityContext,
  captureAgentTurnCapabilitySnapshot,
} from '../src/agent/TurnCapabilitySnapshot'
import {
  ToolExecutionPolicy,
  type ToolExecutionPolicyRegistry,
} from '../src/tools/ExecutionPolicy'

void describe('agent turn capability snapshot', () => {
  void test('captures the registry once and freezes query descriptor projections', () => {
    let captures = 0
    const frozenRegistry = { id: 'turn-1' }
    const liveRegistry = {
      id: 'live',
      captureTurnCapabilitySnapshot: () => {
        captures += 1
        return frozenRegistry
      },
    }
    const snapshot = captureAgentTurnCapabilitySnapshot(liveRegistry)
    assert.equal(snapshot, frozenRegistry)
    assert.equal(captures, 1)

    let enabledTools = [{ name: 'old_tool' }]
    let visibleNames = ['old_tool']
    const context = {
      listTools: () => enabledTools,
      listToolCategories: () => [{ category: { id: 'general' }, tools: enabledTools }],
      getCurrentVisibleToolNames: () => visibleNames,
      setCurrentVisibleToolNames: (names: string[]) => {
        visibleNames = names
      },
    }
    const contextSnapshot = captureAgentTurnCapabilityContext(context)
    enabledTools = [{ name: 'new_tool' }]

    assert.deepEqual(contextSnapshot.listTools(), [{ name: 'old_tool' }])
    assert.deepEqual(contextSnapshot.listToolCategories(), [
      { category: { id: 'general' }, tools: [{ name: 'old_tool' }] },
    ])
    contextSnapshot.setCurrentVisibleToolNames(['next_tool'])
    assert.deepEqual(context.getCurrentVisibleToolNames(), ['next_tool'])
  })

  void test('rejects an advertised call when the mutable source replaced its implementation', () => {
    let currentSignature = '1:fixture:plugin:old'
    const registry = {
      get: () => undefined,
      getRegistrationSignature: () => '1:fixture:plugin:old',
      getCurrentRegistrationSignature: () => currentSignature,
      listAvailable: () => [],
      getDescriptor: () => null,
    } satisfies ToolExecutionPolicyRegistry
    const policy = new ToolExecutionPolicy(registry)
    currentSignature = '2:fixture:plugin:new'

    const decision = policy.prepareExecution({
      toolName: 'fixture',
      args: {},
      baseContext: {
        getCurrentVisibleToolRegistrationSignature: () => '1:fixture:plugin:old',
      },
      abortSignal: new AbortController().signal,
      emitProgress: () => undefined,
      updateMetadata: () => undefined,
    } as never)

    assert.deepEqual(decision, {
      allowed: false,
      error: 'Stale tool call: fixture',
    })
  })
})
