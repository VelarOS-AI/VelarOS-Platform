/**
 * @test-meta
 * title: 截图分块拼接
 * summary: 比一屏大的截图按一屏切块、每块截完拼回一张：块不超过一屏、互不重叠、正好铺满；拼出来的图逐像素等于整页；超出像素上限时一起降清晰度。
 * area: packages
 */
// 历史事故：内嵌 <webview> 一次截整页，超出一屏的部分是第一屏反复平铺（webview 只按元素那么大出画面）。
// 真实 webview 的验证在 test/probes/electron-full-page-screenshot.probe.mjs；这里钉住切块与拼接的算术。
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { BrowserScreenshotMetadata, BrowserScreenshotRect } from '../../types/browser.js'
import type { BrowserScreenshotBitmap, BrowserScreenshotLayout } from '../../types/electron.js'
import {
  blitScreenshotTile,
  normalizeScreenshotLayout,
  planScreenshotTiles,
  resolveScreenshotTilePlacement,
  resolveStitchedImageScale,
} from '../../utils/electron/screenshot-tiles.js'
import { BrowserTuning } from '../../utils/tuning.js'

const layoutOf = (viewWidth: number, viewHeight: number): BrowserScreenshotLayout => ({
  documentWidth: 1,
  documentHeight: 1,
  viewWidth,
  viewHeight,
})

/** 切出来的块应当互不重叠、正好铺满区域：逐块累加面积等于区域面积，且每块都在区域里。 */
function assertCovers(area: BrowserScreenshotRect, tiles: BrowserScreenshotRect[]): void {
  let covered = 0
  for (const tile of tiles) {
    assert.ok(tile.x >= area.x && tile.y >= area.y, `块 ${JSON.stringify(tile)} 在区域外`)
    assert.ok(tile.x + tile.width <= area.x + area.width)
    assert.ok(tile.y + tile.height <= area.y + area.height)
    covered += tile.width * tile.height
  }
  assert.equal(covered, area.width * area.height)
  const keys = new Set(tiles.map((tile) => `${tile.x},${tile.y}`))
  assert.equal(keys.size, tiles.length)
}

/** 一张「页面」位图：每个像素的四个字节由坐标算出，互不相同。 */
function pageBitmap(width: number, height: number): BrowserScreenshotBitmap {
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.writeUInt32LE((y * 1_000 + x) * 7 + 1, (y * width + x) * 4)
    }
  }
  return { data, width, height }
}

/** 模拟截一块：取页面上这一块，按整数倍放大（最近邻），就是清晰度为 scale 的截图。 */
function captureTile(
  page: BrowserScreenshotBitmap,
  tile: BrowserScreenshotRect,
  scale: number
): BrowserScreenshotBitmap {
  const width = tile.width * scale
  const height = tile.height * scale
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source =
        ((tile.y + Math.floor(y / scale)) * page.width + tile.x + Math.floor(x / scale)) * 4
      page.data.copy(data, (y * width + x) * 4, source, source + 4)
    }
  }
  return { data, width, height }
}

/** 按分块截图再拼回一张，交回拼接图。 */
function stitch(
  page: BrowserScreenshotBitmap,
  area: BrowserScreenshotRect,
  view: BrowserScreenshotLayout,
  scale: number,
  shrink: (tile: BrowserScreenshotBitmap) => BrowserScreenshotBitmap = (tile) => tile
): BrowserScreenshotBitmap {
  const plan = planScreenshotTiles(area, view, scale)
  const canvas = {
    data: Buffer.alloc(area.width * scale * area.height * scale * 4),
    width: area.width * scale,
    height: area.height * scale,
  }
  for (const tile of plan.tiles) {
    blitScreenshotTile(
      canvas,
      shrink(captureTile(page, tile, scale)),
      resolveScreenshotTilePlacement(tile, area, scale)
    )
  }
  return canvas
}

void describe('截图分块', () => {
  void test('整页按一屏切块：块不超过一屏、互不重叠、正好铺满', () => {
    const area = { x: 0, y: 0, width: 1440, height: 6000 }
    const plan = planScreenshotTiles(area, layoutOf(1440, 900), 1)

    assert.equal(plan.clipScale, 1)
    assert.equal(plan.tiles.length, 7)
    assert.deepEqual(
      plan.tiles.map((tile) => [tile.y, tile.height]),
      [
        [0, 900],
        [900, 900],
        [1800, 900],
        [2700, 900],
        [3600, 900],
        [4500, 900],
        [5400, 600],
      ]
    )
    assertCovers(area, plan.tiles)
  })

  void test('横竖都超出一屏的页面切成网格，从上到下、从左到右', () => {
    const area = { x: 0, y: 0, width: 2000, height: 3000 }
    const plan = planScreenshotTiles(area, layoutOf(1440, 900), 1)

    assert.deepEqual(
      plan.tiles.map((tile) => [tile.x, tile.y, tile.width, tile.height]),
      [
        [0, 0, 1440, 900],
        [1440, 0, 560, 900],
        [0, 900, 1440, 900],
        [1440, 900, 560, 900],
        [0, 1800, 1440, 900],
        [1440, 1800, 560, 900],
        [0, 2700, 1440, 300],
        [1440, 2700, 560, 300],
      ]
    )
    assertCovers(area, plan.tiles)
  })

  void test('区域截图从区域的位置切起；不超过一屏的区域只截一块', () => {
    const tall = { x: 40, y: 2000, width: 300, height: 2500 }
    const tallPlan = planScreenshotTiles(tall, layoutOf(1440, 900), 2)
    assert.deepEqual(
      tallPlan.tiles.map((tile) => [tile.x, tile.y, tile.height]),
      [
        [40, 2000, 900],
        [40, 2900, 900],
        [40, 3800, 700],
      ]
    )
    assertCovers(tall, tallPlan.tiles)

    const small = { x: 10, y: 3000, width: 300, height: 400 }
    assert.deepEqual(planScreenshotTiles(small, layoutOf(1440, 900), 2).tiles, [small])
  })

  void test('超出像素上限时一起降清晰度：块按 clip 缩放放大，截下来仍不超过一屏，整张图守住上限', () => {
    const area = { x: 0, y: 0, width: 1440, height: 16_000 }
    const view = layoutOf(1440, 900)
    const plan = planScreenshotTiles(area, view, 2)

    assert.ok(plan.clipScale < 1)
    for (const tile of plan.tiles) {
      assert.ok(tile.width * plan.clipScale <= view.viewWidth)
      assert.ok(tile.height * plan.clipScale <= view.viewHeight)
    }
    assertCovers(area, plan.tiles)
    const scale = plan.clipScale * 2
    const { stitchedImageMaxPixels, stitchedImageMaxSide } = BrowserTuning.screenshot
    assert.ok(
      Math.round(area.width * scale) * Math.round(area.height * scale) <=
        stitchedImageMaxPixels * 1.001
    )
    assert.ok(Math.round(area.height * scale) <= stitchedImageMaxSide)
    assert.equal(resolveStitchedImageScale(2, 1440, 900), 2)
  })

  void test('没写 meta viewport 的手机页：一屏按视觉视口乘页面缩放算，浮点误差不让它少一像素', () => {
    const metadata = {
      documentWidth: 1,
      documentHeight: 1,
      viewportWidth: 980,
      viewportHeight: 2121,
    } as BrowserScreenshotMetadata
    const layout = normalizeScreenshotLayout(
      {
        cssContentSize: { x: 0, y: 0, width: 980, height: 4000 },
        cssVisualViewport: {
          clientWidth: 980,
          clientHeight: 2120.820556640625,
          scale: 0.3979591727256775,
        },
      },
      metadata
    )

    assert.deepEqual(layout, {
      documentWidth: 980,
      documentHeight: 4000,
      viewWidth: 390,
      viewHeight: 844,
    })
  })

  void test('读不到布局指标时用页面脚本量到的元数据', () => {
    const metadata = {
      documentWidth: 1200,
      documentHeight: 5000,
      viewportWidth: 1200,
      viewportHeight: 800,
    } as BrowserScreenshotMetadata

    assert.deepEqual(normalizeScreenshotLayout(null, metadata), {
      documentWidth: 1200,
      documentHeight: 5000,
      viewWidth: 1200,
      viewHeight: 800,
    })
  })
})

void describe('截图拼接', () => {
  void test('分块截再拼回，逐像素等于整页（清晰度 1 与 2）', () => {
    const page = pageBitmap(10, 7)
    const area = { x: 0, y: 0, width: 10, height: 7 }
    for (const scale of [1, 2]) {
      const canvas = stitch(page, area, layoutOf(4, 3), scale)
      assert.ok(canvas.data.equals(captureTile(page, area, scale).data), `清晰度 ${scale} 拼错了`)
    }
  })

  void test('区域不从原点起时按区域的位置拼', () => {
    const page = pageBitmap(12, 9)
    const area = { x: 3, y: 2, width: 7, height: 6 }
    const canvas = stitch(page, area, layoutOf(3, 4), 2)
    assert.ok(canvas.data.equals(captureTile(page, area, 2).data))
  })

  void test('截图比块少一像素时，缺的那一列一行取边上的像素，不留透明缝', () => {
    const page = pageBitmap(8, 6)
    const area = { x: 0, y: 0, width: 8, height: 6 }
    const shrink = (tile: BrowserScreenshotBitmap): BrowserScreenshotBitmap => {
      const width = tile.width - 1
      const height = tile.height - 1
      const data = Buffer.alloc(width * height * 4)
      for (let y = 0; y < height; y += 1) {
        tile.data.copy(data, y * width * 4, y * tile.width * 4, (y * tile.width + width) * 4)
      }
      return { data, width, height }
    }
    const canvas = stitch(page, area, layoutOf(4, 3), 1, shrink)

    for (let offset = 0; offset < canvas.data.length; offset += 4) {
      assert.notEqual(canvas.data.readUInt32LE(offset), 0, `像素 ${offset / 4} 没拼上`)
    }
    // 第一块 (0,0,4,3) 缺了 x=3 那一列：取它自己的最后一列 x=2
    assert.equal(canvas.data.readUInt32LE(3 * 4), page.data.readUInt32LE(2 * 4))
  })

  void test('相邻两块按任意清晰度换成像素都共用同一条边', () => {
    const area = { x: 0, y: 0, width: 1000, height: 3001 }
    const plan = planScreenshotTiles(area, layoutOf(333, 457), 1)
    for (const scale of [0.37, 0.8, 1, 1.25, 1.92]) {
      const placements = plan.tiles.map((tile) => resolveScreenshotTilePlacement(tile, area, scale))
      let pixels = 0
      for (const { target } of placements)
        pixels += (target.right - target.left) * (target.bottom - target.top)
      assert.equal(pixels, Math.round(area.width * scale) * Math.round(area.height * scale))
    }
  })
})
