import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useEventListener } from 'ahooks'

import { normalizeHtmlArtifactSource } from '@velaros-ai/html-artifacts/sandbox'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import { downloadTextFile } from '../html-preview/download'
import {
  DEFAULT_HTML_PREVIEW_HEIGHT,
  HTML_PREVIEW_ERROR_EVENT,
} from '../html-preview/htmlPreviewConstants'
import { buildPortableHtmlDocument } from '../html-preview/htmlPreviewDocument'
import { HtmlPreviewFrame } from '../html-preview/HtmlPreviewFrame'
import { HtmlPreviewFullscreenLayer } from '../html-preview/HtmlPreviewFullscreenLayer'
import { HtmlPreviewToolbar } from '../html-preview/HtmlPreviewToolbar'
import { useConversationI18n } from '../i18n'
import { AutoScrollSuspendEventName } from '../react-hooks/scrollBehavior'
import { useTimerScope } from '../react-hooks/useTimerScope'

import {
  dismissHtmlArtifactGenerationLayer,
  dismissHtmlArtifactGenerationLayerOnUnmount,
  resolveHtmlArtifactPresentation,
  restoreHtmlArtifactGenerationLayer,
  wasHtmlArtifactGenerationLayerDismissed,
} from './htmlArtifactPresentation'
import { HtmlArtifactSourceCode } from './HtmlArtifactSourceCode'

import styles from '../html-preview/HtmlPreview.module.css'

import type { HtmlArtifactBlock as HtmlArtifactContentBlock } from '#contracts'
import { isObject } from '#internal/runtime'

interface HtmlArtifactScrollAnchor {
  container: HTMLElement | Window
  top: number
}

function buildArtifactDownloadFilename(title: string): string {
  const baseName = title
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)

  return `${baseName || 'html-artifact'}.html`
}

function isScrollableHtmlArtifactContainer(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element)
  return (
    /(auto|scroll|overlay)/u.test(style.overflowY) && element.scrollHeight > element.clientHeight
  )
}

function resolveHtmlArtifactScrollContainer(element: HTMLElement): HTMLElement | Window {
  let current = element.parentElement
  while (current) {
    if (isScrollableHtmlArtifactContainer(current)) return current
    current = current.parentElement
  }

  return window
}

function applyHtmlArtifactScrollDelta(container: HTMLElement | Window, delta: number): void {
  if (Math.abs(delta) < 1) return

  if (container instanceof HTMLElement) {
    container.scrollTop += delta
    return
  }

  window.scrollBy(0, delta)
}

function restoreHtmlArtifactScrollAnchor(
  anchor: HtmlArtifactScrollAnchor,
  shell: HTMLElement
): void {
  applyHtmlArtifactScrollDelta(anchor.container, shell.getBoundingClientRect().top - anchor.top)
}

function dispatchHtmlArtifactAutoScrollSuspend(container: HTMLElement | Window): void {
  container.dispatchEvent(new Event(AutoScrollSuspendEventName, { bubbles: true }))
}

// iframe 上报的运行时错误里,只有结构性破损（协议解析/patch/render 失败）才意味着「渲染坏了」。
// window.onerror / unhandledrejection（phase: 'window' | 'script'）是渲染完成后的良性运行时
// 错误——页面显示正常也会抛,不该打扰用户。仅这类真破损才显示卡片内联重试提示。
function isGenuineArtifactRenderBreak(phase: unknown): boolean {
  return phase !== 'window' && phase !== 'script'
}

const HtmlArtifactBlock = memo(function HtmlArtifactBlock({
  block,
}: {
  block: HtmlArtifactContentBlock
}): React.ReactElement {
  const { t } = useConversationI18n()
  const timers = useTimerScope('HtmlArtifactBlock')
  const [showCode, setShowCode] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [renderBroken, setRenderBroken] = useState(false)
  const isStreaming = !!block.isStreaming
  const [layerOpen, setLayerOpen] = useState(
    () => isStreaming && !wasHtmlArtifactGenerationLayerDismissed(block.artifactId)
  )
  const layerOpenRef = useRef(layerOpen)
  const isStreamingRef = useRef(isStreaming)
  layerOpenRef.current = layerOpen
  isStreamingRef.current = isStreaming
  const shellRef = useRef<HTMLDivElement>(null)
  const pendingScrollAnchorRef = useRef<Nullable<HtmlArtifactScrollAnchor>>(null)
  const title = block.title.trim() || t('chat.htmlArtifactDefaultTitle')
  // 与 Widget 并列消费同一个中立预览适配层:协议内容可能被 CDATA/代码围栏整体包裹。
  const artifactHtml = normalizeHtmlArtifactSource(block.html)
  const artifactPatches = block.patches ?? []
  const hasRenderableArtifact = !!artifactHtml
  const presentation = resolveHtmlArtifactPresentation({
    hasRenderableArtifact,
    isGenerationLayerOpen: layerOpen,
    isStreaming,
  })
  // 导出面(查看源码/复制/下载)用纯净文档:页面自身内容+已应用补丁,无宿主内部逻辑。
  const htmlDocument = useMemo(
    () =>
      presentation.inline === 'artifact'
        ? buildPortableHtmlDocument(artifactHtml, artifactPatches)
        : '',
    [artifactHtml, artifactPatches, presentation.inline]
  )

  // 开流自动全屏预览;流中被用户关掉不复开(依赖不变不重触发);生成完毕自动落回页面——
  // 只在 streaming→完成的边沿收起全屏层,制品平铺回聊天流(用户裁定,2026-07-18 反转旧
  // 「生成结束不自动关」决议);挂载时已完成的历史制品不受影响,用户仍可经全屏按钮随时重开。
  const activeArtifactIdRef = useRef(block.artifactId)
  const wasStreamingRef = useRef(isStreaming)
  useEffect(() => {
    const artifactId = block.artifactId
    return () => {
      // 流式全屏随对话切换而卸载时不会触发 Dialog.onOpenChange。
      // 把这次离开视为收起，避免切回对话时再次自动抢占全屏。
      dismissHtmlArtifactGenerationLayerOnUnmount({
        artifactId,
        isGenerationLayerOpen: layerOpenRef.current,
        isStreaming: isStreamingRef.current,
      })
    }
  }, [block.artifactId])
  useEffect(() => {
    const artifactChanged = activeArtifactIdRef.current !== block.artifactId
    if (artifactChanged) {
      activeArtifactIdRef.current = block.artifactId
      setLayerOpen(isStreaming && !wasHtmlArtifactGenerationLayerDismissed(block.artifactId))
    } else if (isStreaming && !wasStreamingRef.current) {
      restoreHtmlArtifactGenerationLayer(block.artifactId)
      setLayerOpen(true)
    } else if (!isStreaming && wasStreamingRef.current) {
      restoreHtmlArtifactGenerationLayer(block.artifactId)
      setLayerOpen(false)
    } else if (!isStreaming) {
      restoreHtmlArtifactGenerationLayer(block.artifactId)
    }
    wasStreamingRef.current = isStreaming
  }, [block.artifactId, isStreaming])
  const handleLayerOpenChange = useCallback(
    (open: boolean): void => {
      if (isStreaming) {
        if (open) restoreHtmlArtifactGenerationLayer(block.artifactId)
        else dismissHtmlArtifactGenerationLayer(block.artifactId)
      }
      setLayerOpen(open)
    },
    [block.artifactId, isStreaming]
  )
  const captureScrollAnchor = useCallback((): void => {
    const shell = shellRef.current
    if (!shell) return

    const container = resolveHtmlArtifactScrollContainer(shell)
    dispatchHtmlArtifactAutoScrollSuspend(container)
    pendingScrollAnchorRef.current = {
      container,
      top: shell.getBoundingClientRect().top,
    }
  }, [])
  const handleDownload = useCallback((): void => {
    downloadTextFile(buildArtifactDownloadFilename(title), htmlDocument, {
      mimeType: 'text/html;charset=utf-8',
    })
  }, [htmlDocument, title])
  const handleRetry = useCallback((): void => {
    captureScrollAnchor()
    setRenderBroken(false)
    setShowCode(false)
    setReloadKey((value) => value + 1)
  }, [captureScrollAnchor])

  // 自动修复已移除:iframe 渲染真损坏时只在卡片内联提示,由用户决定重试(重载 iframe),
  // 不再向对话注入任何消息。良性运行时错误静默忽略。
  useEventListener(HTML_PREVIEW_ERROR_EVENT, (event: Event) => {
    if (!(event instanceof CustomEvent) || !isObject(event.detail)) return
    const detail = event.detail as Record<string, unknown>
    if (detail.artifactId !== block.artifactId) return
    if (!isGenuineArtifactRenderBreak(detail.phase)) return
    setRenderBroken(true)
  })

  useLayoutEffect(() => {
    const anchor = pendingScrollAnchorRef.current
    const shell = shellRef.current
    pendingScrollAnchorRef.current = null
    if (!anchor || !shell) return

    restoreHtmlArtifactScrollAnchor(anchor, shell)
    const animationFrameLease = timers.nextFrame(
      () => {
        restoreHtmlArtifactScrollAnchor(anchor, shell)
      },
      { label: 'html-artifact.restore-scroll-anchor' }
    )

    return () => {
      animationFrameLease.cancel()
    }
  }, [reloadKey, showCode, timers])

  // 全屏层由中立预览适配层提供:流式半成品在层内增量更新、不参与聊天流布局;用户关闭
  // 只收起预览、不影响协议继续生成;生成完毕自动落回页面,亦可随时经工具组全屏按钮重开。
  const fullscreenLayer = (
    <HtmlPreviewFullscreenLayer
      open={layerOpen}
      onOpenChange={handleLayerOpenChange}
      title={title}
      statusText={block.isStreaming ? t('chat.htmlArtifactLoading') : undefined}
    >
      {hasRenderableArtifact && (
        <HtmlPreviewFrame
          html={artifactHtml}
          artifactId={block.artifactId}
          fillHost
          fitViewportWidth
          patches={artifactPatches}
          patchRevision={block.patchRevision ?? artifactPatches.length}
          initialHeight={block.initialHeight ?? DEFAULT_HTML_PREVIEW_HEIGHT}
          protocolText={block.protocolText ?? artifactHtml}
          reloadKey={reloadKey}
          sizeLockReady={false}
          title={title}
        />
      )}
    </HtmlPreviewFullscreenLayer>
  )

  // 无壳渲染：制品直接融进聊天页,不加卡片外框/标题栏;工具按钮悬浮右上角,hover 才显。
  return (
    <>
      <div ref={shellRef} className={styles.chromelessRoot}>
        {presentation.inline === 'artifact' && (
          <div className={styles.floatingActions}>
            <HtmlPreviewToolbar
              copyLabel={t('chat.htmlArtifactCopyCode')}
              copiedLabel={t('chat.codeBlockCopied')}
              copyValue={htmlDocument}
              downloadLabel={t('chat.htmlArtifactDownloadHtml')}
              previewLabel={t('chat.widgetOpenPreview')}
              reloadLabel={t('chat.htmlArtifactReload')}
              showCode={showCode}
              showCodeLabel={t('chat.htmlArtifactShowCode')}
              hideCodeLabel={t('chat.htmlArtifactHideCode')}
              actionButtonClassName={styles.actionButton}
              onDownload={handleDownload}
              onOpenPreview={() => setLayerOpen(true)}
              onReload={() => {
                captureScrollAnchor()
                setShowCode(false)
                setReloadKey((value) => value + 1)
              }}
              onToggleCode={() => {
                captureScrollAnchor()
                setShowCode((value) => !value)
              }}
            />
          </div>
        )}
        {presentation.inline === 'loading' ? (
          <div className={styles.stateRoot}>
            <span className={styles.runningDot} aria-hidden="true" />
            <Text>{t('chat.htmlArtifactLoading')}</Text>
          </div>
        ) : presentation.inline === 'streaming-preview' ? (
          <div className={styles.streamingInlineShell}>
            <div className={styles.streamingInlineStatus} role="status">
              <span className={styles.runningDot} aria-hidden="true" />
              <Text>{t('chat.htmlArtifactLoading')}</Text>
            </div>
            {hasRenderableArtifact && (
              <HtmlPreviewFrame
                html={artifactHtml}
                artifactId={block.artifactId}
                fillHost
                fitViewportWidth
                patches={artifactPatches}
                patchRevision={block.patchRevision ?? artifactPatches.length}
                initialHeight={block.initialHeight ?? DEFAULT_HTML_PREVIEW_HEIGHT}
                protocolText={block.protocolText ?? artifactHtml}
                reloadKey={reloadKey}
                sizeLockReady={false}
                title={title}
              />
            )}
          </div>
        ) : showCode ? (
          // 与 widget 卡同规:查看源码=复制=下载,同一份完整可运行文档。
          <HtmlArtifactSourceCode source={htmlDocument} />
        ) : (
          <div className={styles.chromelessFrameShell}>
            {renderBroken && (
              <div className={styles.renderErrorNotice} role="status">
                <Text className={styles.renderErrorText}>{t('chat.htmlArtifactRenderError')}</Text>
                <Button variant="link" onClick={handleRetry}>
                  {t('chat.htmlArtifactRetry')}
                </Button>
              </div>
            )}
            <HtmlPreviewFrame
              html={artifactHtml}
              artifactId={block.artifactId}
              fitViewportWidth
              patches={artifactPatches}
              patchRevision={block.patchRevision ?? artifactPatches.length}
              initialHeight={block.initialHeight ?? DEFAULT_HTML_PREVIEW_HEIGHT}
              protocolText={block.protocolText ?? artifactHtml}
              reloadKey={reloadKey}
              title={title}
            />
          </div>
        )}
      </div>
      {fullscreenLayer}
    </>
  )
})

export { HtmlArtifactBlock }
