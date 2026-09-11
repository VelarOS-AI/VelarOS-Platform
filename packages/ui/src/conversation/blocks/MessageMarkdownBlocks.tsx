import React, {
  createContext,
  memo,
  type ReactElement,
  type ReactPortal,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { CaretRightIcon, GlobeHemisphereWestIcon } from '@phosphor-icons/react'
import {
  Block as StreamdownBlock,
  type BlockProps as StreamdownBlockProps,
  type Components as StreamdownComponents,
  Streamdown,
  StreamdownContext,
} from 'streamdown'

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
import {
  type MessageMarkdownRuntime,
  MessageMarkdownRuntimeProvider,
  useMessageMarkdownComponents,
} from './useMessageMarkdownComponents'

import styles from './MessageBubble.module.css'

import type { TextBlock, ThinkingBlock as ThinkingContentBlock } from '#contracts'
import { isBlank, isObject, isPresent, isString, toNullable } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)
const MESSAGE_STREAMDOWN_CLASS_NAME = 'space-y-0'
const MaxThinkingAnimatedTextKeys = 500
const ThinkingAnimatedTextLengthByKey = new Map<string, number>()
const MaxStreamingTextAnimationKeys = 1_000
const StreamingTextAnimatedLengthByKey = new Map<string, number>()
const StreamingTextAnimationKeyContext = createContext<Nullable<string>>(null)
const StreamFadeExcludedTagNames = new Set(['code', 'pre', 'svg', 'math', 'annotation'])

interface StreamFadeNode {
  type?: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: StreamFadeNode[]
}

interface StreamFadePluginState {
  previousTextLength: number
  renderedTextLength: number
}

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

function rememberStreamingTextAnimatedLength(blockKey: string, textLength: number): void {
  const previousLength = StreamingTextAnimatedLengthByKey.get(blockKey)
  if (isPresent(previousLength)) {
    StreamingTextAnimatedLengthByKey.delete(blockKey)
    StreamingTextAnimatedLengthByKey.set(blockKey, Math.max(previousLength, textLength))
    return
  }

  if (StreamingTextAnimatedLengthByKey.size >= MaxStreamingTextAnimationKeys) {
    const oldestKey = StreamingTextAnimatedLengthByKey.keys().next().value
    if (isString(oldestKey)) StreamingTextAnimatedLengthByKey.delete(oldestKey)
  }
  StreamingTextAnimatedLengthByKey.set(blockKey, textLength)
}

function isStreamFadeNode(value: unknown): value is StreamFadeNode {
  return isObject(value)
}

function createStreamFadeTextNode(value: string): StreamFadeNode {
  return { type: 'text', value }
}

function createStreamFadeAnimatedNode(value: string): StreamFadeNode {
  return {
    type: 'element',
    tagName: 'span',
    properties: { 'data-velar-stream-fade': true },
    children: [createStreamFadeTextNode(value)],
  }
}

export function resolveIncrementalStreamFadeText({
  previousTextLength,
  text,
  textStart,
}: {
  previousTextLength: number
  text: string
  textStart: number
}): { newText: string; unchangedText: string } {
  const textEnd = textStart + text.length
  if (isBlank(text) || textEnd <= previousTextLength) return { newText: '', unchangedText: text }

  const unchangedLength = Math.max(0, Math.min(text.length, previousTextLength - textStart))
  const unchangedText = text.slice(0, unchangedLength)
  const newText = text.slice(unchangedLength)
  if (isBlank(newText)) return { newText: '', unchangedText: text }

  return { newText, unchangedText }
}

export function resolveStreamingTextFadeBaseline(rememberedTextLength?: number): number {
  // 首次观察可能是刚创建的文本块，也可能是切回后已积累很长的运行中消息。统一把现有内容当基线，
  // 等下一次增量再淡入，才能从构造上杜绝整段/整屏重播。
  return rememberedTextLength ?? Number.MAX_SAFE_INTEGER
}

function animateNewStreamFadeText(
  node: StreamFadeNode,
  state: StreamFadePluginState,
  cursor: { textLength: number }
): StreamFadeNode[] {
  const value = node.value ?? ''
  const textStart = cursor.textLength
  const textEnd = textStart + value.length
  cursor.textLength = textEnd
  const { newText, unchangedText } = resolveIncrementalStreamFadeText({
    previousTextLength: state.previousTextLength,
    text: value,
    textStart,
  })
  if (!newText) return [node]

  return [
    ...(unchangedText ? [createStreamFadeTextNode(unchangedText)] : []),
    createStreamFadeAnimatedNode(newText),
  ]
}

function applyStreamFadeToNode(
  node: StreamFadeNode,
  state: StreamFadePluginState,
  cursor: { textLength: number },
  excluded = false
): void {
  const nextExcluded =
    excluded || (node.type === 'element' && StreamFadeExcludedTagNames.has(node.tagName ?? ''))
  if (nextExcluded || !node.children) return

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index]
    if (!child) continue

    if (child.type === 'text') {
      const replacements = animateNewStreamFadeText(child, state, cursor)
      node.children.splice(index, 1, ...replacements)
      index += replacements.length - 1
      continue
    }

    applyStreamFadeToNode(child, state, cursor)
  }
}

function createIncrementalStreamFadePlugin(state: StreamFadePluginState) {
  return function incrementalStreamFadePlugin() {
    return (tree: unknown): void => {
      if (!isStreamFadeNode(tree)) return

      const cursor = { textLength: 0 }
      applyStreamFadeToNode(tree, state, cursor)
      state.renderedTextLength = cursor.textLength
    }
  }
}

/**
 * Streamdown 会在 streaming 模式里重解析最后一个 Markdown block。这里为每个解析块维护持久长度，
 * 只把这次真正新增的尾部包成一个 span；旧节点、会话重挂载和完成态重组都不会重新淡入。
 */
function PersistentStreamingTextBlock(props: StreamdownBlockProps): ReactElement {
  const animationKey = useContext(StreamingTextAnimationKeyContext)
  const { isAnimating } = useContext(StreamdownContext)
  const persistentBlockKey = animationKey ? `${animationKey}:streamdown:${props.index}` : null
  const pluginStateRef = useRef<StreamFadePluginState>({
    previousTextLength: 0,
    renderedTextLength: 0,
  })
  const committedBlockKeyRef = useRef<Nullable<string>>(null)
  const incrementalFadePlugin = useMemo(
    () => createIncrementalStreamFadePlugin(pluginStateRef.current),
    []
  )
  const shouldAnimate = isAnimating && isPresent(persistentBlockKey)
  const hasCommittedCurrentBlock = committedBlockKeyRef.current === persistentBlockKey
  const pluginState = pluginStateRef.current
  pluginState.previousTextLength = shouldAnimate
    ? resolveStreamingTextFadeBaseline(
        hasCommittedCurrentBlock
          ? StreamingTextAnimatedLengthByKey.get(persistentBlockKey)
          : undefined
      )
    : Number.MAX_SAFE_INTEGER
  pluginState.renderedTextLength = 0
  const rehypePlugins = useMemo(
    () =>
      shouldAnimate ? [...(props.rehypePlugins ?? []), incrementalFadePlugin] : props.rehypePlugins,
    [incrementalFadePlugin, props.rehypePlugins, shouldAnimate]
  )

  useLayoutEffect(() => {
    if (!shouldAnimate || !persistentBlockKey) return

    rememberStreamingTextAnimatedLength(persistentBlockKey, pluginState.renderedTextLength)
    committedBlockKeyRef.current = persistentBlockKey
  }, [persistentBlockKey, pluginState, props.content, shouldAnimate])

  return <StreamdownBlock {...props} animatePlugin={null} rehypePlugins={rehypePlugins} />
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
      <span
        key={`${normalizedStartIndex}:${characters.length}`}
        className={styles.thinkingPlainTextStreamingChar}
      >
        {characters.slice(normalizedStartIndex).join('')}
      </span>
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
  const committedBlockKeyRef = useRef<Nullable<string>>(null)
  const textLength = useMemo(() => countDisplayCharacters(text), [text])
  const animatedTextStartIndex = useMemo(() => {
    if (!isStreaming) return textLength
    if (committedBlockKeyRef.current !== blockKey) return textLength

    const rememberedLength = ThinkingAnimatedTextLengthByKey.get(blockKey)
    return isPresent(rememberedLength) ? Math.min(rememberedLength, textLength) : textLength
  }, [blockKey, isStreaming, textLength])

  useLayoutEffect(() => {
    if (!isStreaming) return

    rememberThinkingAnimatedTextLength(blockKey, textLength)
    committedBlockKeyRef.current = blockKey
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
  const wasStreamingRef = useRef(isStreaming)
  const { mounted: isMounted, visible: isVisible } = useDisclosurePresence(expanded)
  const fullDisplayText = getThinkingBlockDisplayText(block, locale)
  const displayText = getStreamingThinkingDisplayText(fullDisplayText, {
    streaming: isStreaming,
  })
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
    const wasStreaming = wasStreamingRef.current
    wasStreamingRef.current = isStreaming
    if (wasStreaming && !isStreaming) setExpanded(false)
  }, [isStreaming])

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

  const thinkingContent = (
    <>
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
            <span>{isTranslating ? t('chat.thinkingTranslating') : translateButtonLabel}</span>
          </button>
          {!!translateError && (
            <span className={styles.thinkingTranslateError}>{translateError}</span>
          )}
        </div>
      )}
    </>
  )

  if (shouldRenderThinkingAsFlat({ autoCollapse, isStreaming }))
    return (
      <div className={styles.liveThinkingBlock} data-thinking-presentation="flat">
        <div className={styles.liveThinkingLabel}>{label}</div>
        {thinkingContent}
      </div>
    )

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
            <div className={styles.toolActivityBody}>{thinkingContent}</div>
          </div>
        </div>
      )}
    </div>
  )
}

export function shouldRenderThinkingAsFlat({
  autoCollapse,
  isStreaming,
}: {
  autoCollapse: boolean
  isStreaming: boolean
}): boolean {
  return isStreaming && !autoCollapse
}

export const ThinkingBlock = memo(ThinkingBlockInner)
ThinkingBlock.displayName = 'ThinkingBlock'

function MessageStreamdownInner({
  text,
  isStreaming,
  animationKey,
  components,
  runtime,
}: {
  text: string
  isStreaming: boolean
  animationKey?: string
  components: StreamdownComponents
  runtime: MessageMarkdownRuntime
}): ReactElement {
  return (
    <MessageMarkdownRuntimeProvider runtime={runtime}>
      <StreamingTextAnimationKeyContext.Provider value={toNullable(animationKey)}>
        <Streamdown
          mode={resolveStreamdownMarkdownMode({ isStreaming })}
          isAnimating={isStreaming && !!animationKey}
          animated={false}
          BlockComponent={animationKey ? PersistentStreamingTextBlock : undefined}
          plugins={STREAMDOWN_MARKDOWN_PLUGINS}
          linkSafety={STREAMDOWN_MARKDOWN_LINK_SAFETY}
          controls={STREAMDOWN_MARKDOWN_CONTROLS}
          className={MESSAGE_STREAMDOWN_CLASS_NAME}
          components={components}
        >
          {text}
        </Streamdown>
      </StreamingTextAnimationKeyContext.Provider>
    </MessageMarkdownRuntimeProvider>
  )
}

const MessageStreamdown = memo(MessageStreamdownInner)
MessageStreamdown.displayName = 'MessageStreamdown'

/**
 * 状态标记只渲染一份：块级元素末尾都留了空槽，布局阶段挑出真正位于尾部的槽（行内或兜底），
 * 把标记 portal 进去。以前每个段落各渲染一份、再用 CSS 只露一个——长回答里几十棵 Tooltip 树，
 * 标记对象一换引用就全部重画。
 */
function useMarkdownTailMarkerPortal(
  containerRef: RefObject<Nullable<HTMLDivElement>>,
  tailMarkerNode: Nullable<ReactElement>,
  markdownText: string
): Nullable<ReactPortal> {
  const [activeSlot, setActiveSlot] = useState<Nullable<HTMLElement>>(null)
  const hasTailMarker = !!tailMarkerNode

  useLayoutEffect(() => {
    const slot = activateMarkdownTailMarker({
      container: containerRef.current,
      inlineSlotSelector: `.${styles.markdownTailMarkerSlot}`,
      fallbackSlotSelector: `.${styles.markdownTailMarkerFallbackSlot}`,
    })
    setActiveSlot(hasTailMarker ? slot : null)
  }, [containerRef, hasTailMarker, markdownText])

  return tailMarkerNode && activeSlot ? createPortal(tailMarkerNode, activeSlot) : null
}

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
  const { components, runtime } = useMessageMarkdownComponents(
    onOpenBrowserLink,
    onOpenProjectPath,
    t('browser.openExternal'),
    { isStreaming: false, withTailMarkerSlots: !!tailMarkerNode }
  )
  const tailMarkerPortal = useMarkdownTailMarkerPortal(
    markdownContentRef,
    tailMarkerNode,
    streamdownText
  )

  if (isBlank(block.text)) return null

  return (
    <div
      ref={markdownContentRef}
      data-message-markdown-root
      className={cx(
        'markdownContent',
        !!tailMarker && 'markdownContentWithTailMarker',
        block.tone === 'error' && 'markdownError'
      )}
    >
      <MessageStreamdown
        text={streamdownText}
        isStreaming={false}
        components={components}
        runtime={runtime}
      />
      {!!tailMarkerNode && <span className={styles.markdownTailMarkerFallbackSlot} />}
      {tailMarkerPortal}
    </div>
  )
}

export const MessageMarkdownBlock = memo(MessageMarkdownBlockInner)
MessageMarkdownBlock.displayName = 'MessageMarkdownBlock'

function StreamingTextBlockInner({
  block,
  animationKey,
  animateText,
  isMessageStreaming,
  tailMarker,
  onOpenBrowserLink,
  onOpenProjectPath,
}: {
  block: TextBlock
  animationKey: string
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
  const { components, runtime } = useMessageMarkdownComponents(
    onOpenBrowserLink,
    onOpenProjectPath,
    t('browser.openExternal'),
    { isStreaming: animateText, withTailMarkerSlots: !!tailMarkerNode, expansionScope: animationKey }
  )
  const tailMarkerPortal = useMarkdownTailMarkerPortal(
    markdownContentRef,
    tailMarkerNode,
    streamdownText
  )

  if (isBlank(block.text)) return null

  return (
    <div className={styles.streamingMarkdownStack}>
      <div
        ref={markdownContentRef}
        data-message-markdown-root
        className={cx(
          'markdownContent',
          'streamingMarkdownChunk',
          !!visibleTailMarker && 'markdownContentWithTailMarker'
        )}
      >
        <MessageStreamdown
          text={streamdownText}
          isStreaming={animateText}
          animationKey={animateText ? animationKey : undefined}
          components={components}
          runtime={runtime}
        />
        {!!tailMarkerNode && <span className={styles.markdownTailMarkerFallbackSlot} />}
        {tailMarkerPortal}
      </div>
    </div>
  )
}

export const StreamingTextBlock = memo(StreamingTextBlockInner)
StreamingTextBlock.displayName = 'StreamingTextBlock'
