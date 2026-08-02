import {
  lazy,
  memo,
  type ReactElement,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { prepareStreamdownMarkdownText } from '../markdown/streamdownMarkdownSource.utils'
import type { UserActionResolution } from '../projection'
import { useTimerScope } from '../react-hooks/useTimerScope'
import { type ConversationRenderSlots,useConversationRenderSlots } from '../render-slots'
import { ReplaceableRenderSlot } from '../render-slots/ReplaceableRenderSlot'
import { shouldRenderToolBlockCompact } from '../tool-render/messageBubbleToolModel'

import { shouldUseLiveTextRenderer } from './liveTextRendererMode'
import { areRunMarkersEqual, type ConversationMessageRunMarker } from './messageBubbleRenderModel'

import styles from './MessageBubble.module.css'

import type { ContentBlock, TextBlock, UserActionCardResult } from '#contracts'
import { isBlank, optionalWhenLazy, toNullable } from '#internal/runtime'

const LazyMessageMarkdownBlock = lazy(async () =>
  import('./MessageMarkdownBlocks').then((module) => ({
    default: module.MessageMarkdownBlock,
  }))
)

const LazyStreamingTextBlock = lazy(async () =>
  import('./MessageMarkdownBlocks').then((module) => ({
    default: module.StreamingTextBlock,
  }))
)

const LazyThinkingBlock = lazy(async () =>
  import('./MessageMarkdownBlocks').then((module) => ({
    default: module.ThinkingBlock,
  }))
)

const LazyToolCallBlock = lazy(async () =>
  import('../tool-render/ToolCallBlock').then((module) => ({
    default: module.ToolCallBlock,
  }))
)

const LazyHtmlArtifactBlock = lazy(async () =>
  import('../artifacts/HtmlArtifactBlock').then((module) => ({
    default: module.HtmlArtifactBlock,
  }))
)

type MessageContentBlockRenderContext = {
  isStreaming: boolean
  autoCollapseThinking: boolean
  sessionId: string
  messageId: string
  runMarker: LooseOptional<ConversationMessageRunMarker>
  planUpdateIndex?: number
  blockIndex?: number
  formatPathForDisplay?: (path: string) => string
  onOpenBrowserLink?: (url: string) => void | Promise<void>
  onOpenProjectPath?: (path: string) => unknown
  activeUserActionCardIds?: readonly string[]
  onResolveUserActionCard?: (request: UserActionCardResult) => void | Promise<void>
  consumedScheduledTaskProposalIds?: ReadonlySet<string>
  onScheduledTaskProposalConsumed?: (proposalId: string) => void
  onTranslateThinkingBlock?: (request: {
    messageId: string
    blockIndex: number
    text: string
  }) => Promise<void>
  /** 宿主专属黑名单卡件 / viewmodel 容器的注入 render-slot（§12.9 封闭具名集合）。 */
  slots: ConversationRenderSlots
}

type StructuredBlockRenderer = (
  block: ContentBlock,
  ctx: MessageContentBlockRenderContext
) => Nullable<ReactElement>

interface MessageContentBlockProps {
  block: ContentBlock
  isStreaming: boolean
  autoCollapseThinking?: boolean
  animateStreamingText: boolean
  sessionId: string
  messageId: string
  runMarker?: LooseOptional<ConversationMessageRunMarker>
  planUpdateIndex?: number
  blockIndex?: number
  formatPathForDisplay?: (path: string) => string
  onOpenBrowserLink?: (url: string) => void | Promise<void>
  onOpenProjectPath?: (path: string) => unknown
  activeUserActionCardIds?: readonly string[]
  onResolveUserActionCard?: (request: UserActionCardResult) => void | Promise<void>
  consumedScheduledTaskProposalIds?: ReadonlySet<string>
  onScheduledTaskProposalConsumed?: (proposalId: string) => void
  onTranslateThinkingBlock?: (request: {
    messageId: string
    blockIndex: number
    text: string
  }) => Promise<void>
}

const STRUCTURED_BLOCK_RENDERERS = {
  'tool-call': (block, ctx) => (
    <Suspense fallback={null}>
      <LazyToolCallBlock
        block={block as Extract<ContentBlock, { type: 'tool-call' }>}
        compact={shouldRenderToolBlockCompact(
          (block as Extract<ContentBlock, { type: 'tool-call' }>).toolName
        )}
        sessionId={ctx.sessionId}
        planUpdateIndex={ctx.planUpdateIndex}
        formatPathForDisplay={ctx.formatPathForDisplay}
      />
    </Suspense>
  ),
  thinking: (block, ctx) => (
    <Suspense fallback={null}>
      <LazyThinkingBlock
        block={block as Extract<ContentBlock, { type: 'thinking' }>}
        isStreaming={ctx.isStreaming}
        autoCollapse={ctx.autoCollapseThinking}
        messageId={ctx.messageId}
        blockIndex={ctx.blockIndex}
        onTranslateThinkingBlock={ctx.onTranslateThinkingBlock}
      />
    </Suspense>
  ),
  'html-artifact': (block) => (
    <Suspense fallback={null}>
      <LazyHtmlArtifactBlock block={block as Extract<ContentBlock, { type: 'html-artifact' }>} />
    </Suspense>
  ),
  'system-tool-install-suggestion': (block, ctx) =>
    ctx.slots.systemToolInstall({
      block: block as Extract<ContentBlock, { type: 'system-tool-install-suggestion' }>,
    }),
  'capability-auto-approval': (block, ctx) =>
    ctx.slots.capabilityAutoApprovalNotice({
      block: block as Extract<ContentBlock, { type: 'capability-auto-approval' }>,
    }),
  'user-action-card': (block, ctx) => {
    const userActionBlock = block as Extract<ContentBlock, { type: 'user-action-card' }>
    const card = userActionBlock.card
    const isActiveBlockingCard = card.blocking && !!ctx.activeUserActionCardIds?.includes(card.id)
    // 提问卡（wizard）作答后不消失、只禁用：跳过"已消费即隐藏"的全局规则，保持挂载并展示用户所选。
    // 非 wizard 的可见性（已消费/超时）谓词在宿主 userActionCard slot 实现内应用（不可见回 null）。
    const isWizardCard = card.form?.presentation === 'wizard'

    const onActionComplete = optionalWhenLazy(
      isActiveBlockingCard,
      () => (resolution: UserActionResolution) =>
        ctx.onResolveUserActionCard?.({
          cardId: card.id,
          approved: resolution.approved,
          actionKind: resolution.actionKind,
          message: resolution.message,
          values: resolution.values,
          timedOut: resolution.timedOut,
        })
    )

    if (isWizardCard)
      return ctx.slots.askUser({
        block: userActionBlock,
        sessionId: ctx.sessionId,
        disabled: card.blocking && !isActiveBlockingCard,
        onActionComplete,
      })

    return ctx.slots.userActionCard({
      block: userActionBlock,
      sessionId: ctx.sessionId,
      disabled: card.blocking && !isActiveBlockingCard,
      activeUserActionCardIds: ctx.activeUserActionCardIds,
      onActionComplete,
      onOpenArtifact: ctx.onOpenProjectPath,
    })
  },
  'project-auto-approval': () => null,
  'assistant-generated-file': () => null,
  'assistant-source': () => null,
  'scheduled-task-proposal': (block, ctx) => {
    const proposalBlock = block as Extract<ContentBlock, { type: 'scheduled-task-proposal' }>

    return ctx.slots.scheduledTaskProposal({
      block: proposalBlock,
      consumed: !!ctx.consumedScheduledTaskProposalIds?.has(proposalBlock.proposal.id),
      onConsumed: ctx.onScheduledTaskProposalConsumed,
    })
  },
  'flagged-task': (block, ctx) =>
    ctx.slots.flaggedTaskSuggestion({
      block: block as Extract<ContentBlock, { type: 'flagged-task' }>,
      sessionId: ctx.sessionId,
    }),
} satisfies Record<Exclude<ContentBlock['type'], 'text'>, StructuredBlockRenderer>

function getStructuredBlockRenderer(blockType: string): Nullable<StructuredBlockRenderer> {
  return toNullable(
    (STRUCTURED_BLOCK_RENDERERS as Partial<Record<string, StructuredBlockRenderer>>)[blockType]
  )
}

function PlainTextBlockFallback({ block }: { block: TextBlock }): ReactElement {
  const className =
    block.tone === 'error'
      ? `${styles.markdownContent} ${styles.markdownError}`
      : styles.markdownContent

  return (
    <div className={className}>
      <p className={styles.textContent}>{block.text}</p>
    </div>
  )
}

function useAfterFirstPaint(): boolean {
  const [ready, setReady] = useState(false)
  const timers = useTimerScope('MessageContentBlock.afterFirstPaint')

  useEffect(() => {
    let secondFrame: Nullable<ReturnType<typeof timers.nextFrame>> = null
    const firstFrame = timers.nextFrame(
      () => {
        secondFrame = timers.nextFrame(() => setReady(true), {
          label: 'chat.richMarkdown.ready',
        })
      },
      { label: 'chat.richMarkdown.afterPaint' }
    )

    return () => {
      firstFrame.cancel()
      secondFrame?.cancel()
    }
  }, [timers])

  return ready
}

function DeferredMessageMarkdownBlock({
  block,
  tailMarker,
  formatPathForDisplay,
  onOpenBrowserLink,
  onOpenProjectPath,
}: {
  block: TextBlock
  tailMarker?: LooseOptional<ConversationMessageRunMarker>
  formatPathForDisplay?: (path: string) => string
  onOpenBrowserLink?: (url: string) => void | Promise<void>
  onOpenProjectPath?: (path: string) => unknown
}): ReactElement {
  const richRendererReady = useAfterFirstPaint()
  const fallback = <PlainTextBlockFallback block={block} />

  if (!richRendererReady) return fallback

  return (
    <Suspense fallback={fallback}>
      <LazyMessageMarkdownBlock
        block={block}
        tailMarker={tailMarker}
        formatPathForDisplay={formatPathForDisplay}
        onOpenBrowserLink={onOpenBrowserLink}
        onOpenProjectPath={onOpenProjectPath}
      />
    </Suspense>
  )
}

/**
 * `messageMarkdown` 替换槽的改道点 —— 就开在**官方件的硬 lazy-import 那一层**。
 *
 * 开在这里而不是 `MessageMarkdownBlocks` 内部，是因为「替换 markdown 渲染器」的全部意义就是不再
 * 为它付钱：官方件是 `lazy()` 分包（Streamdown + 高亮 + 数学），在此改道则替换件生效时那个分包
 * 根本不会被拉起；开在包内部则永远先加载一遍被替换掉的东西。
 *
 * `text` 给的是官方件逐字消费的那份（`prepareStreamdownMarkdownText` 产物），替换件与被替换件输入
 * 逐字节相同。该函数只在槽位存在时才调用——槽位缺席这条路上零额外计算，官方件自己 `useMemo` 照旧。
 */
function renderReplaceableMarkdown({
  slot,
  block,
  isStreaming,
  official,
}: {
  slot: ConversationRenderSlots['messageMarkdown']
  block: TextBlock
  isStreaming: boolean
  official: ReactElement
}): ReactElement {
  if (!slot) return official

  return (
    <ReplaceableRenderSlot
      scope="conversation.message.markdown"
      render={slot}
      props={{ text: prepareStreamdownMarkdownText(block.text), isStreaming }}
      fallback={official}
    />
  )
}

function MessageContentBlockInner({
  block,
  isStreaming,
  autoCollapseThinking = false,
  animateStreamingText,
  sessionId,
  messageId,
  runMarker = null,
  planUpdateIndex,
  blockIndex,
  formatPathForDisplay,
  onOpenBrowserLink,
  onOpenProjectPath,
  activeUserActionCardIds,
  onResolveUserActionCard,
  consumedScheduledTaskProposalIds,
  onScheduledTaskProposalConsumed,
  onTranslateThinkingBlock,
}: MessageContentBlockProps): Nullable<ReactElement> {
  const hasRenderedLiveTextRef = useRef(false)
  const slots = useConversationRenderSlots()

  const useLiveTextRenderer =
    block.type === 'text' &&
    !isBlank(block.text) &&
    shouldUseLiveTextRenderer({
      isStreaming,
      animateStreamingText,
      hasRenderedLiveText: hasRenderedLiveTextRef.current,
    })

  // 「本块已走过 live 渲染器」是**跨渲染的持久事实**，必须等 commit 之后才落笔：
  // 写在渲染体里会被 StrictMode 的双渲染、以及并发模式下被丢弃的渲染污染——那些渲染的
  // 结果不上屏，flag 却已置真，于是块被永久锁死在 live 分支。放进 layout effect 后语义不变：
  // 首次决定走 live 的那一帧本来就是靠 isStreaming 判出来的，flag 只影响其后的帧。
  // 判定必须整体前置到所有早返之前，否则就是条件调用 hook（rules-of-hooks）。
  useLayoutEffect(() => {
    if (useLiveTextRenderer) hasRenderedLiveTextRef.current = true
  }, [useLiveTextRenderer])

  if (block.type !== 'text') {
    const renderer = getStructuredBlockRenderer(block.type)
    if (!renderer) return null

    return renderer(block, {
      isStreaming,
      autoCollapseThinking,
      sessionId,
      messageId,
      runMarker,
      planUpdateIndex,
      blockIndex,
      formatPathForDisplay,
      onOpenBrowserLink,
      onOpenProjectPath,
      activeUserActionCardIds,
      onResolveUserActionCard,
      consumedScheduledTaskProposalIds,
      onScheduledTaskProposalConsumed,
      onTranslateThinkingBlock,
      slots,
    })
  }

  if (isBlank(block.text)) return null

  if (useLiveTextRenderer) return renderReplaceableMarkdown({
      slot: slots.messageMarkdown,
      block,
      isStreaming,
      official: (
        <Suspense fallback={<PlainTextBlockFallback block={block} />}>
          <LazyStreamingTextBlock
            block={block}
            animateText={isStreaming && animateStreamingText}
            isMessageStreaming={isStreaming}
            tailMarker={!isStreaming && runMarker ? runMarker : null}
            formatPathForDisplay={formatPathForDisplay}
            onOpenBrowserLink={onOpenBrowserLink}
            onOpenProjectPath={onOpenProjectPath}
          />
        </Suspense>
      ),
    })

  // 走到这里必然 `isStreaming === false`（`shouldUseLiveTextRenderer` 对 streaming 恒真），
  // 因此替换件在这条路上拿到的 `isStreaming` 只可能是 false。
  return renderReplaceableMarkdown({
    slot: slots.messageMarkdown,
    block,
    isStreaming,
    official: (
      <DeferredMessageMarkdownBlock
        block={block}
        tailMarker={runMarker}
        formatPathForDisplay={formatPathForDisplay}
        onOpenBrowserLink={onOpenBrowserLink}
        onOpenProjectPath={onOpenProjectPath}
      />
    ),
  })
}

function areTextBlockPropsEqual(
  prev: Readonly<MessageContentBlockProps>,
  next: Readonly<MessageContentBlockProps>
): boolean {
  if (prev.isStreaming !== next.isStreaming) return false

  return (
    prev.formatPathForDisplay === next.formatPathForDisplay &&
    prev.onOpenBrowserLink === next.onOpenBrowserLink &&
    prev.onOpenProjectPath === next.onOpenProjectPath &&
    (!prev.isStreaming || prev.animateStreamingText === next.animateStreamingText) &&
    (prev.isStreaming || areRunMarkersEqual(prev.runMarker, next.runMarker))
  )
}

function areThinkingBlockPropsEqual(
  prev: Readonly<MessageContentBlockProps>,
  next: Readonly<MessageContentBlockProps>
): boolean {
  return (
    prev.isStreaming === next.isStreaming &&
    !!prev.autoCollapseThinking === !!next.autoCollapseThinking &&
    prev.messageId === next.messageId &&
    prev.blockIndex === next.blockIndex &&
    prev.onTranslateThinkingBlock === next.onTranslateThinkingBlock
  )
}

function areToolCallBlockPropsEqual(
  prev: Readonly<MessageContentBlockProps>,
  next: Readonly<MessageContentBlockProps>
): boolean {
  return (
    prev.sessionId === next.sessionId &&
    prev.planUpdateIndex === next.planUpdateIndex &&
    prev.formatPathForDisplay === next.formatPathForDisplay
  )
}

function areUserActionCardBlockPropsEqual(
  prev: Readonly<MessageContentBlockProps>,
  next: Readonly<MessageContentBlockProps>
): boolean {
  return (
    prev.sessionId === next.sessionId &&
    prev.activeUserActionCardIds === next.activeUserActionCardIds &&
    prev.onResolveUserActionCard === next.onResolveUserActionCard
  )
}

function isScheduledTaskProposalConsumed(props: Readonly<MessageContentBlockProps>): boolean {
  const block = props.block as Extract<ContentBlock, { type: 'scheduled-task-proposal' }>

  return !!props.consumedScheduledTaskProposalIds?.has(block.proposal.id)
}

function areScheduledTaskProposalBlockPropsEqual(
  prev: Readonly<MessageContentBlockProps>,
  next: Readonly<MessageContentBlockProps>
): boolean {
  return (
    isScheduledTaskProposalConsumed(prev) === isScheduledTaskProposalConsumed(next) &&
    prev.onScheduledTaskProposalConsumed === next.onScheduledTaskProposalConsumed
  )
}

function areMessageContentBlockPropsEqual(
  prev: Readonly<MessageContentBlockProps>,
  next: Readonly<MessageContentBlockProps>
): boolean {
  if (prev.block !== next.block) return false

  switch (prev.block.type) {
    case 'text':
      return areTextBlockPropsEqual(prev, next)
    case 'thinking':
      return areThinkingBlockPropsEqual(prev, next)
    case 'tool-call':
      return areToolCallBlockPropsEqual(prev, next)
    case 'html-artifact':
      return true
    case 'user-action-card':
      return areUserActionCardBlockPropsEqual(prev, next)
    case 'system-tool-install-suggestion':
    case 'capability-auto-approval':
    case 'project-auto-approval':
      return true
    case 'scheduled-task-proposal':
      return areScheduledTaskProposalBlockPropsEqual(prev, next)
    // 卡片状态由 flaggedTaskStore 订阅驱动，block 与 sessionId 相同即等价。
    case 'flagged-task':
      return prev.sessionId === next.sessionId
    case 'assistant-generated-file':
    case 'assistant-source':
      return true
  }
}

export const MessageContentBlock = memo(MessageContentBlockInner, areMessageContentBlockPropsEqual)

MessageContentBlock.displayName = 'MessageContentBlock'
