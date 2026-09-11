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
import { useTimerScope } from '../react-hooks/useTimerScope'

import { useConversationBlockHooks } from './conversationBlockHooks'
import type { ConversationMessageRunMarker } from './messageBubbleRenderModel'
import { MessageStatusMarker } from './MessageStatusMarker'
import {
  createStreamFadeLedgerStore,
  planStreamFade,
  readStreamFadeClock,
  renderStreamFadeText,
  settleStreamFade,
  type StreamFadeChunk,
  StreamFadeMarkdownText,
  StreamFadeMarkdownTextTagName,
  type StreamFadeRenderScope,
  StreamFadeRenderScopeContext,
  StreamTextFadeDurationMs,
  velarStreamFadeTextPlugin,
} from './streamTextFade'
import {
  getStreamingThinkingDisplayWindow,
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
import { isBlank, isPresent, toNullable } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)
const MESSAGE_STREAMDOWN_CLASS_NAME = 'space-y-0'
const StreamingTextAnimationKeyContext = createContext<Nullable<string>>(null)
const StreamingTextFadeLedgers = createStreamFadeLedgerStore(1_000)
const ThinkingTextFadeLedgers = createStreamFadeLedgerStore(500)
const StreamFadeMarkdownComponents = { [StreamFadeMarkdownTextTagName]: StreamFadeMarkdownText }

/**
 * 流式正文的解析块：Streamdown 在 streaming 模式里只重解析最后一个块。每个块按内容算一次淡入
 * 计划（见 `streamTextFade`），经 context 交给插件标好的文本节点去切分；块内容没变就沿用上一份
 * 计划，Streamdown 的块 memo 与文字组件都不重渲染——已经写完的段落不会每帧跟着重画。
 */
function PersistentStreamingTextBlock(props: StreamdownBlockProps): ReactElement {
  const animationKey = useContext(StreamingTextAnimationKeyContext)
  const { isAnimating } = useContext(StreamdownContext)
  const ledgerKey = isAnimating && animationKey ? `${animationKey}:streamdown:${props.index}` : null
  const fading = isPresent(ledgerKey)
  const committedRef = useRef(false)
  const scope = useMemo<Nullable<StreamFadeRenderScope>>(
    () =>
      ledgerKey
        ? {
            chunks: planStreamFade({
              ledger: StreamingTextFadeLedgers.get(ledgerKey),
              now: readStreamFadeClock(),
              sourceLength: props.content.length,
              mounted: committedRef.current,
            }),
            report: { textLength: 0 },
          }
        : null,
    [ledgerKey, props.content]
  )
  const rehypePlugins = useMemo(
    () =>
      fading ? [...(props.rehypePlugins ?? []), velarStreamFadeTextPlugin] : props.rehypePlugins,
    [fading, props.rehypePlugins]
  )
  const components = useMemo(
    () =>
      fading
        ? ({ ...props.components, ...StreamFadeMarkdownComponents } as StreamdownComponents)
        : props.components,
    [fading, props.components]
  )

  useLayoutEffect(() => {
    if (!ledgerKey || !scope) return
    StreamingTextFadeLedgers.set(ledgerKey, settleStreamFade(scope.chunks, scope.report.textLength))
    committedRef.current = true
  }, [ledgerKey, scope])

  return (
    <StreamFadeRenderScopeContext.Provider value={scope}>
      <StreamdownBlock
        {...props}
        animatePlugin={null}
        components={components}
        rehypePlugins={rehypePlugins}
      />
    </StreamFadeRenderScopeContext.Provider>
  )
}

/**
 * 流式思考的淡入批次。思考只显示末尾一段窗口，窗口会随新字往后滑，所以偏移按整段思考原文计，
 * 渲染时再换算到窗口里；账本同样只在提交后写入。
 */
function useThinkingTextFadeChunks({
  isStreaming,
  blockKey,
  textLength,
}: {
  isStreaming: boolean
  blockKey: string
  textLength: number
}): readonly StreamFadeChunk[] {
  const committedRef = useRef(false)
  const ledger = useMemo(
    () =>
      isStreaming
        ? settleStreamFade(
            planStreamFade({
              ledger: ThinkingTextFadeLedgers.get(blockKey),
              now: readStreamFadeClock(),
              sourceLength: textLength,
              mounted: committedRef.current,
            }),
            textLength
          )
        : null,
    [blockKey, isStreaming, textLength]
  )

  useLayoutEffect(() => {
    if (!ledger) return
    ThinkingTextFadeLedgers.set(blockKey, ledger)
    committedRef.current = true
  }, [blockKey, ledger])

  return ledger?.chunks ?? []
}

/**
 * 流式结束后再留一个淡入时长才切到静态渲染：最后一批字还在淡入，立刻换渲染器会把它们一下子
 * 顶成不透明。状态在渲染期同步推导，切换那一帧不会先闪一次静态渲染。
 */
function useStreamFadeTail(streaming: boolean): boolean {
  const [previousStreaming, setPreviousStreaming] = useState(streaming)
  const [tailing, setTailing] = useState(false)
  const timers = useTimerScope('StreamingTextBlock.fadeTail')
  if (previousStreaming !== streaming) {
    setPreviousStreaming(streaming)
    setTailing(!streaming)
  }

  useEffect(() => {
    if (!tailing) return
    const lease = timers.after(StreamTextFadeDurationMs, () => setTailing(false), {
      label: 'chat.streamingText.fadeTail',
    })
    return () => {
      lease.cancel()
    }
  }, [tailing, timers])

  return streaming || tailing
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
  const displayWindow = getStreamingThinkingDisplayWindow(fullDisplayText, {
    streaming: isStreaming,
  })
  const blockKey = `${messageId}:${blockIndex ?? 'thinking'}:${block.streamId ?? 'stream'}`
  const fadeChunks = useThinkingTextFadeChunks({
    isStreaming,
    blockKey,
    textLength: fullDisplayText.length,
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

  if (isBlank(fullDisplayText)) return null

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
        {displayWindow.truncated ? '...\n' : null}
        {isStreaming
          ? renderStreamFadeText(displayWindow.text, displayWindow.start, fadeChunks)
          : displayWindow.text}
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
  // 直接渲染状态层文本:打字节奏由 ChatStreamPacer 单点起搏,这里只给刚上屏的字加淡入。
  const streamdownText = useMemo(() => prepareStreamdownMarkdownText(block.text), [block.text])
  const fadeActive = useStreamFadeTail(animateText)
  // 收尾标记等最后一批字淡完、切到静态渲染之后再出现：它挂在渲染器生成的槽位里，换渲染器会换掉槽位。
  const visibleTailMarker = isMessageStreaming || fadeActive ? null : tailMarker
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
          isStreaming={fadeActive}
          animationKey={fadeActive ? animationKey : undefined}
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
