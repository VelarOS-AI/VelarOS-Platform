/**
 * 宿主侧的 frame 适配：把 iframe 报上来的自然尺寸，换算成宿主该给的 frame 尺寸与缩放比。
 * 这是宿主侧的最后一道边界，沙箱内部还有一份自己的宽度反馈保护。
 */
import { HtmlArtifactDefaults } from '../contract/constants.js'
import type { HtmlArtifactFrameFit, HtmlArtifactFrameFitInput } from '../types/html-artifacts.js'

import { isFinitePositiveNumber } from './runtime-guards.js'

/** 取一个正数，不是正数就返回 null。 */
function readPositiveNumber(value: HtmlArtifactFrameFitInput['naturalWidth']): Nullable<number> {
  return isFinitePositiveNumber(value) ? value : null
}

/** 把一个尺寸收成至少 1 像素的整数。 */
function toDimension(value: number): number {
  return Math.max(1, Math.ceil(value))
}

/**
 * 算一次 frame 适配。没测出来时按兜底高度与宿主宽度给一份未锁定的结果；
 * 测出来了就按宽度比例缩放。宿主会缩放过宽内容，极端宽度请求可能把正文压成无法阅读的细条——
 * 超过宿主宽度的 `hostMaxScaleDownWidthRatio` 倍后停止继续缩放，改由文档内部裁切或滚动。
 */
export function resolveHtmlArtifactFrameFit(
  input: HtmlArtifactFrameFitInput
): HtmlArtifactFrameFit {
  const measuredNaturalWidth = readPositiveNumber(input.naturalWidth)
  const naturalHeight = readPositiveNumber(input.naturalHeight)
  const maxViewportWidth = readPositiveNumber(input.maxViewportWidth)
  const reportedNaturalWidth =
    measuredNaturalWidth
      && maxViewportWidth
      && measuredNaturalWidth > maxViewportWidth * HtmlArtifactDefaults.hostMaxScaleDownWidthRatio
      ? maxViewportWidth
      : measuredNaturalWidth
  const naturalWidth =
    input.preferViewportWidth
      && maxViewportWidth
      && (!reportedNaturalWidth || reportedNaturalWidth <= maxViewportWidth)
      ? maxViewportWidth
      : reportedNaturalWidth
  const fallbackHeight = toDimension(readPositiveNumber(input.fallbackHeight) ?? 1)
  const fallbackWidth = toDimension(maxViewportWidth ?? naturalWidth ?? 1)

  if (!naturalWidth || !naturalHeight || !maxViewportWidth)
    return {
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
