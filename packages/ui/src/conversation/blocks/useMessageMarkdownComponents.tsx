import React, {
  lazy,
  type ReactElement,
  Suspense,
  useCallback,
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
  PlayIcon,
} from '@phosphor-icons/react'
import { type Components as StreamdownComponents } from 'streamdown'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Link } from '@velaros-ai/ui/primitives/display/Link'

import { useConversationI18n } from '../i18n'
import {
  countCodeBlockLines,
  EXPANDABLE_CODE_BLOCK_INITIAL_VISIBLE_LINES,
  getNextVisibleCodeBlockLines,
  shouldCollapseCodeBlock,
  shouldShowCodeBlockCollapseButton,
} from '../markdown/expandableCodeBlock.utils'
import {
  normalizeMessageMarkdownFileReference,
  resolveMessageMarkdownHrefTarget,
} from '../markdown/messageMarkdownLinks.utils'
import { useConversationRenderSlots } from '../render-slots'
import { ReplaceableRenderSlot } from '../render-slots/ReplaceableRenderSlot'

import styles from './MessageBubble.module.css'

import type { HtmlArtifactBlock as HtmlArtifactContentBlock } from '#contracts'
import { isEmpty, isString } from '#internal/runtime'

const CodeLanguageClassPattern = /(?:^|\s)language-([^\s]+)/u
const NonExpandableCodeBlockLanguages = new Set(['mermaid'])
const RenderableHtmlCodeBlockLanguages = new Set(['html', 'htm'])
const TailMarkerCandidateTags = ['p', 'li', 'h1', 'h2', 'h3', 'h4'] as const
// PERF GUARD: 不要静态导入 HtmlArtifactBlock；它会继续拉入 HtmlPreviewFrame 和源码预览，
// 导致普通 markdown 消息也为从未打开的 HTML 预览支付首屏成本。
const LazyHtmlArtifactBlock = lazy(async () =>
  import('../artifacts/HtmlArtifactBlock').then((module) => ({
    default: module.HtmlArtifactBlock,
  }))
)

interface ExpandableCodeBlockState {
  code: string
  visibleLines: number
  measuredTotalLines: Nullable<number>
}

function readCodeLanguage(className: unknown): string {
  if (!isString(className)) return ''

  return className.match(CodeLanguageClassPattern)?.[1]?.toLowerCase() ?? ''
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

function readCssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value)

  return Number.isFinite(parsed) ? parsed : 0
}

function measureRenderedCodeBlockLines(container: Nullable<HTMLDivElement>): Nullable<number> {
  const body = container?.querySelector<HTMLElement>('[data-streamdown="code-block-body"]')
  if (!body || body.scrollHeight <= 0) return null

  const computedStyle = window.getComputedStyle(body)
  const lineHeight = readCssPixelValue(computedStyle.lineHeight)
  const fontSize = readCssPixelValue(computedStyle.fontSize)
  const effectiveLineHeight = lineHeight > 0 ? lineHeight : Math.max(fontSize * 1.62, 1)
  const verticalPadding =
    readCssPixelValue(computedStyle.paddingTop) + readCssPixelValue(computedStyle.paddingBottom)
  const contentHeight = Math.max(0, body.scrollHeight - verticalPadding)

  return Math.max(1, Math.ceil(contentHeight / effectiveLineHeight))
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
  const [showHtmlPreview, setShowHtmlPreview] = useState(false)
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

  if (showHtmlPreview)
    return (
      <Suspense
        fallback={
          <ExpandableCodeBlockFrame code={code} isStreaming={isStreaming}>
            {children}
          </ExpandableCodeBlockFrame>
        }
      >
        <LazyHtmlArtifactBlock block={block} />
      </Suspense>
    )

  return (
    <ExpandableCodeBlockFrame code={code} isStreaming={isStreaming}>
      <>
        {children}
        {!isStreaming && (
          <IconButton
            label={t('chat.codeBlockRenderHtml')}
            size="icon-sm"
            variant="outline"
            className={styles.htmlCodeBlockRenderButton}
            onClick={() => setShowHtmlPreview(true)}
          >
            <PlayIcon size={14} aria-hidden="true" />
          </IconButton>
        )}
      </>
    </ExpandableCodeBlockFrame>
  )
}

function ExpandableCodeBlockFrame({
  children,
  code,
  isStreaming = false,
}: {
  children: ReactElement
  code: string
  isStreaming?: boolean
}): ReactElement {
  const { t } = useConversationI18n()
  const codeBlockRef = useRef<HTMLDivElement>(null)
  const [expansionState, setExpansionState] = useState<ExpandableCodeBlockState>(() => ({
    code,
    visibleLines: EXPANDABLE_CODE_BLOCK_INITIAL_VISIBLE_LINES,
    measuredTotalLines: null,
  }))
  const totalLines = useMemo(() => countCodeBlockLines(code), [code])
  const stateMatchesCode = expansionState.code === code
  const visibleLines = stateMatchesCode
    ? expansionState.visibleLines
    : EXPANDABLE_CODE_BLOCK_INITIAL_VISIBLE_LINES
  const measuredTotalLines = stateMatchesCode ? expansionState.measuredTotalLines : null

  useLayoutEffect(() => {
    const nextMeasuredTotalLines = measureRenderedCodeBlockLines(codeBlockRef.current)
    setExpansionState((current) => {
      const currentMatchesCode = current.code === code
      const currentVisibleLines = currentMatchesCode
        ? current.visibleLines
        : EXPANDABLE_CODE_BLOCK_INITIAL_VISIBLE_LINES
      const currentMeasuredTotalLines = currentMatchesCode ? current.measuredTotalLines : null
      if (
        currentMatchesCode &&
        currentVisibleLines === visibleLines &&
        currentMeasuredTotalLines === nextMeasuredTotalLines
      )
        return current

      return {
        code,
        visibleLines,
        measuredTotalLines: nextMeasuredTotalLines,
      }
    })
  }, [code, visibleLines])
  const setVisibleLines = useCallback(
    (nextVisibleLines: number): void => {
      setExpansionState((current) => ({
        code,
        visibleLines: nextVisibleLines,
        measuredTotalLines: current.code === code ? current.measuredTotalLines : null,
      }))
    },
    [code]
  )

  const collapsed = shouldCollapseCodeBlock({
    isStreaming,
    measuredTotalLines,
    totalLines,
    visibleLines,
  })
  const showCollapseButton = shouldShowCodeBlockCollapseButton({
    isStreaming,
    measuredTotalLines,
    totalLines,
    visibleLines,
  })
  const nextVisibleLines = getNextVisibleCodeBlockLines({
    measuredTotalLines,
    totalLines,
    visibleLines,
  })
  const style = {
    '--chat-code-block-visible-height': `${visibleLines * 1.62 + 1.4}em`,
  } as React.CSSProperties & Record<'--chat-code-block-visible-height', string>

  return (
    <div
      ref={codeBlockRef}
      className={styles.expandableCodeBlock}
      data-collapsed={collapsed}
      style={style}
    >
      {children}
      {collapsed && (
        <button
          type="button"
          className={styles.expandableCodeBlockOverlay}
          aria-expanded="false"
          aria-label={t('chat.codeBlockExpand')}
          title={t('chat.codeBlockExpand')}
          onClick={() => setVisibleLines(nextVisibleLines)}
        >
          <span className={styles.expandableCodeBlockButton} aria-hidden="true">
            <CaretDoubleDownIcon size={18} weight="bold" />
          </span>
        </button>
      )}
      {showCollapseButton && (
        <div className={styles.expandableCodeBlockCollapseSlot}>
          <button
            type="button"
            className={styles.expandableCodeBlockCollapseButton}
            aria-expanded="true"
            aria-label={t('chat.codeBlockCollapse')}
            title={t('chat.codeBlockCollapse')}
            onClick={() => setVisibleLines(EXPANDABLE_CODE_BLOCK_INITIAL_VISIBLE_LINES)}
          >
            <CaretDoubleUpIcon size={18} weight="bold" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}

/** 官方代码块渲染的三条分支（mermaid 直渲 / 可运行 HTML / 可展开框），原样抽出以便充当替换槽的回落。 */
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
  if (NonExpandableCodeBlockLanguages.has(language)) return blockChild

  if (isRenderableHtmlCodeBlockLanguage(language))
    return (
      <RenderableHtmlCodeBlockFrame code={code} isStreaming={isStreaming}>
        {blockChild}
      </RenderableHtmlCodeBlockFrame>
    )

  return (
    <ExpandableCodeBlockFrame code={code} isStreaming={isStreaming}>
      {blockChild}
    </ExpandableCodeBlockFrame>
  )
}

/**
 * 替换槽专用的围栏正文提取：官方路径只认「children 就是一整串字符串」（`readCodeText`），因为它拿
 * 正文只为数行数，数不出来还有 DOM 实测兜底。替换件没有兜底——正文是它唯一的输入，所以这里穿透
 * 数组与元素节点把文本拼回来。**只在槽位存在时调用**，官方路径逐字节不变。
 */
function extractCodeBlockText(children: unknown): string {
  if (isString(children)) return children
  if (Array.isArray(children))
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
  const language = readCodeLanguage(childProps.className)
  const blockChild = React.cloneElement(childElement, {
    'data-block': 'true',
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

function useBaseMarkdownComponents({
  isStreaming = false,
  onOpenBrowserLink,
  onOpenWorkspacePath,
  externalOpenLabel = 'Open in external browser',
}: {
  isStreaming?: boolean
  onOpenBrowserLink?: (url: string) => void | Promise<void>
  onOpenWorkspacePath?: (path: string) => unknown
  externalOpenLabel?: string
}): StreamdownComponents {
  return useMemo(() => {
    const baseMarkdownComponents: StreamdownComponents = {}
    baseMarkdownComponents.pre = ((props: React.ComponentPropsWithoutRef<'pre'>) => (
      <MarkdownPreWithExpandableCode {...props} isStreaming={isStreaming} />
    )) as StreamdownComponents['pre']
    baseMarkdownComponents.inlineCode = (({
      children,
      className,
      ...props
    }: React.ComponentPropsWithoutRef<'code'>): ReactElement => {
      const language = readCodeLanguage(className)
      const filePath = !language
        ? normalizeMessageMarkdownFileReference(readCodeText(children))
        : null
      const renderInlineCode = (content: React.ReactNode): ReactElement => (
        <code className={className} {...props}>
          {content}
        </code>
      )

      if (!filePath || !onOpenWorkspacePath) return renderInlineCode(children)

      return renderInlineCode(
        <Link
          href={filePath}
          className={styles.markdownFileLink}
          data-streamdown="link"
          data-tour-id="chat-result-link"
          onClick={(event) => {
            if (!isPrimaryPointerClick(event)) return

            event.preventDefault()
            void onOpenWorkspacePath(filePath)
          }}
        >
          {children}
        </Link>
      )
    }) as StreamdownComponents['inlineCode']

    if (onOpenBrowserLink || onOpenWorkspacePath) {
      baseMarkdownComponents.a = (({
        href,
        onClick,
        rel,
        target,
        ...props
      }: React.ComponentPropsWithoutRef<'a'>): ReactElement => {
        const link = isString(href) ? href : ''
        const linkTarget = resolveMessageMarkdownHrefTarget(link)
        const shouldOpenInBrowser = linkTarget.kind === 'web' && !!onOpenBrowserLink
        const shouldOpenExternally = linkTarget.kind === 'external-protocol'

        if (linkTarget.kind === 'workspace-file' && onOpenWorkspacePath)
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
                void onOpenWorkspacePath(linkTarget.path)
              }}
            />
          )

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
                  if (
                    event.defaultPrevented ||
                    !shouldOpenInBrowser ||
                    !isPrimaryPointerClick(event)
                  )
                    return

                  event.preventDefault()
                  void onOpenBrowserLink?.(linkTarget.url)
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
              if (event.defaultPrevented || !shouldOpenInBrowser || !isPrimaryPointerClick(event))
                return

              event.preventDefault()
              void onOpenBrowserLink?.(link)
            }}
          />
        )
      }) as StreamdownComponents['a']
    }

    return baseMarkdownComponents
  }, [externalOpenLabel, isStreaming, onOpenBrowserLink, onOpenWorkspacePath])
}

export function useMessageMarkdownComponents(
  onOpenBrowserLink?: (url: string) => void | Promise<void>,
  onOpenWorkspacePath?: (path: string) => unknown,
  externalOpenLabel = 'Open in external browser',
  options?: { isStreaming?: boolean; tailNode?: LooseOptional<ReactElement> }
): StreamdownComponents {
  const baseMarkdownComponents = useBaseMarkdownComponents({
    isStreaming: !!options?.isStreaming,
    onOpenBrowserLink,
    onOpenWorkspacePath,
    externalOpenLabel,
  })
  const tailNode = options?.tailNode

  return useMemo(() => {
    if (!tailNode) return baseMarkdownComponents

    const tailMarkerCandidates: Record<string, unknown> = {}
    for (const tag of TailMarkerCandidateTags) {
      tailMarkerCandidates[tag] = ({ children, ...props }: React.HTMLAttributes<HTMLElement>) =>
        React.createElement(
          tag,
          props,
          children,
          <span className={styles.markdownTailMarkerSlot}>{tailNode}</span>
        )
    }

    return {
      ...baseMarkdownComponents,
      ...tailMarkerCandidates,
    } as StreamdownComponents
  }, [baseMarkdownComponents, tailNode])
}
