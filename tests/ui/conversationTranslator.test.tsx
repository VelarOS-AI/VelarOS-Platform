import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  ConversationLocalizationProvider,
  useConversationTranslatorRuntime,
} from '../packages/conversation-ui/src/i18n'
import {
  conversationTranslate,
  ConversationTranslatorRuntime,
} from '../packages/conversation-ui/src/i18n/conversationTranslator'

function createTranslator(prefix: string) {
  return {
    translate: (_locale: 'zh-CN' | 'en-US', key: string): string => `${prefix}:${key}`,
    lookupMessage: (_locale: 'zh-CN' | 'en-US', key: string): string => `${prefix}:${key}`,
  }
}

function RuntimeProbe(): React.JSX.Element {
  const runtime = useConversationTranslatorRuntime()
  return <span>{runtime.translate('en-US', 'probe')}</span>
}

void describe('ConversationTranslatorRuntime', () => {
  void test('isolates translators and supports explicit teardown', () => {
    const first = new ConversationTranslatorRuntime(createTranslator('first'))
    const second = new ConversationTranslatorRuntime(createTranslator('second'))

    assert.equal(first.translate('en-US', 'title'), 'first:title')
    assert.equal(second.translate('en-US', 'title'), 'second:title')
    assert.equal(conversationTranslate('en-US', 'title', undefined, first), 'first:title')

    first.dispose()
    assert.equal(first.isConfigured, false)
    assert.throws(() => first.translate('en-US', 'title'), /翻译器未注入/)
    assert.equal(second.translate('en-US', 'title'), 'second:title')
  })

  void test('localization providers create isolated runtime contexts for multiple roots', () => {
    const first = renderToStaticMarkup(
      createElement(
        ConversationLocalizationProvider,
        {
          value: {
            locale: 'en-US',
            setLocale: async () => undefined,
            t: (key: string) => `first:${key}`,
          },
        },
        createElement(RuntimeProbe)
      )
    )
    const second = renderToStaticMarkup(
      createElement(
        ConversationLocalizationProvider,
        {
          value: {
            locale: 'en-US',
            setLocale: async () => undefined,
            t: (key: string) => `second:${key}`,
          },
        },
        createElement(RuntimeProbe)
      )
    )

    assert.match(first, /first:probe/)
    assert.match(second, /second:probe/)
  })
})
