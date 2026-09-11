import React, {
  createContext,
  lazy,
  type ReactElement,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  ArrowSquareOutIcon,
  CaretDoubleDownIcon,
  CaretDoubleUpIcon,
  CodeIcon,
  EyeIcon,
} from '@phosphor-icons/react'
import { useMemoizedFn } from 'ahooks'
import {
  CodeBlock,
  CodeBlockCopyButton,
  CodeBlockDownloadButton,
  type Components as StreamdownComponents,
} from 'streamdown'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Link } from '@velaros-ai/ui/primitives/display/Link'

import { useConversationI18n } from '../i18n'
import {
  normalizeMessageMarkdownFileReference,
  resolveMessageMarkdownHrefTarget,
} from '../markdown/messageMarkdownLinks.utils'
import { useTimerScope } from '../react-hooks/useTimerScope'
import { useConversationRenderSlots } from '../render-slots'
import { ReplaceableRenderSlot } from '../render-slots/ReplaceableRenderSlot'

import styles from './MessageBubble.module.css'

import type { HtmlArtifactBlock as HtmlArtifactContentBlock } from '#contracts'
import { isArray } from '#internal/runtime'
import { isEmpty, isPresent, isString, toNullable, trimmedStringOrEmpty } from '#internal/runtime'

const CodeLanguageClassPattern = /(?:^|\s)language-([^\s]+)/u
const DefaultCodeBlockLanguage = 'text'
const DiagramCodeBlockLanguages = new Set(['mermaid'])
const RenderableHtmlCodeBlockLanguages = new Set(['html', 'htm'])
const TailMarkerCandidateTags = ['p', 'li', 'h1', 'h2', 'h3', 'h4'] as const
// PERF GUARD: 不要静态导入 HtmlArtifactBlock；它会继续拉入 HtmlPreviewFrame 和源码预览，
// 导致普通 markdown 消息也为从未打开的 HTML 预览支付首屏成本。
const LazyHtmlArtifactBlock = lazy(async () =>
  import('../artifacts/HtmlArtifactBlock').then((module) => ({
    default: module.HtmlArtifactBlock,
  }))
)

const ConversationExpandableViewportHeightPx = 400
const ConversationExpandableViewportOverflowTolerancePx = 1

function readCodeLanguage(className: unknown): string {
  if (!isString(className)) return ''

  return className.match(CodeLanguageClassPattern)?.[1]?.toLowerCase() ?? ''
}

function normalizeCodeBlockClassName(className: unknown): string {
  const normalizedClassName = trimmedStringOrEmpty(className)
  if (readCodeLanguage(normalizedClassName)) return normalizedClassName

  return [normalizedClassName, `language-${DefaultCodeBlockLanguage}`].filter(Boolean).join(' ')
}

function readCodeText(children: unknown): string {
  return isString(children) ? children : ''
}

function isRenderableHtmlCodeBlockLanguage(language: string): boolean {
  return RenderableHtmlCodeBlockLanguages.has(language)
}

function openUrlInExternalBrowser(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

function isPrimaryPointerClick(event: React.MouseEvent<HTMLElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

function MarkdownExternalOpenButton({ label, url }: { label: string; url: string }): ReactElement {
  return (
    <IconButton
      label={label}
      size={16}
      className={styles.markdownExternalOpenButton}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        openUrlInExternalBrowser(url)
      }}
    >
      <ArrowSquareOutIcon className={styles.markdownExternalOpenIcon} aria-hidden />
    </IconButton>
  )
}

/**
 * markdown 覆盖件读取的**会变的值**：流式标志、宿主回调、外链按钮文案、尾部状态标记。
 *
 * 覆盖件（`pre` / `inlineCode` / `a` / 尾标候选）必须是**模块级常量组件**，经这个 context 取值，
 * 不能在 hook 里按这些值现造：Streamdown 拿组件引用当元素类型，引用一变 React 就把整棵子树卸载
 * 重建。宿主注入的 `openPathInLight` 依赖流式中每段都会换新的 message 对象，于是过去每来一段文字，
 * 所有代码块都被重建一次——用户点的「展开」下一帧就被冲掉、溢出判定反复重测、滚动锚点跟着丢失。
 *
 * 回调以「稳定调用壳 + 最新实现」传入：渲染期只看**有没有**（决定渲染成链接还是纯文本），
 * 点击时才调用当下最新的宿主实现，所以宿主回调换引用不会让任何消费者重渲染。
 *
 * `expansionScope`：这段 markdown 所属消息块的稳定键；可展开视口据此记住用户的手动展开。
 */
export interface MessageMarkdownRuntime {
  isStreaming: boolean
  externalOpenLabel: string
  openBrowserLink: Nullable<(url: string) => void | Promise<void>>
  openProjectPath: Nullable<(path: string) => unknown>
  expansionScope: Nullable<string>
}

const DefaultExternalOpenLabel = 'Open in external browser'

const MessageMarkdownRuntimeContext = createContext<MessageMarkdownRuntime>({
  isStreaming: false,
  externalOpenLabel: DefaultExternalOpenLabel,
  openBrowserLink: null,
  openProjectPath: null,
  expansionScope: null,
})

type ExpandableViewportKind = 'code' | 'table'

/**
 * 用户手动展开过的视口，键 = 消息块作用域 + 视口类型 + 同类视口在这段 markdown 里的文档序。
 *
 * 展开是用户意图，不能跟着组件实例走：流式结束时 Streamdown 从分块渲染切到静态渲染、切走会话再
 * 切回来，都会整棵重建——实例级 state 一丢，刚点开的长代码块又弹回折叠。溢出高度**不**进这里，
 * 永远以当下 DOM 实测为准。
 */
const ExpandedViewportKeys = new Set<string>()
const MaxExpandedViewportKeys = 500

function rememberViewportExpansion(key: string, expanded: boolean): void {
  if (!expanded) {
    ExpandedViewportKeys.delete(key)
    return
  }
  ExpandedViewportKeys.delete(key)
  ExpandedViewportKeys.add(key)
  if (ExpandedViewportKeys.size <= MaxExpandedViewportKeys) return
  const oldest = ExpandedViewportKeys.values().next().value
  if (isPresent(oldest)) ExpandedViewportKeys.delete(oldest)
}

function useExpandableConversationViewport(
  viewportSelector: string,
  kind: ExpandableViewportKind
): {
  containerRef: React.RefObject<Nullable<HTMLDivElement>>
  expanded: boolean
  hasOverflow: boolean
  setExpanded: (expanded: boolean) => void
} {
  const timers = useTimerScope('useExpandableConversationViewport')
  const { expansionScope } = useContext(MessageMarkdownRuntimeContext)
  const containerRef = useRef<HTMLDivElement>(null)
  const expansionKeyRef = useRef<Nullable<string>>(null)
  const [expanded, setExpandedState] = useState(false)
  const [hasOverflow, setHasOverflow] = useState(false)

  useLayoutEffect(() => {
    const container = containerRef.current
    const root = container?.closest('[data-message-markdown-root]')
    if (!container || !root || !expansionScope) {
      expansionKeyRef.current = null
      return
    }

    const ordinal = Array.from(
      root.querySelectorAll(`[data-expandable-viewport="${kind}"]`)
    ).indexOf(container)
    const key = ordinal < 0 ? null : `${expansionScope}:${kind}:${ordinal}`
    expansionKeyRef.current = key
    if (key && ExpandedViewportKeys.has(key)) setExpandedState(true)
  }, [expansionScope, kind])

  const setExpanded = useCallback((next: boolean): void => {
    setExpandedState(next)
    if (expansionKeyRef.current) rememberViewportExpansion(expansionKeyRef.current, next)
  }, [])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    // 视口元素**每次测量都重新取**：代码块正文先以纯文本占位渲染，高亮模块加载完后 Suspense 会把
    // `code-block-body` 整个换成新节点。只在挂载时抓一次元素，观察者就一直盯着脱离文档的旧节点，
    // 判定冻结在旧值上——短代码块也会一直顶着「展开」箭头。
    let viewport: Nullable<HTMLElement> = null
    const resizeObserver = new ResizeObserver(() => measure())
    const bindViewport = (): Nullable<HTMLElement> => {
      const current = container.querySelector<HTMLElement>(viewportSelector)
      if (current === viewport) return viewport

      resizeObserver.disconnect()
      viewport = current
      if (viewport) {
        resizeObserver.observe(viewport)
        if (viewport.firstElementChild) resizeObserver.observe(viewport.firstElementChild)
      }
      return viewport
    }
    const measure = (): void => {
      const current = bindViewport()
      setHasOverflow(
        !!current &&
          current.scrollHeight >
            ConversationExpandableViewportHeightPx +
              ConversationExpandableViewportOverflowTolerancePx
      )
    }

    measure()
    const animationFrameLease = timers.nextFrame(measure, {
      label: 'conversation.expandable-viewport.measure',
    })
    const intersectionObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) measure()
    })
    intersectionObserver.observe(container)
    // 观察整个容器子树而不是旧视口：正文节点被替换、内容增删都会触发重测。
    const mutationObserver = new MutationObserver(measure)
    mutationObserver.observe(container, {
      characterData: true,
      childList: true,
      subtree: true,
    })

    return () => {
      animationFrameLease.cancel()
      intersectionObserver.disconnect()
      mutationObserver.disconnect()
      resizeObserver.disconnect()
    }
  }, [timers, viewportSelector])

  return { containerRef, expanded, hasOverflow, setExpanded }
}

type PreviewableCodeBlockView = 'preview' | 'source'

function PreviewableCodeBlockToggle({
  view,
  onToggle,
}: {
  view: PreviewableCodeBlockView
  onToggle: () => void
}): ReactElement {
  const { t } = useConversationI18n()
  const showingPreview = view === 'preview'

  return (
    <IconButton
      label={t(showingPreview ? 'chat.codeBlockShowSource' : 'chat.codeBlockShowPreview')}
      size="icon-sm"
      variant="ghost"
      className={styles.previewableCodeBlockToggleButton}
      onClick={onToggle}
    >
      {showingPreview ? <CodeIcon size={14} /> : <EyeIcon size={14} />}
    </IconButton>
  )
}

/**
 * 通用的「代码 ↔ 可视结果」容器。解析器只负责提供 preview；视图状态、流式回退和源码入口
 * 由这一层统一，后续接入新的声明式格式时无需再造一套交互。
 */
function PreviewableCodeBlockFrame({
  code,
  language,
  isStreaming,
  initialView,
  renderPreview,
}: {
  code: string
  language: string
  isStreaming: boolean
  initialView: PreviewableCodeBlockView
  renderPreview: (toggleAction: ReactElement) => ReactElement
}): ReactElement {
  const [selection, setSelection] = useState<{
    code: string
    view: PreviewableCodeBlockView
  }>(() => ({
    code,
    view: initialView,
  }))
  const selectedView = selection.code === code ? selection.view : initialView
  const view = isStreaming ? 'source' : selectedView
  const handleToggle = useCallback((): void => {
    if (isStreaming) return

    setSelection({
      code,
      view: view === 'preview' ? 'source' : 'preview',
    })
  }, [code, isStreaming, view])
  const toggleAction = <PreviewableCodeBlockToggle view={view} onToggle={handleToggle} />

  return (
    <div className={styles.previewableCodeBlock} data-view={view}>
      {view === 'preview' ? (
        renderPreview(toggleAction)
      ) : (
        <>
          <ExpandableCodeBlockFrame>
            <CodeBlock code={code} language={language} isIncomplete={isStreaming}>
              <CodeBlockDownloadButton code={code} language={language} />
              <CodeBlockCopyButton code={code} />
            </CodeBlock>
          </ExpandableCodeBlockFrame>
          {!isStreaming && (
            <div className={styles.previewableCodeBlockToggleSlot}>{toggleAction}</div>
          )}
        </>
      )}
    </div>
  )
}

function RenderableHtmlCodeBlockFrame({
  children,
  code,
  isStreaming,
}: {
  children: ReactElement
  code: string
  isStreaming: boolean
}): ReactElement {
  const { t } = useConversationI18n()
  const reactId = useId()
  const artifactId = useMemo(
    () => `markdown-html-code-${reactId.replace(/[^a-zA-Z0-9_-]+/gu, '-')}`,
    [reactId]
  )
  const block = useMemo<HtmlArtifactContentBlock>(
    () => ({
      type: 'html-artifact',
      artifactId,
      title: t('chat.htmlArtifactDefaultTitle'),
      html: code,
      protocolText: code,
      isStreaming: false,
    }),
    [artifactId, code, t]
  )

  return (
    <PreviewableCodeBlockFrame
      code={code}
      language="html"
      isStreaming={isStreaming}
      initialView="source"
      renderPreview={(toggleAction) => (
        <Suspense
          fallback={
            <>
              <ExpandableCodeBlockFrame>
                {children}
              </ExpandableCodeBlockFrame>
              <div className={styles.previewableCodeBlockToggleSlot}>{toggleAction}</div>
            </>
          }
        >
          <LazyHtmlArtifactBlock block={block} sourceToggleAction={toggleAction} />
        </Suspense>
      )}
    />
  )
}

function RenderableDiagramCodeBlockFrame({
  children,
  code,
  language,
  isStreaming,
}: {
  children: ReactElement
  code: string
  language: string
  isStreaming: boolean
}): ReactElement {
  return (
    <PreviewableCodeBlockFrame
      code={code}
      language={language}
      isStreaming={isStreaming}
      initialView="preview"
      renderPreview={(toggleAction) => (
        <>
          {children}
          <div className={styles.previewableCodeBlockToggleSlot}>{toggleAction}</div>
        </>
      )}
    />
  )
}

function ExpandableCodeBlockFrame({ children }: { children: ReactElement }): ReactElement {
  const { t } = useConversationI18n()
  const { containerRef, expanded, hasOverflow, setExpanded } = useExpandableConversationViewport(
    '[data-streamdown="code-block-body"]',
    'code'
  )
  const collapsed = hasOverflow && !expanded

  return (
    <div
      ref={containerRef}
      className={styles.expandableCodeBlock}
      data-collapsed={collapsed}
      data-expandable-viewport="code"
    >
      {children}
      {collapsed && (
        <button
          type="button"
          className={styles.expandableCodeBlockOverlay}
          aria-expanded="false"
          aria-label={t('chat.codeBlockExpand')}
          title={t('chat.codeBlockExpand')}
          onClick={() => setExpanded(true)}
        >
          <span className={styles.expandableCodeBlockButton} aria-hidden="true">
            <CaretDoubleDownIcon size={18} weight="bold" />
          </span>
        </button>
      )}
      {hasOverflow && expanded && (
        <div className={styles.expandableCodeBlockCollapseSlot}>
          <button
            type="button"
            className={styles.expandableCodeBlockCollapseButton}
            aria-expanded="true"
            aria-label={t('chat.codeBlockCollapse')}
            title={t('chat.codeBlockCollapse')}
            onClick={() => setExpanded(false)}
          >
            <CaretDoubleUpIcon size={18} weight="bold" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}

/** 官方代码块渲染的三条分支（声明式预览 / 可运行 HTML / 可展开框），抽出以便充当替换槽的回落。 */
function renderOfficialCodeBlock({
  blockChild,
  language,
  code,
  isStreaming,
}: {
  blockChild: ReactElement
  language: string
  code: string
  isStreaming: boolean
}): ReactElement {
  if (DiagramCodeBlockLanguages.has(language))
    return (
      <RenderableDiagramCodeBlockFrame code={code} language={language} isStreaming={isStreaming}>
        {blockChild}
      </RenderableDiagramCodeBlockFrame>
    )

  if (isRenderableHtmlCodeBlockLanguage(language))
    return (
      <RenderableHtmlCodeBlockFrame code={code} isStreaming={isStreaming}>
        {blockChild}
      </RenderableHtmlCodeBlockFrame>
    )

  return <ExpandableCodeBlockFrame>{blockChild}</ExpandableCodeBlockFrame>
}

/**
 * 替换槽专用的围栏正文提取：官方路径只认「children 就是一整串字符串」（`readCodeText`），因为它拿
 * 正文只为数行数，数不出来还有 DOM 实测兜底。替换件没有兜底——正文是它唯一的输入，所以这里穿透
 * 数组与元素节点把文本拼回来。**只在槽位存在时调用**，官方路径逐字节不变。
 */
function extractCodeBlockText(children: unknown): string {
  if (isString(children)) return children
  if (isArray(children))
    return children.map((child) => extractCodeBlockText(child)).join('')
  if (React.isValidElement(children))
    return extractCodeBlockText((children.props as { children?: unknown }).children)

  return ''
}

function MarkdownPreWithExpandableCode({
  children,
  isStreaming = false,
}: React.ComponentPropsWithoutRef<'pre'> & { isStreaming?: boolean }): ReactElement {
  const slots = useConversationRenderSlots()

  if (!React.isValidElement(children)) return <>{children}</>

  const childElement = children as React.ReactElement<Record<string, unknown>>
  const childProps = children.props as {
    children?: unknown
    className?: unknown
  }
  const codeBlockClassName = normalizeCodeBlockClassName(childProps.className)
  const language = readCodeLanguage(codeBlockClassName)
  const blockChild = React.cloneElement(childElement, {
    'data-block': 'true',
    className: codeBlockClassName,
  })
  const official = renderOfficialCodeBlock({
    blockChild,
    language,
    code: readCodeText(childProps.children),
    isStreaming,
  })

  const slot = slots.messageCodeBlock
  if (!slot) return official

  const code = extractCodeBlockText(childProps.children)
  // 取不到围栏正文 = 替换件唯一的输入缺席，替换就没有意义：回落官方（失败方向恒为官方实现）。
  if (isEmpty(code)) return official

  return (
    <ReplaceableRenderSlot
      scope="conversation.message.codeBlock"
      render={slot}
      props={{ language, code, isStreaming }}
      fallback={official}
    />
  )
}

function MarkdownTableWithExpandableViewport({
  children,
  node: _node,
}: {
  children?: React.ReactNode
  node?: unknown
}): ReactElement {
  const { t } = useConversationI18n()
  const { containerRef, expanded, hasOverflow, setExpanded } = useExpandableConversationViewport(
    '[data-conversation-table-viewport]',
    'table'
  )
  const collapsed = hasOverflow && !expanded

  return (
    <div
      ref={containerRef}
      data-collapsed={collapsed}
      data-expandable-viewport="table"
      data-streamdown="table-wrapper"
    >
      <div data-conversation-table-viewport>
        <table data-streamdown="table">
          {children}
        </table>
      </div>
      {collapsed && (
        <button
          type="button"
          className={styles.expandableCodeBlockOverlay}
          aria-expanded="false"
          aria-label={t('chat.richExpand')}
          title={t('chat.richExpand')}
          onClick={() => setExpanded(true)}
        >
          <span className={styles.expandableCodeBlockButton} aria-hidden="true">
            <CaretDoubleDownIcon size={18} weight="bold" />
          </span>
        </button>
      )}
      {hasOverflow && expanded && (
        <div className={styles.expandableCodeBlockCollapseSlot}>
          <button
            type="button"
            className={styles.expandableCodeBlockCollapseButton}
            aria-expanded="true"
            aria-label={t('chat.richCollapse')}
            title={t('chat.richCollapse')}
            onClick={() => setExpanded(false)}
          >
            <CaretDoubleUpIcon size={18} weight="bold" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}

function MarkdownPre(props: React.ComponentPropsWithoutRef<'pre'>): ReactElement {
  const { isStreaming } = useContext(MessageMarkdownRuntimeContext)
  return <MarkdownPreWithExpandableCode {...props} isStreaming={isStreaming} />
}

function MarkdownInlineCode({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<'code'>): ReactElement {
  const { openProjectPath } = useContext(MessageMarkdownRuntimeContext)
  const language = readCodeLanguage(className)
  const filePath = !language ? normalizeMessageMarkdownFileReference(readCodeText(children)) : null
  const renderInlineCode = (content: React.ReactNode): ReactElement => (
    <code className={className} {...props}>
      {content}
    </code>
  )

  if (!filePath || !openProjectPath) return renderInlineCode(children)

  return renderInlineCode(
    <Link
      href={filePath}
      className={styles.markdownFileLink}
      data-streamdown="link"
      data-tour-id="chat-result-link"
      onClick={(event) => {
        if (!isPrimaryPointerClick(event)) return

        event.preventDefault()
        void openProjectPath(filePath)
      }}
    >
      {children}
    </Link>
  )
}

function MarkdownLink({
  href,
  onClick,
  rel,
  target,
  ...props
}: React.ComponentPropsWithoutRef<'a'>): ReactElement {
  const { openBrowserLink, openProjectPath, externalOpenLabel } = useContext(
    MessageMarkdownRuntimeContext
  )
  const link = isString(href) ? href : ''
  const linkTarget = resolveMessageMarkdownHrefTarget(link)
  const shouldOpenInBrowser = linkTarget.kind === 'web' && !!openBrowserLink
  const shouldOpenExternally = linkTarget.kind === 'external-protocol'

  if (linkTarget.kind === 'project-file' && openProjectPath)
    return (
      <Link
        href={href}
        className={styles.markdownFileLink}
        data-streamdown="link"
        data-tour-id="chat-result-link"
        {...props}
        onClick={(event) => {
          onClick?.(event)
          if (event.defaultPrevented || !isPrimaryPointerClick(event)) return

          event.preventDefault()
          void openProjectPath(linkTarget.path)
        }}
      />
    )

  if (linkTarget.kind === 'text') return <span>{props.children}</span>

  if (linkTarget.kind === 'web')
    return (
      <span className={styles.markdownWebLinkGroup}>
        <Link
          href={href}
          className={styles.markdownWebLink}
          data-tour-id="chat-result-link"
          {...props}
          rel={rel}
          target={target}
          onClick={(event) => {
            onClick?.(event)
            if (event.defaultPrevented || !shouldOpenInBrowser || !isPrimaryPointerClick(event))
              return

            event.preventDefault()
            void openBrowserLink?.(linkTarget.url)
          }}
        />
        <MarkdownExternalOpenButton label={externalOpenLabel} url={linkTarget.url} />
      </span>
    )

  return (
    <Link
      href={href}
      className={styles.markdownWebLink}
      data-tour-id="chat-result-link"
      external={shouldOpenExternally}
      {...props}
      {...(shouldOpenExternally ? {} : { rel, target })}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || !shouldOpenInBrowser || !isPrimaryPointerClick(event)) return

        event.preventDefault()
        void openBrowserLink?.(link)
      }}
    />
  )
}

/**
 * 尾标候选：块级元素末尾留一个空槽。状态标记只有一份，由所在文本块在布局阶段挑出真正位于
 * 尾部的槽再 portal 进去——候选本身不读标记，标记怎么变都不会让段落重渲染。
 */
function createTailMarkerCandidate(tag: (typeof TailMarkerCandidateTags)[number]) {
  function TailMarkerCandidate({ children, ...props }: React.HTMLAttributes<HTMLElement>) {
    return React.createElement(
      tag,
      props,
      children,
      <span className={styles.markdownTailMarkerSlot} />
    )
  }
  TailMarkerCandidate.displayName = `MarkdownTailMarkerCandidate(${tag})`
  return TailMarkerCandidate
}

const TailMarkerCandidateComponents = Object.fromEntries(
  TailMarkerCandidateTags.map((tag) => [tag, createTailMarkerCandidate(tag)])
) as StreamdownComponents

const BaseMarkdownComponents: StreamdownComponents = {
  pre: MarkdownPre as StreamdownComponents['pre'],
  inlineCode: MarkdownInlineCode as StreamdownComponents['inlineCode'],
  table: MarkdownTableWithExpandableViewport as StreamdownComponents['table'],
}

// 没有宿主打开能力时不覆盖 `a`，沿用 Streamdown 自带的链接（含 linkSafety 确认）。
const LinkAwareMarkdownComponents: StreamdownComponents = {
  ...BaseMarkdownComponents,
  a: MarkdownLink as StreamdownComponents['a'],
}

/** 四张常量表，按「有无链接处理 × 有无尾标」选一张：身份只在这两个布尔翻转时变化。 */
const MarkdownComponentTables = {
  base: BaseMarkdownComponents,
  linkAware: LinkAwareMarkdownComponents,
  baseWithTail: { ...BaseMarkdownComponents, ...TailMarkerCandidateComponents },
  linkAwareWithTail: { ...LinkAwareMarkdownComponents, ...TailMarkerCandidateComponents },
} satisfies Record<string, StreamdownComponents>

export function MessageMarkdownRuntimeProvider({
  runtime,
  children,
}: {
  runtime: MessageMarkdownRuntime
  children: ReactNode
}): ReactElement {
  return (
    <MessageMarkdownRuntimeContext.Provider value={runtime}>
      {children}
    </MessageMarkdownRuntimeContext.Provider>
  )
}

export function useMessageMarkdownComponents(
  onOpenBrowserLink?: (url: string) => void | Promise<void>,
  onOpenProjectPath?: (path: string) => unknown,
  externalOpenLabel = DefaultExternalOpenLabel,
  options?: {
    isStreaming?: boolean
    /** 块级元素末尾留尾标槽（这段 markdown 带状态标记时）。 */
    withTailMarkerSlots?: boolean
    expansionScope?: LooseOptional<string>
  }
): { components: StreamdownComponents; runtime: MessageMarkdownRuntime } {
  const isStreaming = !!options?.isStreaming
  const withTailMarkerSlots = !!options?.withTailMarkerSlots
  const expansionScope = toNullable(options?.expansionScope)
  const hasBrowserLink = !!onOpenBrowserLink
  const hasProjectPath = !!onOpenProjectPath
  const openBrowserLink = useMemoizedFn((url: string) => onOpenBrowserLink?.(url))
  const openProjectPath = useMemoizedFn((path: string) => onOpenProjectPath?.(path))

  const runtime = useMemo<MessageMarkdownRuntime>(
    () => ({
      isStreaming,
      externalOpenLabel,
      openBrowserLink: hasBrowserLink ? openBrowserLink : null,
      openProjectPath: hasProjectPath ? openProjectPath : null,
      expansionScope,
    }),
    [
      expansionScope,
      externalOpenLabel,
      hasBrowserLink,
      hasProjectPath,
      isStreaming,
      openBrowserLink,
      openProjectPath,
    ]
  )
  const linkAware = hasBrowserLink || hasProjectPath
  const components = withTailMarkerSlots
    ? linkAware
      ? MarkdownComponentTables.linkAwareWithTail
      : MarkdownComponentTables.baseWithTail
    : linkAware
      ? MarkdownComponentTables.linkAware
      : MarkdownComponentTables.base

  return { components, runtime }
}
