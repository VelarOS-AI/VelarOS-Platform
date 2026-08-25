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
  CodeIcon,
  EyeIcon,
} from '@phosphor-icons/react'
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
import { isArray } from '#internal/runtime'
import { isEmpty, isString, trimmedStringOrEmpty } from '#internal/runtime'

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

interface ExpandableCodeBlockState {
  code: string
  visibleLines: number
  measuredTotalLines: Nullable<number>
}

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
          <ExpandableCodeBlockFrame code={code} isStreaming={isStreaming}>
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
              <ExpandableCodeBlockFrame code={code} isStreaming={false}>
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

function useBaseMarkdownComponents({
  isStreaming = false,
  onOpenBrowserLink,
  onOpenProjectPath,
  externalOpenLabel = 'Open in external browser',
}: {
  isStreaming?: boolean
  onOpenBrowserLink?: (url: string) => void | Promise<void>
  onOpenProjectPath?: (path: string) => unknown
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

      if (!filePath || !onOpenProjectPath) return renderInlineCode(children)

      return renderInlineCode(
        <Link
          href={filePath}
          className={styles.markdownFileLink}
          data-streamdown="link"
          data-tour-id="chat-result-link"
          onClick={(event) => {
            if (!isPrimaryPointerClick(event)) return

            event.preventDefault()
            void onOpenProjectPath(filePath)
          }}
        >
          {children}
        </Link>
      )
    }) as StreamdownComponents['inlineCode']

    if (onOpenBrowserLink || onOpenProjectPath) {
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

        if (linkTarget.kind === 'project-file' && onOpenProjectPath)
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
                void onOpenProjectPath(linkTarget.path)
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
  }, [externalOpenLabel, isStreaming, onOpenBrowserLink, onOpenProjectPath])
}

export function useMessageMarkdownComponents(
  onOpenBrowserLink?: (url: string) => void | Promise<void>,
  onOpenProjectPath?: (path: string) => unknown,
  externalOpenLabel = 'Open in external browser',
  options?: { isStreaming?: boolean; tailNode?: LooseOptional<ReactElement> }
): StreamdownComponents {
  const baseMarkdownComponents = useBaseMarkdownComponents({
    isStreaming: !!options?.isStreaming,
    onOpenBrowserLink,
    onOpenProjectPath,
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
