/**
 * 看图能力的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 * 空间端口用 `spec/support.ts` 的真磁盘端口：作用域、缩图口子、交图通道都能按用例换；本机看图端口（`./local` 入口）用真端口、真 sips 测（INV-15）。
 */

import { readFileSync } from 'node:fs'
import { mkdir, symlink, truncate, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { VelarImagesModule } from '../contract/surface'
import type { ImageAttachment, ImageOperationContext, ImageSpacePort } from '../index'
import { ImageLimits, imageOperations } from '../index'
import { createLocalImagePort } from '../local'

import {
  failureOf,
  gifImage,
  ImageDeclarations,
  imageSpace,
  jpegImage,
  makeScratch,
  pngImage,
  pngResizer,
  removeScratch,
  runModelProgram,
  solidPng,
  typecheckTemplate,
  webpImage,
} from './support'

/** 一个不该被调的缩放器：在上限以内的图要是请了它，用例当场失败。 */
const untouchable = async (): Promise<never> => {
  throw new Error('在上限以内的图不该请空间缩')
}

/** base64 之后正好压在上限上的原文件字节数：每 3 字节变 4 个字符。 */
const BytesAtBase64Limit = (ImageLimits.base64Bytes / 4) * 3

let root = ''
beforeEach(async () => {
  root = await makeScratch()
})
afterEach(async () => {
  await removeScratch(root)
})

describe('原样交出，超了才压、要了才裁', () => {
  test('INV-1 在上限以内的图原样交出、字节不动，缩放器一次都不调', async () => {
    const photo = pngImage(800, 600)
    await writeFile(join(root, 'photo.png'), photo)
    const space = imageSpace({ root, resize: untouchable })
    const result = await imageOperations.view({ files: [{ path: 'photo.png' }] }, space.context)
    expect(result.files).toEqual([
      {
        path: join(root, 'photo.png'),
        mediaType: 'image/png',
        width: 800,
        height: 600,
        sent: { width: 800, height: 600 },
      },
    ])
    expect(space.resized).toHaveLength(0)
    expect(space.attached).toHaveLength(1)
    expect(space.attached[0]!.mediaType).toBe('image/png')
    expect(Buffer.from(space.attached[0]!.data, 'base64').equals(photo)).toBe(true)
  })

  test('INV-1 压线的也在上限以内：长边正好 2000 px（横竖都算）、base64 之后正好 5 MB，都原样交出', async () => {
    const images = [
      pngImage(ImageLimits.edge, 10),
      pngImage(10, ImageLimits.edge),
      pngImage(10, 10, { bytes: BytesAtBase64Limit }),
    ]
    const names = ['wide.png', 'tall.png', 'heavy.png']
    for (const [index, name] of names.entries()) await writeFile(join(root, name), images[index]!)
    const space = imageSpace({ root, resize: untouchable })
    const result = await imageOperations.view(
      { files: names.map((path) => ({ path })) },
      space.context
    )
    expect(
      result.files.map((file) =>
        'error' in file ? file.error.message : `${file.sent.width}×${file.sent.height}`
      )
    ).toEqual([`${ImageLimits.edge}×10`, `10×${ImageLimits.edge}`, '10×10'])
    expect(space.resized).toHaveLength(0)
    expect(
      space.attached.map((image, index) => Buffer.from(image.data, 'base64').equals(images[index]!))
    ).toEqual([true, true, true])
    expect(space.attached[2]!.data.length).toBe(ImageLimits.base64Bytes)
  })

  test('INV-2 长边超了才请空间压：交给空间的是原字节、长边 2000；给出的尺寸与格式以空间交回的为准', async () => {
    const wide = pngImage(ImageLimits.edge + 1, 300)
    const banner = gifImage(2400, 600)
    await writeFile(join(root, 'wide.png'), wide)
    await writeFile(join(root, 'banner.gif'), banner)
    const space = imageSpace({ root, resize: pngResizer() })
    const result = await imageOperations.view(
      { files: [{ path: 'wide.png' }, { path: 'banner.gif' }] },
      space.context
    )
    expect(
      space.resized.map((request) => [request.mediaType, request.longEdge, request.region])
    ).toEqual([
      ['image/png', ImageLimits.edge, undefined],
      ['image/gif', ImageLimits.edge, undefined],
    ])
    expect(space.resized[0]!.data.equals(wide)).toBe(true)
    expect(space.resized[1]!.data.equals(banner)).toBe(true)
    // 宽高是原图的，sent 是空间实际交回的；GIF 被空间转成了 PNG，条目与交出的图都跟着改
    expect(result.files).toEqual([
      {
        path: join(root, 'wide.png'),
        mediaType: 'image/png',
        width: ImageLimits.edge + 1,
        height: 300,
        sent: { width: ImageLimits.edge, height: 300 },
      },
      {
        path: join(root, 'banner.gif'),
        mediaType: 'image/png',
        width: 2400,
        height: 600,
        sent: { width: ImageLimits.edge, height: 500 },
      },
    ])
    expect(space.attached.map((image) => image.mediaType)).toEqual(['image/png', 'image/png'])
  })

  test('INV-2 长边没超、base64 之后超了，也请空间压', async () => {
    await writeFile(join(root, 'heavy.png'), pngImage(1200, 900, { bytes: BytesAtBase64Limit + 1 }))
    const space = imageSpace({ root, resize: pngResizer() })
    const result = await imageOperations.view({ files: [{ path: 'heavy.png' }] }, space.context)
    expect(space.resized.map((request) => request.longEdge)).toEqual([ImageLimits.edge])
    expect(result.files[0]).toMatchObject({
      width: 1200,
      height: 900,
      sent: { width: 1200, height: 900 },
    })
    expect(space.attached[0]!.data.length).toBeLessThanOrEqual(ImageLimits.base64Bytes)
  })

  test('INV-2 空间压完 base64 还超，就把长边再收一截重请；怎么都压不进去就明说换更小的 region', async () => {
    await writeFile(join(root, 'big.png'), pngImage(4000, 3000))
    // 空间头一次（长边 2000）交回的还超上限，收一截之后才压得进去
    const space = imageSpace({
      root,
      resize: pngResizer({ bloat: (request) => request.longEdge >= ImageLimits.edge }),
    })
    const result = await imageOperations.view({ files: [{ path: 'big.png' }] }, space.context)
    const [first, second] = space.resized.map((request) => request.longEdge)
    expect(space.resized).toHaveLength(2)
    expect(first).toBe(ImageLimits.edge)
    expect(second).toBeLessThan(ImageLimits.edge)
    expect(result.files[0]).toMatchObject({
      width: 4000,
      height: 3000,
      sent: { width: second, height: Math.round(second! * 0.75) },
    })
    expect(space.attached).toHaveLength(1)
    expect(space.attached[0]!.data.length).toBeLessThanOrEqual(ImageLimits.base64Bytes)

    const hopeless = imageSpace({ root, resize: pngResizer({ bloat: () => true }) })
    const failure = await failureOf(
      imageOperations.view({ files: [{ path: 'big.png' }] }, hopeless.context)
    )
    expect(failure.code).toBe('VALIDATION')
    expect(failure.message).toContain('换一块更小的 region')
    expect(hopeless.resized.length).toBeGreaterThan(1)
    expect(hopeless.attached).toHaveLength(0)
  })

  test('INV-3 要了 region 才请空间裁：按原图像素算，超出图的部分收进图里；在上限以内的图也照裁', async () => {
    await writeFile(join(root, 'big.png'), pngImage(4000, 3000))
    await writeFile(join(root, 'small.png'), pngImage(800, 600))
    const space = imageSpace({ root, resize: pngResizer() })
    const zoomed = await imageOperations.view(
      { files: [{ path: 'big.png', region: { x: 3000, y: 0, width: 5000, height: 500 } }] },
      space.context
    )
    // x 从 3000 起，图只到 4000：宽收成 1000
    expect(space.resized[0]).toMatchObject({
      region: { x: 3000, y: 0, width: 1000, height: 500 },
      longEdge: ImageLimits.edge,
    })
    expect(zoomed.files[0]).toMatchObject({
      width: 4000,
      height: 3000,
      sent: { width: 1000, height: 500 },
    })
    const corner = await imageOperations.view(
      { files: [{ path: 'small.png', region: { x: 400, y: 300, width: 400, height: 300 } }] },
      space.context
    )
    expect(space.resized[1]).toMatchObject({ region: { x: 400, y: 300, width: 400, height: 300 } })
    expect(corner.files[0]).toMatchObject({
      width: 800,
      height: 600,
      sent: { width: 400, height: 300 },
    })
  })

  test('INV-3 region 整块在图外直接拒，不请空间；空间裁不了图也是这个说法，错的是 region', async () => {
    await writeFile(join(root, 'big.png'), pngImage(4000, 3000))
    const space = imageSpace({ root, resize: pngResizer() })
    const blunt = imageSpace({ root })
    for (const region of [
      { x: 4000, y: 0, width: 10, height: 10 },
      { x: 0, y: 3000, width: 10, height: 10 },
      { x: 5000, y: 5000, width: 100, height: 100 },
    ]) {
      for (const context of [space.context, blunt.context]) {
        const failure = await failureOf(
          imageOperations.view({ files: [{ path: 'big.png', region }] }, context)
        )
        expect({
          region,
          code: failure.code,
          outside: failure.message.includes('整块都在图外'),
        }).toEqual({ region, code: 'VALIDATION', outside: true })
      }
    }
    expect(space.resized).toHaveLength(0)
    expect(space.attached).toHaveLength(0)
  })
})

describe('交给模型的只有尺寸', () => {
  test('INV-4 结果里只有尺寸没有像素；图经交图通道按批里的顺序交出，每张前面一行说明，失败的那张不交', async () => {
    const shot = pngImage(40, 30)
    await writeFile(join(root, 'shot.png'), shot)
    await writeFile(join(root, 'big.png'), pngImage(4000, 3000))
    const space = imageSpace({ root, clamp: true, resize: pngResizer() })
    const result = await imageOperations.view(
      {
        files: [
          { path: 'shot.png' },
          { path: 'missing.png' },
          { path: 'big.png', region: { x: 2000, y: 1000, width: 1000, height: 500 } },
          { path: 'big.png' },
        ],
      },
      space.context
    )
    expect(
      result.files.map((file) =>
        'error' in file
          ? file.error.code
          : `${file.width}×${file.height} → ${file.sent.width}×${file.sent.height}`
      )
    ).toEqual(['40×30 → 40×30', 'NOT_FOUND', '4000×3000 → 1000×500', '4000×3000 → 2000×1500'])
    // 成功的条目就这五样：交给模型的路径、格式、原图宽高、实际给出的宽高
    for (const file of result.files.filter((entry) => !('error' in entry)))
      expect(Object.keys(file).sort()).toEqual(['height', 'mediaType', 'path', 'sent', 'width'])

    // 像素只走交图通道：三张按顺序交出，失败的那张没有
    expect(space.attached).toHaveLength(3)
    const [first, zoomed, whole] = space.attached
    expect(Buffer.from(first!.data, 'base64').equals(shot)).toBe(true)
    expect(
      [first!.label, zoomed!.label, whole!.label].map((label) =>
        label.slice(0, label.indexOf('：'))
      )
    ).toEqual(['图片 1/4', '图片 3/4', '图片 4/4'])
    for (const expected of ['shot.png', '原图 40×30', '给你的是 40×30'])
      expect(first!.label).toContain(expected)
    for (const expected of [
      'big.png',
      '原图 4000×3000',
      '区域 2000,1000 1000×500',
      '给你的是 1000×500',
    ])
      expect(zoomed!.label).toContain(expected)
    expect(whole!.label).toContain('给你的是 2000×1500')
    const serialized = JSON.stringify(result)
    for (const image of space.attached) {
      expect(image.data.length).toBeLessThanOrEqual(ImageLimits.base64Bytes)
      expect(serialized).not.toContain(image.data.slice(0, 64))
    }
  })

  test('INV-5 空间压不了、裁不了就明说并给出命令，不悄悄交一张超限的图', async () => {
    await writeFile(join(root, 'wide.png'), pngImage(3000, 2000))
    await writeFile(join(root, 'heavy.png'), pngImage(100, 100, { bytes: BytesAtBase64Limit + 1 }))
    await writeFile(join(root, 'small.png'), pngImage(800, 600))
    const space = imageSpace({ root })
    const oversize = await failureOf(
      imageOperations.view({ files: [{ path: 'wide.png' }] }, space.context)
    )
    expect(oversize.code).toBe('PLATFORM')
    for (const expected of [
      '3000×2000',
      `sips -Z ${ImageLimits.edge}`,
      `-resize ${ImageLimits.edge}x${ImageLimits.edge}`,
    ])
      expect(oversize.message).toContain(expected)
    // 长边没超、字节超了，一样压不了
    expect(
      (await failureOf(imageOperations.view({ files: [{ path: 'heavy.png' }] }, space.context)))
        .code
    ).toBe('PLATFORM')
    const crop = await failureOf(
      imageOperations.view(
        { files: [{ path: 'small.png', region: { x: 0, y: 0, width: 100, height: 100 } }] },
        space.context
      )
    )
    expect(crop.code).toBe('PLATFORM')
    expect(crop.message).toContain('先用命令把那一块裁出来')
    expect(space.attached).toHaveLength(0)
  })

  test('INV-5 宿主没有交图通道时 view 整个不可用，一个文件都不读', async () => {
    await writeFile(join(root, 'small.png'), pngImage(800, 600))
    const space = imageSpace({ root, attach: false, resize: pngResizer() })
    const failure = await failureOf(
      imageOperations.view({ files: [{ path: 'small.png' }] }, space.context)
    )
    expect(failure.code).toBe('PLATFORM')
    expect(failure.message).toContain('没有把图交给模型的通道')
    expect(space.located).toHaveLength(0)
    expect(space.resized).toHaveLength(0)
  })
})

describe('一批各算各的，作用域由空间定', () => {
  test('INV-6 某张看不了只有它那一项失败、path 照传入的原样，其余照常；码是通用的那一套', async () => {
    await writeFile(join(root, 'shot.png'), pngImage(40, 30))
    await writeFile(join(root, 'wide.png'), pngImage(3000, 200))
    await writeFile(join(root, 'notes.txt'), '不是图\n')
    const space = imageSpace({ root, clamp: true })
    const batch = await imageOperations.view(
      {
        files: [
          { path: './missing.png' },
          { path: '../elsewhere.png' },
          { path: 'notes.txt' },
          { path: 'wide.png' },
          { path: './shot.png' },
        ],
      },
      space.context
    )
    expect(batch.files).toEqual([
      {
        path: './missing.png',
        error: { code: 'NOT_FOUND', message: expect.stringContaining('missing.png') },
      },
      { path: '../elsewhere.png', error: { code: 'PERMISSION', message: expect.any(String) } },
      { path: 'notes.txt', error: { code: 'VALIDATION', message: expect.any(String) } },
      { path: 'wide.png', error: { code: 'PLATFORM', message: expect.any(String) } },
      {
        path: 'shot.png',
        mediaType: 'image/png',
        width: 40,
        height: 30,
        sent: { width: 40, height: 30 },
      },
    ])
    expect(space.attached).toHaveLength(1)
  })

  test('INV-6 全部失败时整个调用抛出第一个失败', async () => {
    await writeFile(join(root, 'notes.txt'), '不是图\n')
    const space = imageSpace({ root, clamp: true })
    const missingFirst = await failureOf(
      imageOperations.view(
        { files: [{ path: 'missing.png' }, { path: 'notes.txt' }] },
        space.context
      )
    )
    expect(missingFirst.code).toBe('NOT_FOUND')
    expect(missingFirst.message).toContain('missing.png')
    const textFirst = await failureOf(
      imageOperations.view(
        { files: [{ path: 'notes.txt' }, { path: 'missing.png' }] },
        space.context
      )
    )
    expect(textFirst.code).toBe('VALIDATION')
    expect(textFirst.message).toContain('notes.txt')
  })

  test('INV-7 越出空间范围的那一张 PERMISSION（经符号链接指出去也算），其余照常；全部越界整个调用报 PERMISSION', async () => {
    const outside = await makeScratch()
    try {
      await writeFile(join(outside, 'x.png'), pngImage(10, 10))
      await symlink(join(outside, 'x.png'), join(root, 'escape.png'))
      await writeFile(join(root, 'in.png'), pngImage(20, 10))
      const space = imageSpace({ root, clamp: true })
      const result = await imageOperations.view(
        { files: [{ path: join(outside, 'x.png') }, { path: 'escape.png' }, { path: 'in.png' }] },
        space.context
      )
      expect(result.files).toEqual([
        {
          path: join(outside, 'x.png'),
          error: { code: 'PERMISSION', message: expect.any(String) },
        },
        { path: 'escape.png', error: { code: 'PERMISSION', message: expect.any(String) } },
        {
          path: 'in.png',
          mediaType: 'image/png',
          width: 20,
          height: 10,
          sent: { width: 20, height: 10 },
        },
      ])
      expect(space.attached).toHaveLength(1)
      expect(
        (await failureOf(imageOperations.view({ files: [{ path: '../x.png' }] }, space.context)))
          .code
      ).toBe('PERMISSION')

      // 同一张图，换一个收本机任意位置的空间就看得到：范围是空间定的，不是操作定的
      const anywhere = imageSpace({ root })
      const seen = await imageOperations.view(
        { files: [{ path: join(outside, 'x.png') }] },
        anywhere.context
      )
      expect(seen.files[0]).toMatchObject({ path: join(outside, 'x.png'), width: 10, height: 10 })
    } finally {
      await removeScratch(outside)
    }
  })

  test('INV-7 读的是空间交回的真实文件，交给模型的写法也用空间给的', async () => {
    const real = pngImage(30, 20)
    await writeFile(join(root, 'real.png'), real)
    // 模型给的路径上也有一张图：读了它就说明操作绕过了空间
    const decoy = join(root, 'decoy.png')
    await writeFile(decoy, pngImage(99, 99))
    const asked: string[] = []
    const port: ImageSpacePort = {
      locate: async (path) => {
        asked.push(path)
        return { target: join(root, 'real.png'), shown: '画布/当前.png' }
      },
    }
    const attached: ImageAttachment[] = []
    const context: ImageOperationContext = {
      abortSignal: new AbortController().signal,
      images: port,
      attachImage: (image) => attached.push(image),
    }
    const result = await imageOperations.view({ files: [{ path: decoy }] }, context)
    expect(asked).toEqual([decoy])
    expect(result.files).toEqual([
      {
        path: '画布/当前.png',
        mediaType: 'image/png',
        width: 30,
        height: 20,
        sent: { width: 30, height: 20 },
      },
    ])
    expect(Buffer.from(attached[0]!.data, 'base64').equals(real)).toBe(true)
    expect(attached[0]!.label).toContain('画布/当前.png')
  })
})

describe('入参与格式', () => {
  test('INV-8 形状不对一律 VALIDATION，一张都不看', async () => {
    await writeFile(join(root, 'shot.png'), pngImage(40, 30))
    const space = imageSpace({ root, resize: pngResizer() })
    const shot = { path: 'shot.png' }
    const tooMany = Array.from({ length: ImageLimits.viewFiles + 1 }, () => shot)
    const region = (value: unknown) => ({ files: [shot, { path: 'shot.png', region: value }] })
    const inputs: unknown[] = [
      undefined,
      null,
      'shot.png',
      42,
      [shot],
      {},
      { files: '不是数组' },
      { files: shot },
      { files: [] },
      { files: tooMany },
      { files: ['shot.png'] },
      { files: [null] },
      { files: [{}] },
      { files: [{ path: 3 }] },
      { files: [{ path: '' }] },
      { files: [{ path: '   ' }] },
      region('右上角'),
      region([0, 0, 10, 10]),
      region({ x: 0, y: 0, width: 10 }),
      region({ x: 0, y: 0, width: 0, height: 10 }),
      region({ x: 0, y: 0, width: 10, height: -1 }),
      region({ x: Number.NaN, y: 0, width: 10, height: 10 }),
      region({ x: 0, y: Number.POSITIVE_INFINITY, width: 10, height: 10 }),
      region({ x: '0', y: 0, width: 10, height: 10 }),
    ]
    for (const input of inputs) {
      const failure = await failureOf(imageOperations.view(input as never, space.context))
      expect({ input, code: failure.code }).toEqual({ input, code: 'VALIDATION' })
    }
    expect(space.located).toHaveLength(0)
    expect(space.resized).toHaveLength(0)
    expect(space.attached).toHaveLength(0)
    // 正好 10 张不算多；多一张就拒，说明写着上限
    const full = await imageOperations.view(
      { files: Array.from({ length: ImageLimits.viewFiles }, () => shot) },
      space.context
    )
    expect(full.files).toHaveLength(ImageLimits.viewFiles)
    expect(
      (await failureOf(imageOperations.view({ files: tooMany }, space.context))).message
    ).toContain(`最多 ${ImageLimits.viewFiles} 张`)
  })

  test('INV-9 PNG、JPEG、GIF、WebP 按文件头认、不看扩展名，原样交出', async () => {
    const images: Array<[string, Buffer]> = [
      ['shot.png', pngImage(64, 48)],
      ['photo.jpg', jpegImage(640, 480)],
      ['anim.gif', gifImage(320, 240)],
      ['lossy.webp', webpImage(300, 200, 'VP8 ')],
      ['lossless.webp', webpImage(301, 201, 'VP8L')],
      ['extended.webp', webpImage(302, 202, 'VP8X')],
      // 名字是 jpg，内容是 PNG：按内容认
      ['misnamed.jpg', pngImage(10, 20)],
    ]
    for (const [name, bytes] of images) await writeFile(join(root, name), bytes)
    const space = imageSpace({ root, clamp: true, resize: untouchable })
    const { files } = await imageOperations.view(
      { files: images.map(([path]) => ({ path })) },
      space.context
    )
    expect(
      files.map((file) =>
        'error' in file
          ? file.error.message
          : `${file.path} ${file.mediaType} ${file.width}×${file.height}`
      )
    ).toEqual([
      'shot.png image/png 64×48',
      'photo.jpg image/jpeg 640×480',
      'anim.gif image/gif 320×240',
      'lossy.webp image/webp 300×200',
      'lossless.webp image/webp 301×201',
      'extended.webp image/webp 302×202',
      'misnamed.jpg image/png 10×20',
    ])
    expect(space.attached.map((image) => image.mediaType)).toEqual([
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/webp',
      'image/webp',
      'image/png',
    ])
    expect(
      space.attached.map((image, index) =>
        Buffer.from(image.data, 'base64').equals(images[index]![1])
      )
    ).toEqual(images.map(() => true))
  })

  test('INV-9 PDF、文本与别的格式都只算那一张失败并说清楚该怎么办；头读不出来的算坏文件', async () => {
    const others: Array<[string, Buffer]> = [
      ['report.pdf', Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1')],
      ['notes.txt', Buffer.from('这是一段文字\n')],
      ['fake.png', Buffer.from('名字像图，内容是字\n')],
      [
        'photo.heic',
        Buffer.concat([
          Buffer.from([0, 0, 0, 0x18]),
          Buffer.from('ftypheic', 'ascii'),
          Buffer.alloc(12),
        ]),
      ],
      ['scan.tiff', Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(12)])],
      ['broken.png', pngImage(40, 30).subarray(0, 16)],
    ]
    for (const [name, bytes] of others) await writeFile(join(root, name), bytes)
    await writeFile(join(root, 'shot.png'), pngImage(40, 30))
    const space = imageSpace({ root, clamp: true })
    const { files } = await imageOperations.view(
      { files: [...others.map(([path]) => ({ path })), { path: 'shot.png' }] },
      space.context
    )
    const failures = files.flatMap((file) => ('error' in file ? [file.error] : []))
    expect(failures.map((failure) => failure.code)).toEqual(others.map(() => 'VALIDATION'))
    const [pdf, text, fake, heic, tiff, broken] = failures.map((failure) => failure.message)
    expect(pdf).toContain('是 PDF')
    expect(pdf).toContain('view 只看图片')
    for (const message of [text, fake, heic, tiff]) {
      expect(message).toContain('PNG、JPEG、GIF、WebP')
      expect(message).toContain('文本文件用读文件的能力读')
      expect(message).toContain('别的格式先转换')
    }
    expect(broken).toContain('图片头读不出宽高')
    expect(space.attached).toHaveLength(1)
  })

  test('INV-9 目录与超过 20 MB 的文件也只算那一张失败', async () => {
    await mkdir(join(root, 'album'))
    await writeFile(join(root, 'huge.png'), pngImage(10, 10))
    await truncate(join(root, 'huge.png'), ImageLimits.fileBytes + 1)
    await writeFile(join(root, 'shot.png'), pngImage(40, 30))
    const space = imageSpace({ root, clamp: true, resize: pngResizer() })
    const { files } = await imageOperations.view(
      { files: [{ path: 'album' }, { path: 'huge.png' }, { path: 'shot.png' }] },
      space.context
    )
    expect(
      files.map((file) =>
        'error' in file ? [file.path, file.error.code] : [file.path, `${file.width}×${file.height}`]
      )
    ).toEqual([
      ['album', 'VALIDATION'],
      ['huge.png', 'VALIDATION'],
      ['shot.png', '40×30'],
    ])
    const [album, huge] = files.flatMap((file) => ('error' in file ? [file.error.message] : []))
    expect(album).toContain('路径是目录')
    expect(huge).toContain('图片文件太大')
    expect(huge).toContain('先用命令缩小')
    // 太大的文件在读之前就拦下，不会整份读进来再请空间压
    expect(space.resized).toHaveLength(0)
  })

  test('INV-10 取消信号在每张图之间核对：取消之后后面的图不再定位、不再交出，整个调用抛出取消原因', async () => {
    for (const name of ['a.png', 'b.png', 'c.png'])
      await writeFile(join(root, name), pngImage(40, 30))
    const early = new AbortController()
    early.abort(new AppError('ABORTED', '用户没等它开始就停了'))
    const idle = imageSpace({ root, abortSignal: early.signal })
    expect(
      await failureOf(imageOperations.view({ files: [{ path: 'a.png' }] }, idle.context))
    ).toEqual({ code: 'ABORTED', message: '用户没等它开始就停了' })
    expect(idle.located).toHaveLength(0)

    // 看第一张的时候用户停了：第一张照常收尾，后面两张不再碰
    const midway = new AbortController()
    const space = imageSpace({ root, abortSignal: midway.signal })
    const locate = space.port.locate
    space.port.locate = async (path) => {
      const location = await locate(path)
      midway.abort(new AppError('ABORTED', '用户中途停了'))
      return location
    }
    const failure = await failureOf(
      imageOperations.view(
        { files: [{ path: 'a.png' }, { path: 'b.png' }, { path: 'c.png' }] },
        space.context
      )
    )
    expect(failure).toEqual({ code: 'ABORTED', message: '用户中途停了' })
    expect(space.located).toEqual(['a.png'])
    expect(space.attached.every((image) => image.label.includes('a.png'))).toBe(true)
  })
})

describe('代码面 images 命名空间', () => {
  test('INV-11 模型写的程序照生成的声明调到真实操作：图走代码面的图片通道，程序只拿到尺寸', async () => {
    const shot = pngImage(40, 30)
    await writeFile(join(root, 'shot.png'), shot)
    await writeFile(join(root, 'big.png'), pngImage(4000, 3000))
    const space = imageSpace({ root, clamp: true, resize: pngResizer() })
    const { result, attachments } = await runModelProgram(
      space,
      `import { view } from 'velaros:images'

const { files } = await view({ files: [{ path: 'shot.png' }, { path: 'missing.png' }, { path: 'big.png', region: { x: 0, y: 0, width: 2000, height: 1500 } }] })
export default files.map((f) => ('error' in f ? { path: f.path, code: f.error.code } : { path: f.path, size: \`\${f.width}×\${f.height}\`, sent: \`\${f.sent.width}×\${f.sent.height}\` }))`
    )
    expect(result.failed).toBeUndefined()
    expect(result.value).toEqual([
      { path: 'shot.png', size: '40×30', sent: '40×30' },
      { path: 'missing.png', code: 'NOT_FOUND' },
      { path: 'big.png', size: '4000×3000', sent: '2000×1500' },
    ])
    // 图跟在结果旁边回去，是真正的图；程序的结果里没有它的一个字节
    expect(attachments.map((attachment) => [attachment.type, attachment.mediaType])).toEqual([
      ['image-data', 'image/png'],
      ['image-data', 'image/png'],
    ])
    expect(attachments[0]!.data).toBe(shot.toString('base64'))
    expect(attachments[0]!.label).toContain('shot.png')
    const serialized = JSON.stringify(result)
    for (const attachment of attachments)
      expect(serialized).not.toContain(attachment.data.slice(0, 64))
  }, 60_000)

  test('INV-11 读像素的写法读不到东西：结果上根本没有这一格', async () => {
    await writeFile(join(root, 'shot.png'), pngImage(40, 30))
    const { result } = await runModelProgram(
      imageSpace({ root, clamp: true }),
      `import { view } from 'velaros:images'

const [image] = (await view({ files: [{ path: 'shot.png' }] })).files
export default 'error' in image ? null : (image.data ?? '没有像素')`
    )
    expect(result.failed).toBeUndefined()
    expect(result.value).toBe('没有像素')
  }, 60_000)

  test('INV-11 全部失败时程序接得住：看得见的就是 error.code 与 error.message', async () => {
    const space = imageSpace({ root, clamp: true })
    const { result, attachments } = await runModelProgram(
      space,
      `import { view } from 'velaros:images'

let outcome
try {
  await view({ files: [{ path: '../outside.png' }] })
  outcome = '没拦住'
} catch (error) {
  outcome = { code: error.code, message: error.message }
}
export default outcome`
    )
    expect(result.value).toEqual({
      code: 'PERMISSION',
      message: '../outside.png 在这个空间之外，只能看空间里的图',
    })
    expect(attachments).toHaveLength(0)
  }, 60_000)
})

describe('模型面', () => {
  test('INV-12 代码模版整份照真实声明过类型检查；它不嵌进声明，随模型面发布的就是这份文件', () => {
    const template = readFileSync(fileURLToPath(new URL('../template.js', import.meta.url)), 'utf8')
    expect(typecheckTemplate(template)).toEqual([])
    expect(template.match(/^import /gmu)).toHaveLength(1)
    expect(VelarImagesModule.template).toBe(template.replace(/\r\n/g, '\n').trim())
    expect(ImageDeclarations).not.toContain('的代码模版')
  })

  test('INV-13 声明里写的张数、长边、体积上限都与常量表一致；view 只有一个入参', () => {
    expect(ImageDeclarations).toContain(`最多 ${ImageLimits.viewFiles} 张`)
    expect(ImageDeclarations).toContain(`长边 ${ImageLimits.edge} px`)
    expect(ImageDeclarations).toContain(`base64 后 ${ImageLimits.base64Bytes / 1024 / 1024} MB`)
    // 说明文字里带单位的数字一个都不许漂：每一处都得是常量表里的某个上限（嵌着的代码模版另由 INV-12 守）
    const limitsByUnit: Record<string, number[]> = {
      张: [ImageLimits.viewFiles],
      px: [ImageLimits.edge],
      MB: [ImageLimits.base64Bytes / 1024 / 1024, ImageLimits.fileBytes / 1024 / 1024],
    }
    const prose = ImageDeclarations.replace(/```js[\s\S]*?```/u, '')
    const mentioned = [...prose.matchAll(/(\d+)\s*(张|px|MB)/gu)].map((match) => ({
      unit: match[2]!,
      value: Number(match[1]),
    }))
    expect(mentioned.length).toBeGreaterThanOrEqual(3)
    for (const { unit, value } of mentioned)
      expect({ unit, value, isLimit: limitsByUnit[unit]!.includes(value) }).toEqual({
        unit,
        value,
        isLimit: true,
      })
    expect(
      [...ImageDeclarations.matchAll(/export function (\w+)\(([^)]*)\)/gu)].map((match) => [
        match[1],
        match[2],
      ])
    ).toEqual([['view', 'input: ImageViewInput']])
  })

  test('INV-13 空间端口、调用上下文、缩图与交图的口子都不进模型面', () => {
    const hidden = [
      'ImageSpacePort',
      'ImageOperationContext',
      'ImageAttachment',
      'ImageLocation',
      'ImageResizeRequest',
      'ImageResizeResult',
      'ImageMediaType',
      'ImageViewed',
      'locate',
      'resizeImage',
      'attachImage',
      'abortSignal',
      'longEdge',
      'AbortSignal',
      'Buffer',
    ]
    for (const name of hidden)
      expect({ name, shown: ImageDeclarations.includes(name) }).toEqual({ name, shown: false })
  })
})

/** 本机看图端口（`./local` 入口）接成系统空间那样的上下文：相对路径相对用例的临时目录，按给的平台决定有没有缩图口子；交出的图都记下来。 */
function localImageSpace(platform: NodeJS.Platform) {
  const attached: ImageAttachment[] = []
  const port = createLocalImagePort({ resolvePath: (path) => resolve(root, path), platform })
  const context: ImageOperationContext = {
    abortSignal: new AbortController().signal,
    images: port,
    attachImage: (image) => attached.push(image),
  }
  return { port, context, attached }
}

/** 交出的 PNG 真正的宽高：从它自己的 IHDR 里读，不信谁报的数。 */
function pngSizeOf(image: ImageAttachment): { width: number; height: number } {
  const bytes = Buffer.from(image.data, 'base64')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('本机看图端口', () => {
  test('INV-15 只有 macOS 给缩图口子，别的平台不给：超限的图照样明说做不了（PLATFORM），不交一张超限的图', async () => {
    expect(localImageSpace('darwin').port.resizeImage).toBeFunction()
    for (const platform of ['linux', 'win32'] as const)
      expect(localImageSpace(platform).port.resizeImage).toBeUndefined()
    await writeFile(join(root, 'wide.png'), pngImage(3000, 2000))
    const space = localImageSpace('linux')
    expect(
      (await failureOf(imageOperations.view({ files: [{ path: 'wide.png' }] }, space.context))).code
    ).toBe('PLATFORM')
    expect(space.attached).toEqual([])
  })

  test.skipIf(process.platform !== 'darwin')(
    'INV-15 macOS 上用 sips 真压、真裁：超长边的图压到上限以内，裁出来的一块不被放大，又裁又缩的先裁后缩',
    async () => {
      await writeFile(join(root, 'wide.png'), solidPng(3000, 2000))
      const space = localImageSpace('darwin')
      const whole = await imageOperations.view({ files: [{ path: 'wide.png' }] }, space.context)
      expect(whole.files).toMatchObject([
        {
          path: join(root, 'wide.png'),
          width: 3000,
          height: 2000,
          sent: { width: 2000, height: 1333 },
        },
      ])
      expect(space.attached[0]?.mediaType).toBe('image/png')
      expect(pngSizeOf(space.attached[0]!)).toEqual({ width: 2000, height: 1333 })
      // 右半边（纯蓝）裁 1000×800：不超长边，不该被放大。
      const zoomed = await imageOperations.view(
        { files: [{ path: 'wide.png', region: { x: 2000, y: 0, width: 1000, height: 800 } }] },
        space.context
      )
      expect(zoomed.files).toMatchObject([{ sent: { width: 1000, height: 800 } }])
      expect(pngSizeOf(space.attached[1]!)).toEqual({ width: 1000, height: 800 })
      // 又裁又缩：先在原图上裁出 2500×1000，再缩到长边 2000。sips 不管参数怎么排都先缩后裁，一次调完的话这一块会落到图外面去。
      const both = await imageOperations.view(
        { files: [{ path: 'wide.png', region: { x: 500, y: 1000, width: 2500, height: 1000 } }] },
        space.context
      )
      expect(both.files).toMatchObject([{ sent: { width: 2000, height: 800 } }])
      expect(pngSizeOf(space.attached[2]!)).toEqual({ width: 2000, height: 800 })
    },
    60_000
  )
})
