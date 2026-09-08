import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveChatInputPrimaryActionState } from '../../packages/ui/src/conversation/composer/chatInputInteractionState.pure'

const running = {
  disabled: false, fileCount: 0, hideSubmit: false, isRunActive: true,
  isStopAvailable: true, isStopPending: false, isSubmitting: false, value: '',
}

void test('active task with a draft exposes send, empty draft exposes stop', () => {
  const state = resolveChatInputPrimaryActionState({ ...running, value: 'use this correction', canSendDuringRun: true })
  assert.equal(state.kind, 'send')
  assert.equal(state.disabled, false)
  assert.equal(resolveChatInputPrimaryActionState({ ...running, canSendDuringRun: true }).kind, 'stop')
})

void test('sending attachments can guide an active task', () => {
  assert.equal(resolveChatInputPrimaryActionState({ ...running, fileCount: 1, canSendDuringRun: true }).kind, 'send')
})

void test('stopping keeps the pending stop action even with draft content', () => {
  const state = resolveChatInputPrimaryActionState({ ...running, isStopPending: true, value: 'keep draft', canSendDuringRun: true })
  assert.equal(state.kind, 'stop')
  assert.equal(state.pending, true)
  assert.equal(state.disabled, true)
})

void test('consumers without live delivery capability keep their existing stop control', () => {
  assert.equal(resolveChatInputPrimaryActionState({ ...running, value: 'draft' }).kind, 'stop')
})
