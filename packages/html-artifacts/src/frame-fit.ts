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
 * Hosts render wide content by scaling it down, so an extreme width request turns into an unreadable
 * sliver. Past this multiple of the host width the frame stops scaling and lets the document clip or
 * scroll internally — the sandbox has its own width feedback guard, this is the last line of defence
 * for any host or document shape that evades it.
 */
const MAX_SCALE_DOWN_WIDTH_RATIO = 4

function readPositiveNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
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
