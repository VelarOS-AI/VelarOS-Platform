/**
 * 项目里的 `velaros:images`：共用的看图操作配上 `projectCapabilityPorts.images`——只看项目里的图（经项目内核取真实路径），
 * 裁图缩图用宿主给的口子；图不进返回值，交给代码面的图片通道（宿主另给了通道就用宿主的）。
 */

import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { ImageAttachment, ImageResizeRequest } from '@velaros-ai/velaros/images'

import { createProjectPortsHarness, failureOf } from '../spec/support'

/** 1×1 的 PNG。 */
const Pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

/** 头里写着 width×height 的 PNG：看图只读头认尺寸，像素用不着是真的。 */
function pngOfSize(width: number, height: number): Buffer {
  const header = Buffer.from(Pixel)
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header
}

let root = ''
let outside = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-images-port-'))
  outside = await mkdtemp(join(tmpdir(), 'project-images-port-outside-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('项目里的 velaros:images', () => {
  test('看项目里的图：图交给代码面的图片通道，返回值里只有尺寸', async () => {
    await writeFile(join(root, 'img.png'), Pixel)
    const { call, attachments } = await createProjectPortsHarness(root)
    const result = await call('images', 'view', { files: [{ path: 'img.png' }] })
    expect(result).toEqual({
      files: [
        {
          path: 'img.png',
          mediaType: 'image/png',
          width: 1,
          height: 1,
          sent: { width: 1, height: 1 },
        },
      ],
    })
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      type: 'image-data',
      mediaType: 'image/png',
      data: Pixel.toString('base64'),
    })
    expect(attachments[0]!.label).toContain('img.png')
  })

  test('宿主给了自己的看图通道就交给宿主，不再走代码面的图片通道；项目里的绝对路径交给模型时写成相对项目根', async () => {
    await writeFile(join(root, 'img.png'), Pixel)
    const shown: ImageAttachment[] = []
    const { call, attachments } = await createProjectPortsHarness(root, {
      attachImage: (image) => shown.push(image),
    })
    const result = await call('images', 'view', { files: [{ path: join(root, 'img.png') }] })
    expect(result.files[0]).toMatchObject({ path: 'img.png' })
    expect(shown).toHaveLength(1)
    expect(shown[0]!.data).toBe(Pixel.toString('base64'))
    expect(attachments).toEqual([])
  })

  test('出了项目（含经符号链接）的图看不了，项目里的都看得了；一批里只有那几张失败，全失败才整个报错', async () => {
    await writeFile(join(root, 'img.png'), Pixel)
    await writeFile(join(root, 'secret.png'), Pixel)
    await writeFile(join(outside, 'far.png'), Pixel)
    await symlink(join(outside, 'far.png'), join(root, 'link.png'))
    const { call, attachments } = await createProjectPortsHarness(root)
    const result = await call('images', 'view', {
      files: [
        { path: 'img.png' },
        { path: 'secret.png' },
        { path: join(outside, 'far.png') },
        { path: 'link.png' },
        { path: 'missing.png' },
      ],
    })
    expect(result.files.slice(0, 2)).toMatchObject([
      { path: 'img.png', width: 1 },
      { path: 'secret.png', width: 1 },
    ])
    expect(
      result.files
        .slice(2)
        .map((file: { path: string; error?: { code: string } }) => [file.path, file.error?.code])
    ).toEqual([
      [join(outside, 'far.png'), 'PERMISSION'],
      ['link.png', 'PERMISSION'],
      ['missing.png', 'NOT_FOUND'],
    ])
    expect(attachments).toHaveLength(2)
    const outsideOnly = await failureOf(call('images', 'view', { files: [{ path: 'link.png' }] }))
    expect(outsideOnly.code).toBe('PERMISSION')
  })

  test('超出上限的图由宿主来缩；宿主缩不了就明说，不交一张超限的图', async () => {
    await writeFile(join(root, 'wide.png'), pngOfSize(3000, 100))
    const bare = await createProjectPortsHarness(root)
    const unsupported = await failureOf(
      bare.call('images', 'view', { files: [{ path: 'wide.png' }] })
    )
    expect(unsupported.code).toBe('PLATFORM')
    expect(unsupported.message).toContain('3000×100')
    expect(bare.attachments).toEqual([])

    const requests: ImageResizeRequest[] = []
    const { call, attachments } = await createProjectPortsHarness(root, {
      resizeImage: async (request) => {
        requests.push(request)
        return { data: Pixel, mediaType: 'image/png', width: 2000, height: 67 }
      },
    })
    const result = await call('images', 'view', { files: [{ path: 'wide.png' }] })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ mediaType: 'image/png', longEdge: 2000 })
    expect(result.files[0]).toMatchObject({
      width: 3000,
      height: 100,
      sent: { width: 2000, height: 67 },
    })
    expect(attachments).toHaveLength(1)
  })
})
