import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { shouldRemoveLastChatInputFile } from '../../packages/ui/src/conversation/composer/chatInputUtils'
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
import { getToolDetailSummary } from '../../packages/ui/src/conversation/tool-render/toolCallSummary'
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
  void test('uses Backspace to remove the last attachment only after text is empty', () => {
    const base = {
      key: 'Backspace',
      value: '',
      fileCount: 2,
      canChangeFiles: true,
      isComposing: false,
      hasModifier: false,
    }

    assert.equal(shouldRemoveLastChatInputFile(base), true)
    assert.equal(shouldRemoveLastChatInputFile({ ...base, value: 'a' }), false)
    assert.equal(shouldRemoveLastChatInputFile({ ...base, fileCount: 0 }), false)
    assert.equal(shouldRemoveLastChatInputFile({ ...base, canChangeFiles: false }), false)
    assert.equal(shouldRemoveLastChatInputFile({ ...base, isComposing: true }), false)
    assert.equal(shouldRemoveLastChatInputFile({ ...base, hasModifier: true }), false)
    assert.equal(shouldRemoveLastChatInputFile({ ...base, key: 'Delete' }), false)
  })

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

  void test('keeps enabled composer toggle rows transparent until hover or keyboard focus', () => {
    const selectorSource = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/composer/ComposerModelRunSelector.tsx',
        import.meta.url
      ),
      'utf8'
    )
    const capabilitySource = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/composer/ComposerCapabilityControls.tsx',
        import.meta.url
      ),
      'utf8'
    )
    const menuStyles = readFileSync(
      new URL(
        '../../packages/ui/src/styles/components/primitives/cascading-menu.css',
        import.meta.url
      ),
      'utf8'
    )

    assert.doesNotMatch(selectorSource, /selected=\{pureChat\.value\}/u)
    assert.doesNotMatch(selectorSource, /selected=\{thinkingVisibility\.value\}/u)
    assert.doesNotMatch(capabilitySource, /selected=\{active\}/u)
    assert.equal(selectorSource.match(/<ComposerMenuSwitchIndicator checked=/gu)?.length, 2)
    assert.match(
      menuStyles,
      /\.velar-cascading-menu-item:hover, \.velar-cascading-menu-item:focus-visible,[^{]+\{\s*background: var\(--cascading-menu-item-hover-bg\);/u
    )
  })

  void test('keeps the compact composer summary focused on the selected model', () => {
    const selectorSource = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/composer/ComposerModelRunSelector.tsx',
        import.meta.url
      ),
      'utf8'
    )

    assert.match(
      selectorSource,
      /const selectedModelDisplayLabel =\s*modelRunSummary\?\.primaryLabel \?\?\s*selectedModelLabel;/u
    )
    assert.doesNotMatch(
      selectorSource,
      /\$\{visibleProvider\.label\}\s*\/\s*\$\{selectedModelLabel\}/u
    )
  })

  void test('keeps image attachment removal compact across Desktop and Workbench consumers', () => {
    const source = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/composer/ChatInputImageThumb.tsx',
        import.meta.url
      ),
      'utf8'
    )
    const styles = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/composer/ChatInput.module.css',
        import.meta.url
      ),
      'utf8'
    )
    const imageThumbButtonStyles =
      styles.match(/\.imageThumbButton\s*\{(?<body>[^}]*)\}/su)?.groups?.body ?? ''

    assert.equal(source.match(/size=\{14\}/gu)?.length, 2)
    assert.equal(source.match(/shape="round"/gu)?.length, 2)
    assert.doesNotMatch(source, /size="icon-sm"/u)
    assert.match(
      styles,
      /\.imageThumbButton\s*\{[^}]*width: fit-content;[^}]*min-width: 44px;[^}]*max-width: 160px;[^}]*height: 44px;/su
    )
    assert.match(
      styles,
      /\.imageThumbImg\s*\{[^}]*width: auto;[^}]*min-width: 44px;[^}]*max-width: 160px;[^}]*height: 44px;/su
    )
    assert.doesNotMatch(imageThumbButtonStyles, /(?:^|\n)\s*width: 44px;/u)
  })

  void test('renders sent image attachments without filename or size chrome', () => {
    const source = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/blocks/UserAttachmentGallery.tsx',
        import.meta.url
      ),
      'utf8'
    )

    assert.match(source, /className=\{styles\.userImagePreview\}/u)
    assert.doesNotMatch(source, /styles\.userImageMeta/u)
    assert.doesNotMatch(source, /styles\.userImageName/u)
    assert.doesNotMatch(source, /styles\.userImageSize/u)
  })

  void test('keeps Latin table headers intact instead of breaking identifiers anywhere', () => {
    const styles = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/blocks/MessageBubble.module.css',
        import.meta.url
      ),
      'utf8'
    )
    const tableHeaderStyles =
      styles.match(/\[data-streamdown='table-wrapper'\] th\s*\{(?<body>[^}]*)\}/su)?.groups?.body
      ?? ''

    assert.match(tableHeaderStyles, /overflow-wrap: normal;/u)
    assert.match(tableHeaderStyles, /word-break: normal;/u)
  })

  void test('keeps conversation tables at a 400px scroll viewport until fully expanded', () => {
    const styles = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/blocks/MessageBubble.module.css',
        import.meta.url
      ),
      'utf8'
    )
    const collapsedTableViewportStyles =
      styles.match(
        /\[data-streamdown='table-wrapper'\]\[data-collapsed='true'\][\s\S]*?> \[data-conversation-table-viewport\] \{(?<body>[\s\S]*?)\n {2}\}/u
      )?.groups?.body ?? ''
    const expandedTableViewportStyles =
      styles.match(
        /\[data-streamdown='table-wrapper'\]\[data-collapsed='false'\][\s\S]*?> \[data-conversation-table-viewport\] \{(?<body>[\s\S]*?)\n {2}\}/u
      )?.groups?.body ?? ''

    assert.match(collapsedTableViewportStyles, /max-height: 400px !important;/u)
    assert.match(collapsedTableViewportStyles, /overflow-y: auto !important;/u)
    assert.match(collapsedTableViewportStyles, /overscroll-behavior: contain;/u)
    assert.match(expandedTableViewportStyles, /max-height: none !important;/u)
    assert.match(expandedTableViewportStyles, /overflow-y: hidden !important;/u)
    assert.doesNotMatch(styles, /table-wrapper'\] > :global\(div:not\(\.flex\)\)/u)
  })

  void test('keeps code at a 400px scroll viewport and expands the whole block in one click', () => {
    const styles = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/blocks/MessageBubble.module.css',
        import.meta.url
      ),
      'utf8'
    )
    const source = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/blocks/useMessageMarkdownComponents.tsx',
        import.meta.url
      ),
      'utf8'
    )
    const codeBodyStyles =
      styles.match(
        /& \[data-streamdown='code-block-body'\] \{(?<body>[\s\S]*?)\n {2}\}/u
      )?.groups?.body ?? ''
    const collapsedCodeStyles =
      styles.match(
        /\.expandableCodeBlock\[data-collapsed='true'\] \[data-streamdown='code-block-body'\] \{(?<body>[\s\S]*?)\n {2}\}/u
      )?.groups?.body ?? ''
    const collapseSlotStyles =
      styles.match(/\.expandableCodeBlockCollapseSlot \{(?<body>[\s\S]*?)\n {2}\}/u)?.groups
        ?.body ?? ''
    const collapseButtonStyles =
      styles.match(/\.expandableCodeBlockCollapseButton \{(?<body>[\s\S]*?)\n {2}\}/u)?.groups
        ?.body ?? ''

    assert.match(codeBodyStyles, /overflow-x: auto;/u)
    assert.match(collapsedCodeStyles, /max-height: 400px !important;/u)
    assert.match(collapsedCodeStyles, /overflow-y: auto !important;/u)
    assert.match(
      styles,
      /\.expandableCodeBlock\[data-collapsed='false'\] \[data-streamdown='code-block-body'\] \{\s*max-height: none !important;\s*overflow-y: hidden !important;/u
    )
    assert.match(source, /baseMarkdownComponents\.table\s*=\s*MarkdownTableWithExpandableViewport/u)
    assert.equal(source.match(/const collapsed = hasOverflow && !expanded/gu)?.length, 2)
    assert.equal(source.match(/onClick=\{\(\) => setExpanded\(true\)\}/gu)?.length, 2)
    assert.match(collapseSlotStyles, /position: absolute;/u)
    assert.match(collapseSlotStyles, /bottom: 8px;/u)
    assert.match(collapseSlotStyles, /pointer-events: none;/u)
    assert.match(collapseButtonStyles, /border: 0;/u)
    assert.match(collapseButtonStyles, /background: transparent;/u)
    assert.match(collapseButtonStyles, /animation: expandable-block-control-drift 2\.8s/u)
  })

  void test('keeps conversation rows, bubbles, cards, and detail tooltips within their surface', () => {
    const bubbleStyles = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/blocks/MessageBubble.module.css',
        import.meta.url
      ),
      'utf8'
    )
    const paneStyles = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/shell/ChatConversationPane.module.css',
        import.meta.url
      ),
      'utf8'
    )
    const productStyles = readFileSync(
      new URL('../../packages/ui/src/styles/components/product.css', import.meta.url),
      'utf8'
    )

    assert.match(bubbleStyles, /\.root\s*\{\s*@apply flex w-full min-w-0 max-w-full;/u)
    assert.match(bubbleStyles, /\.userRow\s*\{\s*@apply relative flex min-w-0/u)
    assert.match(
      bubbleStyles,
      /\.userBubbleInner\s*\{[\s\S]*?max-w-full[\s\S]*?overflow-wrap: anywhere;[\s\S]*?word-break: break-word;/u
    )
    assert.match(paneStyles, /\.messageSequence\s*\{\s*@apply flex min-w-0 max-w-full/u)
    assert.match(
      paneStyles,
      /\.messageListInnerSide\s*\{[\s\S]*?@apply max-w-none gap-3 px-4/u
    )
    // 侧边形态不留导航槽位（覆盖式），槽位只属于主聊天页的阅读栏留白。
    assert.match(
      paneStyles,
      /\.conversationBody\[data-scroll-navigator-hidden='false'\] \.messageListInner:not\(\.messageListInnerSide\)\s*\{\s*padding-inline-end: 5\.25rem;/u
    )
    assert.match(
      productStyles,
      /\.velar-compact-tool-row-detail-tooltip\s*\{[\s\S]*?--radix-tooltip-trigger-width/u
    )
    assert.match(
      productStyles,
      /\.velar-tool-disclosure-card\s*\{[\s\S]*?min-width: 0;[\s\S]*?max-width: 100%;/u
    )
  })

  void test('keeps consecutive short user messages and their actions separate in narrow panes', () => {
    const styles = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/blocks/MessageBubble.module.css',
        import.meta.url
      ),
      'utf8'
    ).replace(/\r\n?/gu, '\n')
    const narrowLayout =
      styles.match(
        /@container chat-conversation-body \(max-width: 520px\) \{(?<body>[\s\S]*?)\n\}\n\n@media/u
      )?.groups?.body ?? ''

    assert.match(
      narrowLayout,
      /\.userRow\s*\{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto;/u
    )
    assert.match(
      narrowLayout,
      /\.userBubble\s*\{[\s\S]*?grid-column: 1 \/ -1;[\s\S]*?grid-row: 1;/u
    )
    assert.match(
      narrowLayout,
      /\.userLeftMeta\s*\{[\s\S]*?grid-column: 1;[\s\S]*?grid-row: 2;/u
    )
    assert.match(
      narrowLayout,
      /\.userMessageTimestamp\s*\{[\s\S]*?position: static;[\s\S]*?grid-column: 2;[\s\S]*?grid-row: 2;/u
    )
  })

  void test('shows the context distill progress note with a fact fallback', () => {
    assert.equal(
      getToolDetailSummary({
        toolName: 'context:distill',
        args: {
          facts: ['修复已完成'],
          note: '已完成定向验证；下一步运行完整检查。',
        },
      }),
      '已完成定向验证；下一步运行完整检查。'
    )
    assert.equal(
      getToolDetailSummary({
        toolName: 'context:distill',
        args: { facts: ['保留这条关键事实'] },
      }),
      '保留这条关键事实'
    )
  })

  void test('recreates cascading menu timers after lifecycle cleanup', () => {
    const source = readFileSync(
      new URL('../../packages/ui/src/primitives/overlays/CascadingMenu.tsx', import.meta.url),
      'utf8'
    )

    assert.match(source, /!timersRef\.current \|\| timersRef\.current\.isDisposed/u)
    assert.match(source, /if \(timersRef\.current === timers\) timersRef\.current = null/u)
    assert.match(source, /closeTimerRef\.current = null/u)
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

  void test('owns the controlled header visibility toggle and freezes body remounts while active', () => {
    const toggle = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/shell/ChatScrollNavigatorVisibilityToggle.tsx',
        import.meta.url
      ),
      'utf8'
    )
    const pane = readFileSync(
      new URL('../../packages/ui/src/conversation/shell/ChatConversationPane.tsx', import.meta.url),
      'utf8'
    )

    assert.match(toggle, /hidden:\s*boolean/u)
    assert.match(toggle, /onHiddenChange:\s*\(hidden:\s*boolean\)\s*=>\s*void/u)
    assert.match(toggle, /aria-pressed=\{!hidden\}/u)
    assert.match(toggle, /onClick=\{\(\) => onHiddenChange\(!hidden\)\}/u)
    assert.match(pane, /resolveConversationRefreshGeneration/u)
    assert.match(pane, /key=\{stableConversationRefreshKey\}/u)
    assert.doesNotMatch(pane, /key=\{conversationRefreshKey\}/u)
    assert.match(
      pane,
      /useLayoutEffect\(\(\) => \{\s*conversationRefreshGenerationRef\.current = conversationRefreshGeneration\s*\}, \[conversationRefreshGeneration\]\)/u
    )
    assert.doesNotMatch(
      pane,
      /\n\s*conversationRefreshGenerationRef\.current = conversationRefreshGeneration\s*\n\s*const stableConversationRefreshKey/u
    )
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

  void test('forwards trackpad movement over navigator buttons and honors reduced motion', () => {
    const source = readFileSync(
      new URL('../../packages/ui/src/conversation/shell/ChatScrollNavigator.tsx', import.meta.url),
      'utf8'
    )
    const stylesheet = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/shell/ChatScrollNavigator.module.css',
        import.meta.url
      ),
      'utf8'
    )

    const wheelHandlerStart = source.indexOf('const forwardWheelToTranscript')
    const wheelHandlerEnd = source.indexOf('\n  if (hidden || !navState.visible)', wheelHandlerStart)
    const wheelHandler = source.slice(wheelHandlerStart, wheelHandlerEnd)
    assert.ok(wheelHandlerStart >= 0)
    assert.ok(wheelHandlerEnd > wheelHandlerStart)
    assert.match(source, /onWheel=\{forwardWheelToTranscript\}/u)
    assert.match(wheelHandler, /scrollEl\.scrollBy\(\{ top: event\.deltaY, behavior: 'auto' \}\)/u)
    assert.match(wheelHandler, /event\.deltaY < 0[\s\S]*AutoScrollSuspendEventName/u)
    assert.match(wheelHandler, /event\.stopPropagation\(\)/u)
    assert.doesNotMatch(wheelHandler, /event\.preventDefault\(\)/u)
    assert.match(
      stylesheet,
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*transition:\s*none;/u
    )
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
