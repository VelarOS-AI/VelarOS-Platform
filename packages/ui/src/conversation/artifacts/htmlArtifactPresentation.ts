export interface HtmlArtifactPresentation {
  inline: 'artifact' | 'loading' | 'streaming-preview'
}

const DismissedStreamingArtifactIds = new Set<string>()

export function dismissHtmlArtifactGenerationLayer(artifactId: string): void {
  if (artifactId) DismissedStreamingArtifactIds.add(artifactId)
}

export function restoreHtmlArtifactGenerationLayer(artifactId: string): void {
  DismissedStreamingArtifactIds.delete(artifactId)
}

export function wasHtmlArtifactGenerationLayerDismissed(artifactId: string): boolean {
  return DismissedStreamingArtifactIds.has(artifactId)
}

export function dismissHtmlArtifactGenerationLayerOnUnmount({
  artifactId,
  isGenerationLayerOpen,
  isStreaming,
}: {
  artifactId: string
  isGenerationLayerOpen: boolean
  isStreaming: boolean
}): void {
  if (isStreaming && isGenerationLayerOpen) {
    dismissHtmlArtifactGenerationLayer(artifactId)
  }
}

/**
 * 聊天流内联形态:全屏生成层打开时保留稳定占位;用户收起后改在固定高度区域继续渲染;
 * 协议 close 后最终 HTML 才平铺挂载。全屏开合由 HtmlArtifactBlock 的 layerOpen state 管理。
 */
export function resolveHtmlArtifactPresentation({
  hasRenderableArtifact,
  isGenerationLayerOpen,
  isStreaming,
}: {
  hasRenderableArtifact: boolean
  isGenerationLayerOpen: boolean
  isStreaming: boolean
}): HtmlArtifactPresentation {
  if (isStreaming) return { inline: isGenerationLayerOpen ? 'loading' : 'streaming-preview' }

  return { inline: hasRenderableArtifact ? 'artifact' : 'loading' }
}
