/** 看图能力的实现细节测试：对外承诺在 spec/acceptance.test.ts，这里补图片头、region 收边、base64 长度、压图重试与几处边角。 */

import { spawnSync } from 'node:child_process'
import { chmod, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import type { ImageResizeRequest, ImageResizeResult } from '../index'
import { ImageLimits, imageOperations } from '../index'
import { failureOf, gifImage, imageSpace, jpegImage, jpegSegment, makeScratch, pngImage, pngResizer, removeScratch, webpFile, webpImage } from '../spec/support'
import { base64Length, clampImageRegion, detectMediaType, readImageSize, shrinkImageToLimits } from '../utils/image'
import { viewItems } from '../utils/input'
import { ImageTuning } from '../utils/tuning'

/** base64 之后正好压在上限上的原文件字节数：每 3 字节变 4 个字符。 */
const BytesAtBase64Limit = (ImageLimits.base64Bytes / 4) * 3

/** 压图用的两条上限，与 view 交给压图策略的一样。 */
const Limits = { longEdge: ImageLimits.edge, base64Bytes: ImageLimits.base64Bytes }

let root = ''
beforeEach(async () => {
  root = await makeScratch()
})
afterEach(async () => {
  await removeScratch(root)
})

describe('认文件头', () => {
  test('魔数：四种图认成 image，PDF 认成 document；RIFF 里装的不是 WEBP、签名只有半截、空文件都不认', () => {
    expect(detectMediaType(pngImage(1, 1))).toEqual({ kind: 'image', mediaType: 'image/png' })
    expect(detectMediaType(jpegImage(1, 1))).toEqual({ kind: 'image', mediaType: 'image/jpeg' })
    expect(detectMediaType(gifImage(1, 1, '87a'))).toEqual({ kind: 'image', mediaType: 'image/gif' })
    expect(detectMediaType(gifImage(1, 1, '89a'))).toEqual({ kind: 'image', mediaType: 'image/gif' })
    expect(detectMediaType(webpImage(1, 1, 'VP8X'))).toEqual({ kind: 'image', mediaType: 'image/webp' })
    expect(detectMediaType(Buffer.from('%PDF-1.4\n'))).toEqual({ kind: 'document', mediaType: 'application/pdf' })
    const wave = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WAVEfmt ', 'ascii')])
    for (const bytes of [wave, pngImage(1, 1).subarray(0, 7), Buffer.from([0xff, 0xd8]), Buffer.from('GIF', 'ascii'), Buffer.from('%PDF', 'ascii'), Buffer.alloc(0)]) {
      expect(detectMediaType(bytes)).toBeNull()
    }
  })

  test('PNG：宽高在 IHDR 里，只有头也认得；不足 24 字节读不出', () => {
    expect(readImageSize(pngImage(4000, 3000), 'image/png')).toEqual({ width: 4000, height: 3000 })
    expect(readImageSize(pngImage(7, 5).subarray(0, 24), 'image/png')).toEqual({ width: 7, height: 5 })
    expect(readImageSize(pngImage(7, 5).subarray(0, 23), 'image/png')).toBeNull()
  })

  test('GIF：逻辑屏幕的宽高是小端两字节，87a 与 89a 一样；不足 10 字节读不出', () => {
    expect(readImageSize(gifImage(320, 240, '87a'), 'image/gif')).toEqual({ width: 320, height: 240 })
    expect(readImageSize(gifImage(65_535, 1), 'image/gif')).toEqual({ width: 65_535, height: 1 })
    expect(readImageSize(gifImage(320, 240).subarray(0, 9), 'image/gif')).toBeNull()
  })

  test('JPEG：顺着段长找第一个帧头；霍夫曼表、算术编码表、保留标记落在帧头的标记区间里却不是帧头，要跳过', () => {
    // 帧头紧跟在 SOI 后面
    expect(readImageSize(jpegImage(600, 300, { before: [] }), 'image/jpeg')).toEqual({ width: 600, height: 300 })
    // JFIF 的 APP0、量化表之后才是 SOF0
    expect(readImageSize(jpegImage(1920, 1080), 'image/jpeg')).toEqual({ width: 1920, height: 1080 })
    // C4（霍夫曼表）、CC（算术编码表）、C8（保留）之后才是 SOF2（渐进）
    const tables = [jpegSegment(0xc4, Buffer.alloc(17)), jpegSegment(0xcc, Buffer.from([0x00, 0x10])), jpegSegment(0xc8, Buffer.alloc(3))]
    expect(readImageSize(jpegImage(4032, 3024, { frame: 0xc2, before: tables }), 'image/jpeg')).toEqual({ width: 4032, height: 3024 })
    // 帧头之前还有 EXIF 这种大段：按段长整段跳过，不逐字节扫
    const exif = jpegSegment(0xe1, Buffer.alloc(30_000, 0xff))
    expect(readImageSize(jpegImage(800, 600, { before: [exif] }), 'image/jpeg')).toEqual({ width: 800, height: 600 })
    // 各种帧头（基线、扩展、渐进、无损、差分、算术编码）都认
    for (const frame of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
      expect({ frame, size: readImageSize(jpegImage(10, 20, { frame }), 'image/jpeg') }).toEqual({ frame, size: { width: 10, height: 20 } })
    }
  })

  test('JPEG：段开头不是 0xFF、帧头之前文件就完了、段长指到文件外，都读不出', () => {
    const photo = jpegImage(640, 480)
    const broken = Buffer.from(photo)
    broken[2] = 0x00
    expect(readImageSize(broken, 'image/jpeg')).toBeNull()
    // 只剩 SOI 与 APP0：帧头被截掉了
    expect(readImageSize(photo.subarray(0, 2 + 18), 'image/jpeg')).toBeNull()
    expect(readImageSize(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), Buffer.alloc(20)]), 'image/jpeg')).toBeNull()
  })

  test('WebP：有损 VP8 取 14 位宽高（高两位的缩放不算）、无损 VP8L 从位域里取、扩展 VP8X 取 24 位画布', () => {
    expect(readImageSize(webpImage(1024, 768, 'VP8 '), 'image/webp')).toEqual({ width: 1024, height: 768 })
    expect(readImageSize(webpImage(1024, 768, 'VP8 ', { scaleBits: 3 }), 'image/webp')).toEqual({ width: 1024, height: 768 })
    expect(readImageSize(webpImage(16_383, 16_383, 'VP8 '), 'image/webp')).toEqual({ width: 16_383, height: 16_383 })
    expect(readImageSize(webpImage(1, 1, 'VP8L'), 'image/webp')).toEqual({ width: 1, height: 1 })
    expect(readImageSize(webpImage(4000, 3000, 'VP8L'), 'image/webp')).toEqual({ width: 4000, height: 3000 })
    expect(readImageSize(webpImage(16_384, 16_384, 'VP8L'), 'image/webp')).toEqual({ width: 16_384, height: 16_384 })
    // VP8L 位域的高四位是透明与版本，不许混进高度
    const lossless = webpImage(300, 200, 'VP8L')
    lossless.writeUInt32LE((lossless.readUInt32LE(21) | (0b1111 << 28)) >>> 0, 21)
    expect(readImageSize(lossless, 'image/webp')).toEqual({ width: 300, height: 200 })
    expect(readImageSize(webpImage(20_000, 16_384, 'VP8X'), 'image/webp')).toEqual({ width: 20_000, height: 16_384 })
  })

  test('WebP：首块认不出、不足 30 字节，都读不出；不认的格式一律读不出', () => {
    expect(readImageSize(webpFile('ALPH', Buffer.alloc(10)), 'image/webp')).toBeNull()
    expect(readImageSize(webpImage(10, 10, 'VP8X').subarray(0, 29), 'image/webp')).toBeNull()
    expect(readImageSize(pngImage(10, 10), 'image/bmp')).toBeNull()
  })
})

describe('坏头与读不了的路径', () => {
  test('宽或高是 0 的图当作读不出尺寸；JPEG 标记前的 0xFF 填充字节跳过去照样认', () => {
    const zeroWide = pngImage(1, 1)
    zeroWide.writeUInt32BE(0, 16)
    expect(readImageSize(zeroWide, 'image/png')).toBeNull()
    const jpeg = jpegImage(640, 480)
    const padded = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xff]), jpeg.subarray(2)])
    expect(readImageSize(padded, 'image/jpeg')).toEqual({ width: 640, height: 480 })
  })

  test('路径上某一段是文件（ENOTDIR）算找不到，说明里只有给模型看的写法', async () => {
    await writeFile(join(root, 'shot.png'), pngImage(4, 4))
    const space = imageSpace({ root, clamp: true })
    const result = await imageOperations.view({ files: [{ path: 'shot.png/child.png' }, { path: 'shot.png' }] }, space.context)
    expect(result.files[0]).toEqual({ path: 'shot.png/child.png', error: { code: 'NOT_FOUND', message: '文件不存在：shot.png/child.png' } })
  })
})

describe('region 收边', () => {
  const size = { width: 4000, height: 3000 }

  test('在图里的原样；超出右边、下边的部分收掉；小数向下取整', () => {
    expect(clampImageRegion({ x: 10, y: 20, width: 300, height: 200 }, size)).toEqual({ x: 10, y: 20, width: 300, height: 200 })
    expect(clampImageRegion({ x: 3000, y: 0, width: 5000, height: 500 }, size)).toEqual({ x: 3000, y: 0, width: 1000, height: 500 })
    expect(clampImageRegion({ x: 0, y: 2900, width: 100, height: 500 }, size)).toEqual({ x: 0, y: 2900, width: 100, height: 100 })
    expect(clampImageRegion({ x: 0, y: 0, width: 99_999, height: 99_999 }, size)).toEqual({ x: 0, y: 0, width: 4000, height: 3000 })
    expect(clampImageRegion({ x: 10.7, y: 20.2, width: 100.9, height: 50.5 }, size)).toEqual({ x: 10, y: 20, width: 100, height: 50 })
  })

  test('超出左边、上边的部分也按交集收掉，不把那一块整体挪进图里', () => {
    expect(clampImageRegion({ x: -10, y: -20, width: 50, height: 60 }, size)).toEqual({ x: 0, y: 0, width: 40, height: 40 })
    expect(clampImageRegion({ x: -100, y: 0, width: 50, height: 50 }, size)).toBeNull()
    expect(clampImageRegion({ x: 0, y: -100, width: 50, height: 100 }, size)).toBeNull()
  })

  test('整块落在右边或下边的图外（贴着边也算）、宽高取整之后是 0，都交回 null', () => {
    for (const region of [
      { x: 4000, y: 0, width: 10, height: 10 },
      { x: 0, y: 3000, width: 10, height: 10 },
      { x: 5000, y: 5000, width: 1, height: 1 },
      { x: 0, y: 0, width: 0.5, height: 10 },
    ]) {
      expect({ region, clamped: clampImageRegion(region, size) }).toEqual({ region, clamped: null })
    }
  })
})

describe('base64 长度', () => {
  test('每 3 字节 4 个字符，不足 3 字节的补齐：与 Buffer 真编出来的一样长', () => {
    for (let bytes = 0; bytes <= 64; bytes += 1) expect({ bytes, length: base64Length(bytes) }).toEqual({ bytes, length: Buffer.alloc(bytes).toString('base64').length })
    expect(base64Length(BytesAtBase64Limit)).toBe(ImageLimits.base64Bytes)
    expect(base64Length(BytesAtBase64Limit + 1)).toBeGreaterThan(ImageLimits.base64Bytes)
  })
})

describe('压进上限', () => {
  /** 一个按长边决定交回多大的假缩放器：fits 说是就交回 1 KB，否则交回 base64 之后刚好超上限的字节。每次请求都记下。 */
  function sizedResizer(fits: (longEdge: number) => boolean) {
    const requests: ImageResizeRequest[] = []
    const resize = async (request: ImageResizeRequest): Promise<ImageResizeResult> => {
      requests.push(request)
      const bytes = fits(request.longEdge) ? 1024 : BytesAtBase64Limit + 1
      return { data: Buffer.alloc(bytes), mediaType: 'image/png', width: request.longEdge, height: Math.floor(request.longEdge / 2) }
    }
    return { requests, resize }
  }

  /** 按调参表算出每一次请的长边：从上限起，每次乘收缩系数向下取整，一共试这么多次。 */
  function shrinkSchedule(): number[] {
    const edges: number[] = [ImageLimits.edge]
    while (edges.length < ImageTuning.shrinkAttempts) edges.push(Math.floor(edges.at(-1)! * ImageTuning.shrinkFactor))
    return edges
  }

  test('头一次就压得进去的只请一次：长边是上限，字节、格式、region 原样带过去', async () => {
    const { requests, resize } = sizedResizer(() => true)
    const data = pngImage(4000, 3000)
    const region = { x: 1, y: 2, width: 3, height: 4 }
    const shrunk = await shrinkImageToLimits(resize, { data, mediaType: 'image/png', region }, Limits)
    expect(requests).toEqual([{ data, mediaType: 'image/png', region, longEdge: ImageLimits.edge }])
    expect(shrunk).toMatchObject({ mediaType: 'image/png', width: ImageLimits.edge })
  })

  test('压完 base64 还超，就把长边乘收缩系数再请，压进去为止', async () => {
    const schedule = shrinkSchedule()
    expect(schedule.length).toBeGreaterThanOrEqual(3)
    const { requests, resize } = sizedResizer((longEdge) => longEdge <= schedule[2]!)
    const shrunk = await shrinkImageToLimits(resize, { data: Buffer.alloc(1), mediaType: 'image/png' }, Limits)
    expect(requests.map((request) => request.longEdge)).toEqual(schedule.slice(0, 3))
    expect(shrunk.width).toBe(schedule[2]!)
  })

  test('试满调参表的次数还压不进去就拒绝，指向换更小的 region', async () => {
    const { requests, resize } = sizedResizer(() => false)
    const failure = await failureOf(shrinkImageToLimits(resize, { data: Buffer.alloc(1), mediaType: 'image/png' }, Limits))
    expect(failure.code).toBe('VALIDATION')
    expect(failure.message).toContain(`仍超过 ${ImageLimits.base64Bytes} 字节`)
    expect(failure.message).toContain('换一块更小的 region')
    expect(requests).toHaveLength(ImageTuning.shrinkAttempts)
    expect(requests.map((request) => request.longEdge)).toEqual(shrinkSchedule())
    // 报错里的长边是最后真试过的那一档，不是再收一截、没试过的那一档。
    expect(failure.message).toContain(`压到长边 ${shrinkSchedule().at(-1)} px`)
  })

  test('空间缩图失败原样抛出，不再重试；在 view 里只算那一张失败，码是空间给的', async () => {
    let calls = 0
    const broken = async (): Promise<never> => {
      calls += 1
      throw new AppError('PLATFORM', 'sips 退出码 1')
    }
    expect(await failureOf(shrinkImageToLimits(broken, { data: Buffer.alloc(1), mediaType: 'image/png' }, Limits))).toEqual({ code: 'PLATFORM', message: 'sips 退出码 1' })
    expect(calls).toBe(1)

    await writeFile(join(root, 'big.png'), pngImage(4000, 3000))
    await writeFile(join(root, 'shot.png'), pngImage(40, 30))
    const space = imageSpace({ root, clamp: true, resize: broken })
    const { files } = await imageOperations.view({ files: [{ path: 'big.png' }, { path: 'shot.png' }] }, space.context)
    expect(files).toEqual([
      { path: 'big.png', error: { code: 'PLATFORM', message: 'sips 退出码 1' } },
      { path: 'shot.png', mediaType: 'image/png', width: 40, height: 30, sent: { width: 40, height: 30 } },
    ])
  })
})

describe('view 的边角', () => {
  test('说明行的写法：第几张、交给模型的路径、原图尺寸、收过边的那一块、实际给出的尺寸', async () => {
    const shot = pngImage(40, 30)
    await writeFile(join(root, 'shot.png'), shot)
    await writeFile(join(root, 'big.png'), pngImage(4000, 3000))
    const space = imageSpace({ root, clamp: true, resize: pngResizer() })
    await imageOperations.view({ files: [{ path: 'shot.png' }, { path: 'big.png', region: { x: 3000.6, y: 2500, width: 2000, height: 2000 } }] }, space.context)
    expect(space.attached.map((image) => image.label)).toEqual([
      '图片 1/2：shot.png（原图 40×30，给你的是 40×30）',
      '图片 2/2：big.png（原图 4000×3000，区域 3000,2500 1000×500，给你的是 1000×500）',
    ])
    expect(space.attached[0]).toEqual({ mediaType: 'image/png', data: shot.toString('base64'), label: '图片 1/2：shot.png（原图 40×30，给你的是 40×30）' })
  })

  test('路径先按平台规整（去掉开头的 @、特殊空格换成普通空格）再交给空间；失败条目照传入的原样', async () => {
    await writeFile(join(root, 'my shot.png'), pngImage(40, 30))
    const space = imageSpace({ root, clamp: true })
    const { files } = await imageOperations.view({ files: [{ path: '@my shot.png' }, { path: '@missing.png' }] }, space.context)
    expect(space.located).toEqual(['my shot.png', 'missing.png'])
    expect(files).toEqual([
      { path: 'my shot.png', mediaType: 'image/png', width: 40, height: 30, sent: { width: 40, height: 30 } },
      { path: '@missing.png', error: { code: 'NOT_FOUND', message: '文件不存在：missing.png' } },
    ])
  })

  test('上限的边：长边多 1 px、base64 多一个字节就请空间压；文件正好 20 MB 照读，多一个字节就不读', async () => {
    await writeFile(join(root, 'wide.png'), pngImage(ImageLimits.edge + 1, 10))
    await writeFile(join(root, 'tall.png'), pngImage(10, ImageLimits.edge + 1))
    await writeFile(join(root, 'heavy.png'), pngImage(10, 10, { bytes: BytesAtBase64Limit + 1 }))
    await writeFile(join(root, 'limit.png'), pngImage(10, 10))
    await truncate(join(root, 'limit.png'), ImageLimits.fileBytes)
    await writeFile(join(root, 'over.png'), pngImage(10, 10))
    await truncate(join(root, 'over.png'), ImageLimits.fileBytes + 1)
    const space = imageSpace({ root, clamp: true, resize: pngResizer() })
    const { files } = await imageOperations.view({ files: ['wide.png', 'tall.png', 'heavy.png', 'limit.png', 'over.png'].map((path) => ({ path })) }, space.context)
    expect(space.resized.map((request) => request.data.length)).toEqual([
      pngImage(ImageLimits.edge + 1, 10).length,
      pngImage(10, ImageLimits.edge + 1).length,
      BytesAtBase64Limit + 1,
      ImageLimits.fileBytes,
    ])
    expect(files.map((file) => ('error' in file ? file.error.code : `${file.sent.width}×${file.sent.height}`))).toEqual([
      `${ImageLimits.edge}×10`,
      `10×${ImageLimits.edge}`,
      '10×10',
      '10×10',
      'VALIDATION',
    ])
  })

  test.skipIf(process.platform === 'win32')('设备文件与命名管道不读，也不会卡住', async () => {
    const pipe = join(root, 'pipe.png')
    expect(spawnSync('mkfifo', [pipe]).status).toBe(0)
    await writeFile(join(root, 'shot.png'), pngImage(40, 30))
    const space = imageSpace({ root })
    const { files } = await imageOperations.view({ files: [{ path: '/dev/null' }, { path: pipe }, { path: 'shot.png' }] }, space.context)
    expect(files.map((file) => ('error' in file ? `${file.error.code} ${file.error.message.includes('不是普通文件')}` : 'ok'))).toEqual(['VALIDATION true', 'VALIDATION true', 'ok'])
  })

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('没有读权限的文件算 PERMISSION', async () => {
    await writeFile(join(root, 'locked.png'), pngImage(40, 30))
    await chmod(join(root, 'locked.png'), 0o000)
    const failure = await failureOf(imageOperations.view({ files: [{ path: 'locked.png' }] }, imageSpace({ root, clamp: true }).context))
    expect(failure.code).toBe('PERMISSION')
    expect(failure.message).toContain('没有权限读')
    expect(failure.message).toContain('locked.png')
  })

  test('入参只留 path 与 region 的四个数；region 给 null 当没给', () => {
    expect(viewItems({ files: [{ path: 'a.png', region: null, note: '多余' }, { path: 'b.png', region: { x: 1, y: 2, width: 3, height: 4, z: 9 } }] })).toEqual([
      { path: 'a.png' },
      { path: 'b.png', region: { x: 1, y: 2, width: 3, height: 4 } },
    ])
  })
})
