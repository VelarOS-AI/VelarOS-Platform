/**
 * 比一屏大的截图（整页、高过一屏的区域）按一屏切块再拼：读尺寸、切块、定清晰度、拷像素，以及按块截下拼成一张。
 *
 * 为什么切块：`<webview>` 里的页面只按 `<webview>` 元素那么大出画面，captureBeyondViewport 一次截比它大的一块时，
 * 超出的部分是第一屏反复平铺；每块不超过一屏时，视口外的内容也截得对（页面不滚动，fixed 元素只在它此刻所在的位置出现一次）。
 * 普通窗口里的页面这么截同样对，所以内嵌页面一律按一屏切块。
 */
import electron from 'electron'

import { isFiniteNumber, isPlainObject, isString } from '@velaros-ai/core'

import type { BrowserScreenshotMetadata, BrowserScreenshotRect } from '../../types/browser'
import type {
  BrowserScreenshotBitmap,
  BrowserScreenshotLayout,
  BrowserScreenshotTilePlacement,
  BrowserScreenshotTilePlan,
} from '../../types/electron.js'
import { clampInteger, readFiniteNumber } from '../numbers.js'
import { BrowserTuning } from '../tuning'

/**
 * 把 Page.getLayoutMetrics 的回包归一成截图要的尺寸，缺的项用页面脚本量到的元数据补。
 * 一次最多截多大按视觉视口算：视口里看得到的内容（不含滚动条）乘页面缩放，就是它在画面上占的大小；
 * 没写 meta viewport 的手机页按 980 宽排版、缩小显示，一屏装得下 980 CSS 像素，按 clip 缩放 1 截却只装得下 390。
 */
export function normalizeScreenshotLayout(
  metrics: unknown,
  metadata: BrowserScreenshotMetadata
): BrowserScreenshotLayout {
  const readRecord = (value: unknown): Record<string, unknown> =>
    isPlainObject(value) ? value : {}
  const record = readRecord(metrics)
  const content = isPlainObject(record.cssContentSize)
    ? record.cssContentSize
    : readRecord(record.contentSize)
  const visual = readRecord(record.cssVisualViewport)
  const pageScale = readFiniteNumber(visual.scale) ?? 1
  // 乘出来的浮点误差（389.99999）不该让每块少一像素，多截一块
  const viewSize = (client: unknown, fallback: number): number =>
    isFiniteNumber(client) ? Math.max(1, Math.floor(client * pageScale + 0.01)) : fallback

  return {
    documentWidth: clampInteger(readFiniteNumber(content.width), 1, 32_000, metadata.documentWidth),
    documentHeight: clampInteger(
      readFiniteNumber(content.height),
      1,
      32_000,
      metadata.documentHeight
    ),
    viewWidth: viewSize(visual.clientWidth, metadata.viewportWidth),
    viewHeight: viewSize(visual.clientHeight, metadata.viewportHeight),
  }
}

/** 拼接图每 CSS 像素几个像素：不超过页面本来的清晰度（devicePixelRatio），也不让整张图超过单边与总像素的上限。 */
export function resolveStitchedImageScale(
  deviceScaleFactor: number,
  width: number,
  height: number
): number {
  const { stitchedImageMaxPixels, stitchedImageMaxSide } = BrowserTuning.screenshot
  return Math.min(
    deviceScaleFactor,
    stitchedImageMaxSide / Math.max(1, width),
    stitchedImageMaxSide / Math.max(1, height),
    Math.sqrt(stitchedImageMaxPixels / Math.max(1, width * height))
  )
}

/**
 * 按一屏大小把要截的区域切块：每块按 clip 缩放截下来都不超过一屏。
 * 整张图超出像素上限时 clip 缩放小于 1，块跟着放大、块数跟着变少；块从上到下、从左到右，互不重叠。
 */
export function planScreenshotTiles(
  area: BrowserScreenshotRect,
  layout: BrowserScreenshotLayout,
  deviceScaleFactor: number
): BrowserScreenshotTilePlan {
  const density = Math.max(0.01, deviceScaleFactor)
  const clipScale = Math.min(
    1,
    resolveStitchedImageScale(density, area.width, area.height) / density
  )
  const tileWidth = Math.max(1, Math.floor(layout.viewWidth / clipScale))
  const tileHeight = Math.max(1, Math.floor(layout.viewHeight / clipScale))

  const tiles: BrowserScreenshotRect[] = []
  for (let top = 0; top < area.height; top += tileHeight) {
    for (let left = 0; left < area.width; left += tileWidth) {
      tiles.push({
        x: area.x + left,
        y: area.y + top,
        width: Math.min(tileWidth, area.width - left),
        height: Math.min(tileHeight, area.height - top),
      })
    }
  }
  return { clipScale, tiles }
}

/** 算一块截图往拼接图里拷的位置：块的四条边按拼接比例各自取整，相邻两块共用同一条边，不留缝也不重叠。 */
export function resolveScreenshotTilePlacement(
  tile: BrowserScreenshotRect,
  area: BrowserScreenshotRect,
  scale: number
): BrowserScreenshotTilePlacement {
  const left = Math.round((tile.x - area.x) * scale)
  const top = Math.round((tile.y - area.y) * scale)
  return {
    target: {
      left,
      top,
      right: Math.round((tile.x + tile.width - area.x) * scale),
      bottom: Math.round((tile.y + tile.height - area.y) * scale),
    },
    offsetX: -left,
    offsetY: -top,
  }
}

/** 把一块截图的像素按整数偏移拷进拼接图的目标矩形；取整差出来、落在源图外的那一两列一两行取边上的像素。 */
export function blitScreenshotTile(
  canvas: BrowserScreenshotBitmap,
  tile: BrowserScreenshotBitmap,
  placement: BrowserScreenshotTilePlacement
): void {
  const clamp = (value: number, max: number): number => Math.min(max, Math.max(0, value))
  const left = clamp(placement.target.left, canvas.width)
  const right = clamp(placement.target.right, canvas.width)
  const top = clamp(placement.target.top, canvas.height)
  const bottom = clamp(placement.target.bottom, canvas.height)
  if (right <= left || bottom <= top || tile.width < 1 || tile.height < 1) return

  const { offsetX, offsetY } = placement
  const insideStart = Math.min(right, Math.max(left, -offsetX))
  const insideEnd = Math.max(insideStart, Math.min(right, tile.width - offsetX))
  for (let y = top; y < bottom; y += 1) {
    const targetRow = y * canvas.width * 4
    const sourceRow = clamp(y + offsetY, tile.height - 1) * tile.width * 4
    if (insideEnd > insideStart) {
      tile.data.copy(
        canvas.data,
        targetRow + insideStart * 4,
        sourceRow + (insideStart + offsetX) * 4,
        sourceRow + (insideEnd + offsetX) * 4
      )
    }
    for (let x = left; x < insideStart; x += 1) {
      tile.data.copy(canvas.data, targetRow + x * 4, sourceRow, sourceRow + 4)
    }
    const lastPixel = sourceRow + (tile.width - 1) * 4
    for (let x = insideEnd; x < right; x += 1) {
      tile.data.copy(canvas.data, targetRow + x * 4, lastPixel, lastPixel + 4)
    }
  }
}

/**
 * 截页面上的一块（页面 CSS 像素）：按一屏大小切块，每块经 captureBeyondViewport 截下，多于一块时拼成一张；截不到交回 null。
 * 调用方要先 attach webContents 的 debugger。每块截图时页面会按那一块重新出一帧，界面上看得见，但页面不滚动、版面不变。
 */
export async function captureScreenshotArea(
  webContents: Electron.WebContents,
  area: BrowserScreenshotRect,
  layout: BrowserScreenshotLayout,
  deviceScaleFactor: number,
  abortSignal?: AbortSignal
): Promise<Nullable<Electron.NativeImage>> {
  const plan = planScreenshotTiles(area, layout, deviceScaleFactor)
  let canvas: Nullable<BrowserScreenshotBitmap> = null
  let scale = 1
  for (const tile of plan.tiles) {
    abortSignal?.throwIfAborted()
    const image = await captureScreenshotClip(webContents, tile, plan.clipScale)
    if (!image) return null
    if (plan.tiles.length === 1) return image

    const size = image.getSize()
    if (!canvas) {
      scale = size.width / tile.width
      const width = Math.max(1, Math.round(area.width * scale))
      const height = Math.max(1, Math.round(area.height * scale))
      canvas = { data: Buffer.alloc(width * height * 4), width, height }
    }
    blitScreenshotTile(
      canvas,
      { data: image.toBitmap(), width: size.width, height: size.height },
      resolveScreenshotTilePlacement(tile, area, scale)
    )
  }
  return canvas
    ? electron.nativeImage.createFromBitmap(canvas.data, {
        width: canvas.width,
        height: canvas.height,
      })
    : null
}

/** 截页面上不超过一屏的一块（页面 CSS 像素，含滚动），交回解好的图；截不到交回 null。 */
async function captureScreenshotClip(
  webContents: Electron.WebContents,
  clip: BrowserScreenshotRect,
  scale: number
): Promise<Nullable<Electron.NativeImage>> {
  const captured = (await webContents.debugger.sendCommand('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    optimizeForSpeed: true,
    clip: { ...clip, scale },
  })) as { data?: string }
  if (!isString(captured.data) || !captured.data.trim()) return null

  const image = electron.nativeImage.createFromBuffer(Buffer.from(captured.data, 'base64'))
  return image.isEmpty() ? null : image
}
