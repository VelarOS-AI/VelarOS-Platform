import React, {
  memo,
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { CaretRightIcon, GlobeHemisphereWestIcon } from '@phosphor-icons/react'
import { type Components as StreamdownComponents, Streamdown } from 'streamdown'

import { StyleUtils } from '@velaros-ai/ui'

import { useConversationI18n } from '../i18n'
import { activateMarkdownTailMarker } from '../markdown/markdownTailMarker.utils'
import {
  resolveStreamdownMarkdownMode,
  STREAMDOWN_MARKDOWN_CONTROLS,
  STREAMDOWN_MARKDOWN_LINK_SAFETY,
  STREAMDOWN_MARKDOWN_PLUGINS,
} from '../markdown/streamdownMarkdown.config'
import { prepareStreamdownMarkdownText } from '../markdown/streamdownMarkdownSource.utils'
import { AutoScrollSuspendEventName } from '../react-hooks/scrollBehavior'
import { useDisclosurePresence } from '../react-hooks/useDisclosurePresence'

import { useConversationBlockHooks } from './conversationBlockHooks'
import type { ConversationMessageRunMarker } from './messageBubbleRenderModel'
import { MessageStatusMarker } from './MessageStatusMarker'
import {
  getStreamingThinkingDisplayText,
  getThinkingBlockDisplayText,
  getThinkingTranslationButtonKind,
  shouldAutoTranslateThinkingBlock,
} from './thinkingTranslation'
import { useMessageMarkdownComponents } from './useMessageMarkdownComponents'

import styles from './MessageBubble.module.css'

import type { TextBlock, ThinkingBlock as ThinkingContentBlock } from '#contracts'
import { isBlank, isPresent, isString } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)
const MESSAGE_STREAMDOWN_CLASS_NAME = 'space-y-0'
const MaxThinkingAnimatedTextKeys = 500
const ThinkingAnimatedTextLengthByKey = new Map<string, number>()

function countDisplayCharacters(text: string): number {
  return Array.from(text).length
}

function rememberThinkingAnimatedTextLength(blockKey: string, textLength: number): void {
  const previousLength = ThinkingAnimatedTextLengthByKey.get(blockKey)
  if (isPresent(previousLength)) {
    if (textLength > previousLength) {
      ThinkingAnimatedTextLengthByKey.set(blockKey, textLength)
    }
    return
  }

  if (ThinkingAnimatedTextLengthByKey.size >= MaxThinkingAnimatedTextKeys) {
    const oldestKey = ThinkingAnimatedTextLengthByKey.keys().next().value
    if (isString(oldestKey)) {
      ThinkingAnimatedTextLengthByKey.delete(oldestKey)
    }
  }
  ThinkingAnimatedTextLengthByKey.set(blockKey, textLength)
}

function renderStreamingThinkingText(
  text: string,
  animatedTextStartIndex: number
): React.ReactNode {
  const characters = Array.from(text)
  const normalizedStartIndex = Math.max(0, Math.min(animatedTextStartIndex, characters.length))
  if (normalizedStartIndex >= characters.length) return text

  return (
    <>
      {characters.slice(0, normalizedStartIndex).join('')}
      {characters.slice(normalizedStartIndex).map((char, offset) => {
        const index = normalizedStartIndex + offset

        return (
          <span key={`${index}-${char}`} className={styles.thinkingPlainTextStreamingChar}>
            {char}
          </span>
        )
      })}
    </>
  )
}

/**
 * 思考块新增字符的进场动画起点：只对「本组件观察到之后新追加」的字符做淡入。
 *
 * 屏显节奏的唯一权威是状态层的 ChatStreamPacer（思考/正文/工具单 FIFO 按到达顺序逐帧吐），
 * 组件不再维护落后于状态的影子揭示文本——这里只算 CSS 进场动画从哪个字符开始。
 * 首次观察（含切会话/重挂载时已积累的长文）一律视为已揭示，避免整段文字齐刷刷补动画；
 * module 级 Map 记住每个块已动画过的长度，重挂载 / StrictMode 双调用不重放。
 */
function useStreamingThinkingAnimationStartIndex({
  isStreaming,
  blockKey,
  text,
}: {
  isStreaming: boolean
  blockKey: string
  text: string
}): number {
  const textLength = useMemo(() => countDisplayCharacters(text), [text])
  const animatedTextStartIndex = useMemo(() => {
    if (!isStreaming) return textLength

    const rememberedLength = ThinkingAnimatedTextLengthByKey.get(blockKey)
    return isPresent(rememberedLength) ? Math.min(rememberedLength, textLength) : textLength
  }, [blockKey, isStreaming, textLength])

  useLayoutEffect(() => {
    if (!isStreaming) return

    rememberThinkingAnimatedTextLength(blockKey, textLength)
  }, [blockKey, isStreaming, textLength])

  return animatedTextStartIndex
}

function ThinkingBlockInner({
  block,
  isStreaming = false,
  autoCollapse = false,
  messageId,
  blockIndex,
  onTranslateThinkingBlock,
}: {
  block: ThinkingContentBlock
  isStreaming?: boolean
  autoCollapse?: boolean
  messageId: string
  blockIndex?: number
  onTranslateThinkingBlock?: (request: {
    messageId: string
    blockIndex: number
    text: string
  }) => Promise<void>
}): Nullable<ReactElement> {
  const { t, locale } = useConversationI18n()
  const { useAutoTranslateThinkingEnabled } = useConversationBlockHooks()
  const autoTranslateThinking = useAutoTranslateThinkingEnabled()
  const [expanded, setExpanded] = useState(() => isStreaming && !autoCollapse)
  const [isTranslating, setIsTranslating] = useState(false)
  const [translateError, setTranslateError] = useState<Nullable<string>>(null)
  const autoTranslateRequestKeyRef = useRef<Nullable<string>>(null)
  const { mounted: isMounted, visible: isVisible } = useDisclosurePresence(expanded)
  const fullDisplayText = getThinkingBlockDisplayText(block, locale)
  const displayText = getStreamingThinkingDisplayText(fullDisplayText, { streaming: isStreaming })
  const blockKey = `${messageId}:${blockIndex ?? 'thinking'}:${block.streamId ?? 'stream'}`
  const animatedTextStartIndex = useStreamingThinkingAnimationStartIndex({
    isStreaming,
    blockKey,
    text: displayText,
  })
  const buttonKind = getThinkingTranslationButtonKind(block, locale)
  const canTranslate =
    !isStreaming && !!onTranslateThinkingBlock && isPresent(blockIndex) && buttonKind !== 'hidden'

  useEffect(() => {
    if (autoCollapse) {
      setExpanded(false)
    }
  }, [autoCollapse])

  useEffect(() => {
    if (buttonKind !== 'translate') {
      setIsTranslating(false)
      setTranslateError(null)
    }
  }, [buttonKind, locale])

  const handleTranslate = useCallback(async (): Promise<void> => {
    if (!canTranslate || isTranslating || !isPresent(blockIndex)) return

    setTranslateError(null)
    setIsTranslating(true)
    try {
      await onTranslateThinkingBlock({
        messageId,
        blockIndex,
        text: block.text,
      })
    } catch {
      setTranslateError(t('chat.thinkingTranslateFailed'))
      setIsTranslating(false)
    }
  }, [block.text, blockIndex, canTranslate, isTranslating, messageId, onTranslateThinkingBlock, t])

  useEffect(() => {
    if (
      !canTranslate ||
      isTranslating ||
      !isPresent(blockIndex) ||
      !shouldAutoTranslateThinkingBlock(block, locale, autoTranslateThinking)
    )
      return

    const requestKey = `${messageId}:${blockIndex}:${locale}:${block.text}`
    if (autoTranslateRequestKeyRef.current === requestKey) return

    autoTranslateRequestKeyRef.current = requestKey
    void handleTranslate()
  }, [
    autoTranslateThinking,
    block,
    block.text,
    blockIndex,
    canTranslate,
    handleTranslate,
    isTranslating,
    locale,
    messageId,
  ])

  if (isBlank(displayText)) return null

  const label = t('chat.thinkingProcess')
  const translateButtonLabel =
    buttonKind === 'show-original'
      ? t('chat.thinkingShowOriginal')
      : buttonKind === 'show-translation'
        ? t('chat.thinkingShowTranslation')
        : t('chat.thinkingTranslate')

  return (
    <div className={cx('toolActivityDisclosure', 'thinkingBlock')}>
      <button
        type="button"
        className={cx(
          'toolActivityToggle',
          isStreaming && !autoCollapse && 'toolActivityToggleRunning'
        )}
        aria-expanded={expanded}
        title={label}
        onClick={(event) => {
          event.currentTarget.dispatchEvent(
            new Event(AutoScrollSuspendEventName, { bubbles: true })
          )
          setExpanded((value) => !value)
        }}
      >
        <span className={styles.toolActivityLabel}>{label}</span>
        <CaretRightIcon
          size={14}
          weight="bold"
          className={cx('toolActivityChevron', expanded && 'toolActivityChevronExpanded')}
          aria-hidden="true"
        />
      </button>
      {isMounted && (
        <div
          className={cx(
            'toolActivityBodyShell',
            expanded && isVisible && 'toolActivityBodyShellExpanded'
          )}
          aria-hidden={!isVisible}
        >
          <div className={styles.toolActivityBodyFrame}>
            <div className={styles.toolActivityBody}>
              <pre className={styles.thinkingPlainText}>
                {isStreaming
                  ? renderStreamingThinkingText(displayText, animatedTextStartIndex)
                  : displayText}
              </pre>
              {canTranslate && (
                <div className={styles.thinkingTranslateRow}>
                  <button
                    type="button"
                    className={styles.thinkingTranslateButton}
                    disabled={isTranslating}
                    title={translateButtonLabel}
                    onClick={() => {
                      void handleTranslate()
                    }}
                  >
                    <GlobeHemisphereWestIcon size={13} aria-hidden="true" />
                    <span>
                      {isTranslating ? t('chat.thinkingTranslating') : translateButtonLabel}
                    </span>
                  </button>
                  {!!translateError && (
                    <span className={styles.thinkingTranslateError}>{translateError}</span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export const ThinkingBlock = memo(ThinkingBlockInner)
ThinkingBlock.displayName = 'ThinkingBlock'

function MessageStreamdownInner({
  text,
  isStreaming,
  components,
}: {
  text: string
  isStreaming: boolean
  components: StreamdownComponents
}): ReactElement {
  return (
    <Streamdown
      mode={resolveStreamdownMarkdownMode({ isStreaming })}
      isAnimating={false}
      animated={false}
      plugins={STREAMDOWN_MARKDOWN_PLUGINS}
      linkSafety={STREAMDOWN_MARKDOWN_LINK_SAFETY}
      controls={STREAMDOWN_MARKDOWN_CONTROLS}
      className={MESSAGE_STREAMDOWN_CLASS_NAME}
      components={components}
    >
      {text}
    </Streamdown>
  )
}

const MessageStreamdown = memo(MessageStreamdownInner)
MessageStreamdown.displayName = 'MessageStreamdown'

function MessageMarkdownBlockInner({
  block,
  tailMarker,
  onOpenBrowserLink,
  onOpenProjectPath,
}: {
  block: TextBlock
  tailMarker?: LooseOptional<ConversationMessageRunMarker>
  formatPathForDisplay?: (path: string) => string
  onOpenBrowserLink?: (url: string) => void | Promise<void>
  onOpenProjectPath?: (path: string) => unknown
}): Nullable<ReactElement> {
  const { t } = useConversationI18n()
  const markdownContentRef = useRef<HTMLDivElement>(null)
  const streamdownText = useMemo(() => prepareStreamdownMarkdownText(block.text), [block.text])
  const tailMarkerNode = useMemo(
    () => (tailMarker ? <MessageStatusMarker marker={tailMarker} /> : null),
    [tailMarker]
  )
  const components = useMessageMarkdownComponents(
    onOpenBrowserLink,
    onOpenProjectPath,
    t('browser.openExternal'),
    { isStreaming: false, tailNode: tailMarkerNode }
  )

  useLayoutEffect(() => {
    activateMarkdownTailMarker({
      container: markdownContentRef.current,
      inlineSlotSelector: `.${styles.markdownTailMarkerSlot}`,
      fallbackSlotSelector: `.${styles.markdownTailMarkerFallbackSlot}`,
    })
  }, [streamdownText, tailMarker])

  if (isBlank(block.text)) return null

  return (
    <div
      ref={markdownContentRef}
      className={cx(
        'markdownContent',
        !!tailMarker && 'markdownContentWithTailMarker',
        block.tone === 'error' && 'markdownError'
      )}
    >
      <MessageStreamdown text={streamdownText} isStreaming={false} components={components} />
      {!!tailMarkerNode && (
        <span className={styles.markdownTailMarkerFallbackSlot}>{tailMarkerNode}</span>
      )}
    </div>
  )
}

export const MessageMarkdownBlock = memo(MessageMarkdownBlockInner)
MessageMarkdownBlock.displayName = 'MessageMarkdownBlock'

function StreamingTextBlockInner({
  block,
  animateText,
  isMessageStreaming,
  tailMarker,
  onOpenBrowserLink,
  onOpenProjectPath,
}: {
  block: TextBlock
  animateText: boolean
  isMessageStreaming: boolean
  tailMarker?: LooseOptional<ConversationMessageRunMarker>
  formatPathForDisplay?: (path: string) => string
  onOpenBrowserLink?: (url: string) => void | Promise<void>
  onOpenProjectPath?: (path: string) => unknown
}): Nullable<ReactElement> {
  const { t } = useConversationI18n()
  const markdownContentRef = useRef<HTMLDivElement>(null)
  // 直接渲染状态层文本:打字节奏由 ChatStreamPacer 单点起搏,组件不再叠加第二层揭示动画。
  const streamdownText = useMemo(() => prepareStreamdownMarkdownText(block.text), [block.text])
  const visibleTailMarker = isMessageStreaming ? null : tailMarker
  const tailMarkerNode = useMemo(
    () => (visibleTailMarker ? <MessageStatusMarker marker={visibleTailMarker} /> : null),
    [visibleTailMarker]
  )
  const components = useMessageMarkdownComponents(
    onOpenBrowserLink,
    onOpenProjectPath,
    t('browser.openExternal'),
    { isStreaming: animateText, tailNode: tailMarkerNode }
  )

  useLayoutEffect(() => {
    activateMarkdownTailMarker({
      container: markdownContentRef.current,
      inlineSlotSelector: `.${styles.markdownTailMarkerSlot}`,
      fallbackSlotSelector: `.${styles.markdownTailMarkerFallbackSlot}`,
    })
  }, [streamdownText, visibleTailMarker])

  if (isBlank(block.text)) return null

  return (
    <div className={styles.streamingMarkdownStack}>
      <div
        ref={markdownContentRef}
        className={cx(
          'markdownContent',
          'streamingMarkdownChunk',
          !!visibleTailMarker && 'markdownContentWithTailMarker'
        )}
      >
        <MessageStreamdown
          text={streamdownText}
          isStreaming={animateText}
          components={components}
        />
        {!!tailMarkerNode && (
          <span className={styles.markdownTailMarkerFallbackSlot}>{tailMarkerNode}</span>
        )}
      </div>
    </div>
  )
}

export const StreamingTextBlock = memo(StreamingTextBlockInner)
StreamingTextBlock.displayName = 'StreamingTextBlock'
