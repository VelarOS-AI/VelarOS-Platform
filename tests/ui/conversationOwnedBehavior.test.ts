import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { filterComposerMenuPluginOptions } from '../../packages/ui/src/conversation/composer/hooks/buildChatInputComposerAddMenuProps'
import {
  NoNextStepSuggestionHighlightIndex,
  resolveNextStepSuggestionHighlightIndex,
  resolveNextStepSuggestionKeyboardAction,
} from '../../packages/ui/src/conversation/composer/hooks/nextStepSuggestionCompletion.pure'
import {
  applyPromptFeatureGroupSelection,
  buildAvailablePluginOptions,
} from '../../packages/ui/src/conversation/composer/hooks/useComposerPromptFeatures.pure'
import { canClaimChatDraftInsertion } from '../../packages/ui/src/conversation/composer/utils/chatDraftInsertion.utils'
import { claimChatPromptFeatureActivation } from '../../packages/ui/src/conversation/composer/utils/chatPromptFeatureActivation.utils'
import { activateMarkdownTailMarker } from '../../packages/ui/src/conversation/markdown/markdownTailMarker.utils'

function createDraftTarget(input: {
  connected?: boolean
  disabled?: boolean
  rectCount?: number
}): Pick<HTMLTextAreaElement, 'disabled' | 'getClientRects' | 'isConnected'> {
  return {
    disabled: input.disabled ?? false,
    isConnected: input.connected ?? true,
    getClientRects: () => ({ length: input.rectCount ?? 1 }) as DOMRectList,
  }
}

void describe('Platform-owned conversation composer behavior', () => {
  void test('keeps Widget and HTML Live Preview independently selectable', () => {
    const options = buildAvailablePluginOptions()
    const widget = options.find((option) => option.id === 'widget')
    const htmlArtifact = options.find((option) => option.id === 'html-artifact')
    assert.ok(widget)
    assert.ok(htmlArtifact)
    assert.notEqual(htmlArtifact.icon, widget.icon)

    assert.deepEqual(
      applyPromptFeatureGroupSelection({
        promptFeatures: ['html-artifact'],
        option: widget,
        enabled: true,
      }),
      ['html-artifact', 'widget']
    )
    assert.deepEqual(
      applyPromptFeatureGroupSelection({
        promptFeatures: ['widget'],
        option: htmlArtifact,
        enabled: true,
      }),
      ['html-artifact', 'widget']
    )
  })

  void test('omits auto-triggered visual presentation choices from menu plugins', () => {
    const menuPluginOptions = filterComposerMenuPluginOptions(buildAvailablePluginOptions())

    assert.equal(
      menuPluginOptions.some(
        (option) => option.id === 'widget' || option.id === 'html-artifact'
      ),
      false
    )
    assert.equal(
      menuPluginOptions.some((option) => option.id === 'office'),
      true
    )
  })

  void test('lets only the visible editable composer claim a global draft', () => {
    assert.equal(canClaimChatDraftInsertion(createDraftTarget({})), true)
    assert.equal(canClaimChatDraftInsertion(createDraftTarget({ connected: false })), false)
    assert.equal(canClaimChatDraftInsertion(createDraftTarget({ disabled: true })), false)
    assert.equal(canClaimChatDraftInsertion(createDraftTarget({ rectCount: 0 })), false)
  })

  void test('claims only valid prompt-feature activation events once', () => {
    const event = new CustomEvent('velaros:activate-chat-prompt-feature', {
      detail: { feature: 'html-artifact', handled: false },
    })

    assert.equal(claimChatPromptFeatureActivation(event), 'html-artifact')
    assert.equal(claimChatPromptFeatureActivation(event), null)
    assert.equal(
      claimChatPromptFeatureActivation(
        new CustomEvent('velaros:activate-chat-prompt-feature', {
          detail: { feature: 'not-a-feature', handled: false },
        })
      ),
      null
    )
  })

  void test('wraps next-step suggestion navigation from either edge', () => {
    assert.equal(
      resolveNextStepSuggestionHighlightIndex(NoNextStepSuggestionHighlightIndex, 3, 'down'),
      0
    )
    assert.equal(
      resolveNextStepSuggestionHighlightIndex(NoNextStepSuggestionHighlightIndex, 3, 'up'),
      2
    )
    assert.equal(resolveNextStepSuggestionHighlightIndex(2, 3, 'down'), 0)
    assert.equal(resolveNextStepSuggestionHighlightIndex(0, 3, 'up'), 2)
    assert.equal(
      resolveNextStepSuggestionHighlightIndex(NoNextStepSuggestionHighlightIndex, 0, 'down'),
      NoNextStepSuggestionHighlightIndex
    )
  })

  void test('routes suggestion keyboard actions without React or DOM state', () => {
    assert.deepEqual(
      resolveNextStepSuggestionKeyboardAction(
        'Escape',
        NoNextStepSuggestionHighlightIndex,
        3,
        true,
        true
      ),
      { kind: 'dismiss' }
    )
    assert.deepEqual(resolveNextStepSuggestionKeyboardAction('Enter', 1, 3, true, true), {
      kind: 'submit',
      index: 1,
    })
    assert.deepEqual(
      resolveNextStepSuggestionKeyboardAction(
        'ArrowUp',
        NoNextStepSuggestionHighlightIndex,
        3,
        false,
        true
      ),
      { kind: 'open', index: 2 }
    )
    assert.deepEqual(
      resolveNextStepSuggestionKeyboardAction(
        'Backspace',
        NoNextStepSuggestionHighlightIndex,
        3,
        true,
        true,
        2
      ),
      { kind: 'remove-attachment', dismissWhenEmpty: false, index: 1 }
    )
  })
})

void describe('Platform-owned chat scroll navigator structure', () => {
  void test('shares one visibility boundary with jump and follow controls', () => {
    const source = readFileSync(
      new URL('../../packages/ui/src/conversation/shell/ChatScrollNavigator.tsx', import.meta.url),
      'utf8'
    )
    const visibilityGateIndex = source.indexOf('if (hidden || !navState.visible) return null')
    const jumpControlsIndex = source.indexOf('<div className={styles.rail}>')
    const followLockIndex = source.indexOf('<div className={styles.followLayer}>')

    assert.ok(visibilityGateIndex >= 0)
    assert.ok(jumpControlsIndex > visibilityGateIndex)
    assert.ok(followLockIndex > visibilityGateIndex)
    assert.equal(source.includes('{navState.visible && ('), false)
  })

  void test('keeps the narrow navigator inset instead of collapsing over content', () => {
    const stylesheet = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/shell/ChatScrollNavigator.module.css',
        import.meta.url
      ),
      'utf8'
    )
    assert.match(
      stylesheet,
      /@media\s*\(max-width:\s*980px\)\s*\{\s*\.root\s*\{[^}]*right:\s*16px;/s
    )
    assert.equal(stylesheet.includes('@container chat-conversation-body'), false)
    assert.equal(stylesheet.includes('--scroll-navigator-collapsed-opacity'), false)
  })
})

interface FakeElementOptions {
  nextElementSibling?: FakeElement
  parentElement?: FakeElement
  previousElementSibling?: FakeElement
}

class FakeElement {
  readonly dataset: Record<string, string> = {}
  readonly nextElementSibling: Nullable<FakeElement>
  readonly parentElement: Nullable<FakeElement>
  readonly previousElementSibling: Nullable<FakeElement>

  constructor(options: FakeElementOptions = {}) {
    this.nextElementSibling = options.nextElementSibling ?? null
    this.parentElement = options.parentElement ?? null
    this.previousElementSibling = options.previousElementSibling ?? null
  }
}

function createMarkdownContainer(
  inlineSlots: FakeElement[],
  fallbackSlot: FakeElement
): HTMLElement {
  return {
    querySelectorAll(selector: string): FakeElement[] {
      return selector === '.inline' ? inlineSlots : [fallbackSlot]
    },
  } as unknown as HTMLElement
}

void describe('Platform-owned Markdown tail marker placement', () => {
  void test('keeps the marker on the final inline Markdown slot', () => {
    const markdownRoot = new FakeElement()
    const finalBlock = new FakeElement({ parentElement: markdownRoot })
    const inlineSlot = new FakeElement({ parentElement: finalBlock })
    const fallbackSlot = new FakeElement({ previousElementSibling: markdownRoot })

    activateMarkdownTailMarker({
      container: createMarkdownContainer([inlineSlot], fallbackSlot),
      inlineSlotSelector: '.inline',
      fallbackSlotSelector: '.fallback',
    })

    assert.equal(inlineSlot.dataset.activeTailMarker, 'true')
    assert.equal(fallbackSlot.dataset.activeTailMarker, undefined)
  })

  void test('uses the fallback after a terminal non-paragraph block', () => {
    const markdownRoot = new FakeElement()
    const tableBlock = new FakeElement({ parentElement: markdownRoot })
    const earlierParagraph = new FakeElement({
      nextElementSibling: tableBlock,
      parentElement: markdownRoot,
    })
    const inlineSlot = new FakeElement({ parentElement: earlierParagraph })
    const fallbackSlot = new FakeElement({ previousElementSibling: markdownRoot })

    activateMarkdownTailMarker({
      container: createMarkdownContainer([inlineSlot], fallbackSlot),
      inlineSlotSelector: '.inline',
      fallbackSlotSelector: '.fallback',
    })

    assert.equal(inlineSlot.dataset.activeTailMarker, undefined)
    assert.equal(fallbackSlot.dataset.activeTailMarker, 'true')
  })

  void test('detects a terminal nested non-paragraph block', () => {
    const markdownRoot = new FakeElement()
    const finalContainer = new FakeElement({ parentElement: markdownRoot })
    const nestedCodeBlock = new FakeElement({ parentElement: finalContainer })
    const nestedParagraph = new FakeElement({
      nextElementSibling: nestedCodeBlock,
      parentElement: finalContainer,
    })
    const inlineSlot = new FakeElement({ parentElement: nestedParagraph })
    const fallbackSlot = new FakeElement({ previousElementSibling: markdownRoot })

    activateMarkdownTailMarker({
      container: createMarkdownContainer([inlineSlot], fallbackSlot),
      inlineSlotSelector: '.inline',
      fallbackSlotSelector: '.fallback',
    })

    assert.equal(inlineSlot.dataset.activeTailMarker, undefined)
    assert.equal(fallbackSlot.dataset.activeTailMarker, 'true')
  })

  void test('uses the fallback when no inline candidate exists', () => {
    const markdownRoot = new FakeElement()
    const fallbackSlot = new FakeElement({ previousElementSibling: markdownRoot })

    activateMarkdownTailMarker({
      container: createMarkdownContainer([], fallbackSlot),
      inlineSlotSelector: '.inline',
      fallbackSlotSelector: '.fallback',
    })

    assert.equal(fallbackSlot.dataset.activeTailMarker, 'true')
  })
})
