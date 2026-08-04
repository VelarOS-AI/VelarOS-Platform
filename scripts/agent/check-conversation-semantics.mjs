#!/usr/bin/env bun

import assert from 'node:assert/strict'

import {
  isConversationTurnInputMessage as isAgentTurnInput,
  isRunGuidanceMessage as isAgentRunGuidance,
  resolveChatMessageConversationKind as resolveAgentKind,
} from '../../packages/agent/src/protocol/types/index.ts'
import {
  isConversationTurnInputMessage as isUiTurnInput,
  isRunGuidanceMessage as isUiRunGuidance,
  resolveChatMessageConversationKind as resolveUiKind,
} from '../../packages/ui/src/conversation/contracts/conversation.ts'

// UI 刻意不依赖任何 VelarOS runtime 包，因此保留自己的 structural message contract。
// 这张真值表是两侧唯一允许的重复 seam：任何新增 kind 或 legacy 推断变化必须同时更新。
const cases = [
  { name: 'new turn', message: { role: 'user', conversationKind: 'turn-input' } },
  { name: 'run guidance', message: { role: 'user', conversationKind: 'run-guidance' } },
  {
    name: 'interaction reply',
    message: { role: 'user', conversationKind: 'interaction-reply' },
  },
  { name: 'assistant output', message: { role: 'assistant' } },
  { name: 'legacy user turn', message: { role: 'user' } },
  { name: 'legacy guidance', message: { role: 'user', guidanceStatus: 'sent' } },
  { name: 'unknown persisted role', message: { role: 'tool' } },
  { name: 'missing persisted role', message: {} },
]

for (const fixture of cases) {
  const agent = {
    kind: resolveAgentKind(fixture.message),
    turnInput: isAgentTurnInput(fixture.message),
    runGuidance: isAgentRunGuidance(fixture.message),
  }
  const ui = {
    kind: resolveUiKind(fixture.message),
    turnInput: isUiTurnInput(fixture.message),
    runGuidance: isUiRunGuidance(fixture.message),
  }
  assert.deepEqual(ui, agent, `${fixture.name}: Agent protocol and UI semantics drifted`)
}

assert.equal(isAgentTurnInput({ role: 'tool' }), false)
assert.equal(isAgentTurnInput({}), false)
console.log(`conversation semantics: ${cases.length} shared cases verified`)
