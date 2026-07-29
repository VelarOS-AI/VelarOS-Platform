import React, { memo, useCallback, useMemo, useState } from 'react'
import { WarningCircleIcon } from '@phosphor-icons/react'

import { normalizeHtmlArtifactSource } from '@velaros-ai/html-artifacts/sandbox'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import { HtmlArtifactSourceCode } from '../../artifacts/HtmlArtifactSourceCode'
import { downloadTextFile } from '../../html-preview/download'
import { buildPortableHtmlDocument } from '../../html-preview/htmlPreviewDocument'
import { HtmlPreviewFrame } from '../../html-preview/HtmlPreviewFrame'
import { HtmlPreviewFullscreenLayer } from '../../html-preview/HtmlPreviewFullscreenLayer'
import { HtmlPreviewToolbar } from '../../html-preview/HtmlPreviewToolbar'
import { useConversationI18n } from '../../i18n'

import { clampHeight, readNumber, readString, resolveWidgetTitle } from './widgetArgs.utils'
import { DEFAULT_WIDGET_HEIGHT } from './widgetToolConstants'
import { WidgetToolShell } from './WidgetToolShell'

import styles from '../../html-preview/HtmlPreview.module.css'

import type { ToolCallBlock } from '#contracts'

function buildWidgetDownloadFilename(title: string): string {
  const baseName = title
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)

  return `${baseName || 'widget'}.html`
}

const WidgetToolRender = memo(function WidgetToolRender({
  block,
}: {
  block: ToolCallBlock
  compact?: boolean
  sessionId?: string
}): React.ReactElement {
  const { locale, t } = useConversationI18n()
  const [showCode, setShowCode] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const title = resolveWidgetTitle(block.args, locale, t('chat.widgetDefaultTitle'))
  const widgetArtifactSnapshot = block.widgetArtifactSnapshot
  // 快照可能来自剥壳修复前的历史会话,读取时也过一遍宽容剥壳(幂等)。
  const rawWidgetCode =
    readString(widgetArtifactSnapshot?.htmlSource) || readString(block.args.widget_code)
  const widgetCode = rawWidgetCode ? normalizeHtmlArtifactSource(rawWidgetCode) : rawWidgetCode
  const initialHeight = clampHeight(readNumber(block.args.height) ?? DEFAULT_WIDGET_HEIGHT)
  // 导出面(查看源码/复制/下载)用**纯净文档**:只含页面自身需要的 meta/视觉 CSS/模型内容,
  // 不带桥接与测量等宿主内部逻辑;快照 compiledHtml 是内部壳编译产物,不再用于导出。
  const htmlDocument = useMemo(
    () => (widgetCode ? buildPortableHtmlDocument(widgetCode) : null),
    [widgetCode]
  )
  const hasRenderableWidget = !!htmlDocument && !!widgetCode && !block.error
  const handleDownload = useCallback((): void => {
    if (!htmlDocument) return

    downloadTextFile(buildWidgetDownloadFilename(title), htmlDocument, {
      mimeType: 'text/html;charset=utf-8',
    })
  }, [htmlDocument, title])

  const actions = hasRenderableWidget && (
    <HtmlPreviewToolbar
      copyLabel={t('chat.widgetCopyCode')}
      copiedLabel={t('chat.codeBlockCopied')}
      copyValue={htmlDocument ?? ''}
      downloadLabel={t('chat.widgetDownloadHtml')}
      previewLabel={t('chat.widgetOpenPreview')}
      reloadLabel={t('chat.widgetReload')}
      showCode={showCode}
      showCodeLabel={t('chat.widgetShowCode')}
      hideCodeLabel={t('chat.widgetHideCode')}
      actionButtonClassName={styles.actionButton}
      onDownload={handleDownload}
      onOpenPreview={() => {
        setPreviewOpen(true)
      }}
      onReload={() => {
        setShowCode(false)
        setReloadKey((value) => value + 1)
      }}
      onToggleCode={() => {
        setShowCode((value) => !value)
      }}
    />
  )
  // 全屏预览与 HTML artifact 共用同一套全屏层(不透明应用背景融入,Radix Dialog 管 Esc/焦点)。
  const previewLayer = (
    <HtmlPreviewFullscreenLayer open={previewOpen} onOpenChange={setPreviewOpen} title={title}>
      {hasRenderableWidget && (
        <HtmlPreviewFrame
          artifactId={block.widgetArtifact?.artifactId}
          fillHost
          fitViewportWidth
          html={widgetCode}
          initialHeight={initialHeight}
          reloadKey={reloadKey}
          title={title}
        />
      )}
    </HtmlPreviewFullscreenLayer>
  )

  return (
    <>
      <WidgetToolShell title={title} actions={actions}>
        {block.error ? (
          <div className={styles.stateRoot}>
            <WarningCircleIcon size={14} weight="fill" />
            <Text>{block.error}</Text>
          </div>
        ) : !hasRenderableWidget ? (
          <div className={styles.stateRoot}>
            <span className={styles.runningDot} aria-hidden="true" />
            <Text>{t('chat.widgetLoading')}</Text>
          </div>
        ) : showCode ? (
          // 查看源码/复制/下载三者同源:都是当前 shell 编译出的**完整可运行文档**,
          // 不再只显示模型片段(用户裁定:源码视图必须与下载一致)。
          <HtmlArtifactSourceCode source={htmlDocument ?? ''} />
        ) : (
          <div className={styles.frameShell}>
            <HtmlPreviewFrame
              artifactId={block.widgetArtifact?.artifactId}
              fitViewportWidth
              html={widgetCode}
              initialHeight={initialHeight}
              reloadKey={reloadKey}
              title={title}
            />
          </div>
        )}
      </WidgetToolShell>
      {previewLayer}
    </>
  )
})

export { WidgetToolRender }
