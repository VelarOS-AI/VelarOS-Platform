import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { resolveChatSurfaceComposerDensity } from '../../packages/ui/src/conversation/composer/ChatSurfaceComposer'
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
import { shouldUseDefaultTranscriptToolRenderer } from '../../packages/ui/src/conversation/tool-render/toolRenderToolNames'

void describe('Platform-owned conversation card placement', () => {
  void test('reserves rich transcript renderers for tools outside Plan and Goal lifecycle state', () => {
    assert.equal(shouldUseDefaultTranscriptToolRenderer('plan:update'), true)
    assert.equal(shouldUseDefaultTranscriptToolRenderer('goal:create'), true)
    assert.equal(shouldUseDefaultTranscriptToolRenderer('goal:update'), true)
    assert.equal(shouldUseDefaultTranscriptToolRenderer('project:read_file'), false)
  })

  void test('derives the sticky dock from Plan and Goal while rendering conversation cards inline', () => {
    const source = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/shell/ChatConversationPane.tsx',
        import.meta.url
      ),
      'utf8'
    )

    assert.match(
      source,
      /const conversationCards = useMemo\(\s*\(\) => runtime\.conversationCards \?\? runtime\.stickyDockItems \?\? \[\],\s*\[runtime\.conversationCards, runtime\.stickyDockItems\]\s*\)/u
    )
    assert.match(source, /for \(const item of conversationCards\)/u)
    assert.match(source, /\{inlineConversationCards\}\s*\{!!streamSlot/u)
    assert.match(source, /if \(goalDockModel && goalLifecycleDockItemId\)/u)
    assert.match(source, /if \(activeDockPlanBlock && activeDockPlanItemId\)/u)
    assert.doesNotMatch(source, /hideGoalToolBlocks=/u)
    assert.doesNotMatch(source, /hiddenPlanToolCallId=/u)
  })
})

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
  void test('derives one composer density policy from the shared conversation surface variant', () => {
    assert.equal(resolveChatSurfaceComposerDensity({ variant: 'default' }), 'default')
    assert.equal(resolveChatSurfaceComposerDensity({ variant: 'side' }), 'compact')
    assert.equal(
      resolveChatSurfaceComposerDensity({ variant: 'side', density: 'default' }),
      'default'
    )
  })

  void test('keeps the Workbench current-file chip removable through the shared chip behavior', () => {
    const inputSource = readFileSync(
      new URL('../../packages/ui/src/conversation/composer/ChatInput.tsx', import.meta.url),
      'utf8'
    )
    const chipsSource = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/composer/ComposerActiveChipsBar.tsx',
        import.meta.url
      ),
      'utf8'
    )

    assert.match(inputSource, /onDismissWorkbenchCurrentFile/)
    assert.match(chipsSource, /chipDataPluginId="workbench-current-file"/)
    assert.match(chipsSource, /onRemove=\{onDismissWorkbenchCurrentFile\}/)
  })

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

  void test('keeps model and run menus fixed at the popover boundary', () => {
    const stylesheet = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/composer/ChatInput.module.css',
        import.meta.url
      ),
      'utf8'
    )
    const defaultMenu = stylesheet.match(
      /\.composerModelRunMenuContent:global\(\.velar-cascading-menu-content\)\[data-slot='popover-content'\]\s*\{(?<rules>[^}]*)\}/
    )?.groups?.rules
    const compactMenu = stylesheet.match(
      /\.composerModelRunMenuContent\.composerModelRunMenuContentCompact:global\(\s*\.velar-cascading-menu-content\s*\)\[data-slot='popover-content'\]\s*\{(?<rules>[^}]*)\}/
    )?.groups?.rules

    assert.ok(defaultMenu)
    assert.ok(compactMenu)
    assert.match(
      stylesheet,
      /\.composerModelRunMenuPrimary:global\(\.velar-cascading-menu-primary-panel\)/
    )
    for (const dimension of ['width', 'min-width', 'max-width']) {
      assert.match(defaultMenu, new RegExp(`--cascading-menu-primary-${dimension}: 17rem;`))
      assert.match(defaultMenu, new RegExp(`--cascading-menu-submenu-${dimension}: 17rem;`))
      assert.match(compactMenu, new RegExp(`--cascading-menu-primary-${dimension}: 13\\.5rem;`))
      assert.match(compactMenu, new RegExp(`--cascading-menu-submenu-${dimension}: 13\\.5rem;`))
    }
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

  void test('suspends bottom following before every upward navigator action', () => {
    const source = readFileSync(
      new URL('../../packages/ui/src/conversation/shell/ChatScrollNavigator.tsx', import.meta.url),
      'utf8'
    )
    const topSuspendIndex = source.indexOf(
      'scrollEl.dispatchEvent(new Event(AutoScrollSuspendEventName, { bubbles: true }))'
    )
    const topNavigationIndex = source.indexOf("scrollToEdge('top')")
    const previousBranchIndex = source.indexOf("if (direction === 'previous')")
    const sectionNavigationIndex = source.indexOf('scrollToSection(direction)')

    assert.ok(topSuspendIndex >= 0)
    assert.ok(topNavigationIndex > topSuspendIndex)
    assert.ok(previousBranchIndex > topNavigationIndex)
    assert.ok(sectionNavigationIndex > previousBranchIndex)
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
