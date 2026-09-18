/**
 * 项目空间里的 `velar:images`：共用的看图操作配上项目端口——只看项目里的、项目读取策略许看的图，裁图缩图用宿主给的能力；
 * 图不进返回值，交给代码面的图片通道（宿主另给了通道就用宿主的）。
 */

import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { ImageAttachment, ImageResizeRequest } from '@velaros-ai/velar/images'

import { failureOf, projectSpaceFixture } from './support/space'

/** 1×1 的 PNG。 */
const Pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

/** 头里写着 width×height 的 PNG：看图只读头认尺寸，像素用不着是真的。 */
function pngOfSize(width: number, height: number): Buffer {
  const header = Buffer.from(Pixel)
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return header
}

let root = ''
let outside = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-images-'))
  outside = await mkdtemp(join(tmpdir(), 'project-images-outside-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('项目空间的 velar:images', () => {
  test('看项目里的图：图交给代码面的图片通道，返回值里只有尺寸', async () => {
    await writeFile(join(root, 'img.png'), Pixel)
    const { call, attachments } = await projectSpaceFixture({ root })
    const result = await call('images', 'view', { files: [{ path: 'img.png' }] })
    expect(result).toEqual({ files: [{ path: 'img.png', mediaType: 'image/png', width: 1, height: 1, sent: { width: 1, height: 1 } }] })
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({ type: 'image-data', mediaType: 'image/png', data: Pixel.toString('base64') })
    expect(attachments[0]!.label).toContain('img.png')
  })

  test('宿主给了自己的看图通道就交给宿主，不再走代码面的图片通道', async () => {
    await writeFile(join(root, 'img.png'), Pixel)
    const shown: ImageAttachment[] = []
    const { call, attachments } = await projectSpaceFixture({ root, attachImage: (image) => shown.push(image) })
    await call('images', 'view', { files: [{ path: join(root, 'img.png') }] })
    expect(shown).toHaveLength(1)
    expect(shown[0]!.data).toBe(Pixel.toString('base64'))
    expect(attachments).toEqual([])
  })

  test('出了项目（含经符号链接）、读取策略不许读的图看不了；一批里只有那几张失败，全失败才整个报错', async () => {
    await writeFile(join(root, 'img.png'), Pixel)
    await writeFile(join(root, 'secret.png'), Pixel)
    await writeFile(join(outside, 'far.png'), Pixel)
    await symlink(join(outside, 'far.png'), join(root, 'link.png'))
    const { call, attachments } = await projectSpaceFixture({ root, corePolicy: { readDeny: ['secret.png'] } })
    const result = await call('images', 'view', { files: [
      { path: 'img.png' }, { path: join(outside, 'far.png') }, { path: 'link.png' }, { path: 'secret.png' }, { path: 'missing.png' },
    ] })
    expect(result.files[0]).toMatchObject({ path: 'img.png', width: 1 })
    expect(result.files.slice(1).map((file: { path: string; error?: { code: string } }) => [file.path, file.error?.code])).toEqual([
      [join(outside, 'far.png'), 'PERMISSION'],
      ['link.png', 'PERMISSION'],
      ['secret.png', 'PERMISSION'],
      ['missing.png', 'NOT_FOUND'],
    ])
    expect(attachments).toHaveLength(1)
    const denied = await failureOf(call('images', 'view', { files: [{ path: 'secret.png' }] }))
    expect(denied.code).toBe('PERMISSION')
  })

  test('超出上限的图由宿主来缩；宿主缩不了就明说，不交一张超限的图', async () => {
    await writeFile(join(root, 'wide.png'), pngOfSize(3000, 100))
    const bare = await projectSpaceFixture({ root })
    const unsupported = await failureOf(bare.call('images', 'view', { files: [{ path: 'wide.png' }] }))
    expect(unsupported.code).toBe('PLATFORM')
    expect(unsupported.message).toContain('3000×100')
    expect(bare.attachments).toEqual([])

    const requests: ImageResizeRequest[] = []
    const { call, attachments } = await projectSpaceFixture({
      root,
      resizeImage: async (request) => {
        requests.push(request)
        return { data: Pixel, mediaType: 'image/png', width: 2000, height: 67 }
      },
    })
    const result = await call('images', 'view', { files: [{ path: 'wide.png' }] })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ mediaType: 'image/png', longEdge: 2000 })
    expect(result.files[0]).toMatchObject({ width: 3000, height: 100, sent: { width: 2000, height: 67 } })
    expect(attachments).toHaveLength(1)
  })
})
