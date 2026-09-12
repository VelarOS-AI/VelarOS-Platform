import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { emptyConversationBlockHooks } from '../../packages/ui/src/conversation/blocks'
import {
  canonicalConversationMessageKeys,
  conversationEnUSMessages,
  conversationZhCNMessages,
  mergeConversationMessages,
} from '../../packages/ui/src/conversation/i18n'
import { createConversationRenderSlots } from '../../packages/ui/src/conversation/render-slots'
import { emptyConversationActionPort } from '../../packages/ui/src/conversation/shell'

function leafKeys(value: Readonly<Record<string, unknown>>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key
    return typeof entry === 'string'
      ? [path]
      : leafKeys(entry as Readonly<Record<string, unknown>>, path)
  })
}

void describe('shared conversation composition', () => {
  void test('publishes one exhaustive, locale-parity message manifest', () => {
    assert.equal(canonicalConversationMessageKeys.length, 423)
    assert.deepEqual(
      leafKeys(conversationEnUSMessages).sort(),
      canonicalConversationMessageKeys,
    )
    assert.deepEqual(
      leafKeys(conversationZhCNMessages).sort(),
      canonicalConversationMessageKeys,
    )
  })

  void test('deep-merges host copy without mutating or replacing sibling keys', () => {
    const merged = mergeConversationMessages(conversationEnUSMessages, {
      chat: { placeholder: 'Ask this product…' },
      product: { title: 'Product' },
    })

    assert.equal(merged.chat.placeholder, 'Ask this product…')
    assert.equal(merged.chat.sendMessage, conversationEnUSMessages.chat.sendMessage)
    assert.equal(merged.product.title, 'Product')
    assert.equal(conversationEnUSMessages.chat.placeholder, 'Enter a task…')
  })

  void test('supplies reusable no-op ports and complete render slots', async () => {
    const runningRuntimeMark = () => null
    const slots = createConversationRenderSlots({ runningRuntimeMark })
    const messageActions = emptyConversationBlockHooks.useMessageActionView({} as never)

    assert.equal(slots.runningRuntimeMark, runningRuntimeMark)
    assert.equal(slots.messageMarkdown, undefined)
    assert.equal(slots.conversationCardContent({} as never), null)
    assert.equal(messageActions.hasActionItems, false)
    assert.deepEqual(await emptyConversationActionPort.getGoalLifecycle('session'), {
      ok: true,
      goal: null,
    })
  })
})
