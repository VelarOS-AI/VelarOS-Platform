import { describe, expect, it } from 'bun:test'

import {
  isConversationTurnInputMessage,
  isRunGuidanceMessage,
  resolveChatMessageConversationKind,
} from '../src/protocol/types'

describe('chat message conversation semantics', () => {
  it('keeps guidance and interaction replies inside the current run', () => {
    expect(
      resolveChatMessageConversationKind({
        role: 'user',
        conversationKind: 'run-guidance',
      })
    ).toBe('run-guidance')
    expect(
      isConversationTurnInputMessage({
        role: 'user',
        conversationKind: 'interaction-reply',
      })
    ).toBe(false)
    expect(isRunGuidanceMessage({ role: 'user', guidanceStatus: 'sent' })).toBe(true)
  })

  it('reads legacy user messages while rejecting unknown persisted roles as turn inputs', () => {
    expect(isConversationTurnInputMessage({ role: 'user' })).toBe(true)
    expect(isConversationTurnInputMessage({ role: 'assistant' })).toBe(false)
    expect(isConversationTurnInputMessage({ role: 'tool' })).toBe(false)
    expect(isConversationTurnInputMessage({})).toBe(false)
  })
})
