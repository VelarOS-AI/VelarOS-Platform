export interface HtmlArtifactFrameFit {
  contentHeight: number
  contentWidth: number
  locked: boolean
  scale: number
  viewportHeight: number
  viewportWidth: number
}

export interface HtmlArtifactFrameFitInput {
  fallbackHeight: number
  maxViewportWidth?: number | null
  naturalHeight?: number | null
  naturalWidth?: number | null
  preferViewportWidth?: boolean
}

/**
 * 宿主会缩放过宽内容，极端宽度请求可能把正文压成无法阅读的细条。超过宿主宽度的这个倍数后，
 * frame 停止继续缩放，改由文档内部裁切或滚动。沙箱自身还有宽度反馈保护；这里是宿主侧的
 * 最后一道边界。
 */
const MAX_SCALE_DOWN_WIDTH_RATIO = 4

function readPositiveNumber(value: HtmlArtifactFrameFitInput['naturalWidth']) {
  return isFinitePositiveNumber(value) ? value : null
}

function toDimension(value: number): number {
  return Math.max(1, Math.ceil(value))
}

export function resolveHtmlArtifactFrameFit(input: HtmlArtifactFrameFitInput): HtmlArtifactFrameFit {
  const measuredNaturalWidth = readPositiveNumber(input.naturalWidth)
  const naturalHeight = readPositiveNumber(input.naturalHeight)
  const maxViewportWidth = readPositiveNumber(input.maxViewportWidth)
  const reportedNaturalWidth =
    measuredNaturalWidth &&
    maxViewportWidth &&
    measuredNaturalWidth > maxViewportWidth * MAX_SCALE_DOWN_WIDTH_RATIO
      ? maxViewportWidth
      : measuredNaturalWidth
  const naturalWidth =
    input.preferViewportWidth &&
    maxViewportWidth &&
    (!reportedNaturalWidth || reportedNaturalWidth <= maxViewportWidth)
      ? maxViewportWidth
      : reportedNaturalWidth
  const fallbackHeight = toDimension(readPositiveNumber(input.fallbackHeight) ?? 1)
  const fallbackWidth = toDimension(maxViewportWidth ?? naturalWidth ?? 1)

  if (!naturalWidth || !naturalHeight || !maxViewportWidth) return {
      contentHeight: fallbackHeight,
      contentWidth: fallbackWidth,
      locked: false,
      scale: 1,
      viewportHeight: fallbackHeight,
      viewportWidth: fallbackWidth,
    }

  const scale = naturalWidth > maxViewportWidth ? maxViewportWidth / naturalWidth : 1
  const viewportWidth = toDimension(Math.min(naturalWidth, maxViewportWidth))
  const viewportHeight = toDimension(naturalHeight * scale)

  return {
    contentHeight: toDimension(naturalHeight),
    contentWidth: toDimension(naturalWidth),
    locked: true,
    scale,
    viewportHeight,
    viewportWidth,
  }
}
import { isFinitePositiveNumber } from './positive-number.js'
