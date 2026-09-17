/** 图片：macOS 上用系统自带的 sips 裁图、缩图，本地内核给 `velar:files` 的缩图口子用它。不碰实例状态。 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AppError } from '@velaros-ai/core/error'
import type { FileImageResizeRequest, FileImageResizeResult } from '@velaros-ai/files'

import { runPlatformCommand } from './process.js'

/** macOS 自带 sips 认的输出格式：PNG 与 JPEG 原样保留，GIF、WebP 一律转成 PNG（只取第一帧，与 API 的处理一致）。 */
function sipsOutputOf(mediaType: string): { format: 'png' | 'jpeg'; extension: string; mediaType: string } {
  return mediaType === 'image/jpeg'
    ? { format: 'jpeg', extension: 'jpg', mediaType: 'image/jpeg' }
    : { format: 'png', extension: 'png', mediaType: 'image/png' }
}

/** 让 sips 报一张图的像素尺寸（`-g pixelWidth -g pixelHeight`）；读不出来就报错。 */
async function sipsPixelSize(path: string): Promise<{ width: number; height: number }> {
  const { stdout } = await runPlatformCommand({ file: 'sips', args: ['-g', 'pixelWidth', '-g', 'pixelHeight', path] })
  const width = Number(/pixelWidth:\s*(\d+)/u.exec(stdout)?.[1])
  const height = Number(/pixelHeight:\s*(\d+)/u.exec(stdout)?.[1])
  if (!width || !height) throw new AppError('PLATFORM', `sips 读不出这张图的尺寸：${stdout.trim().slice(0, 200)}`)
  return { width, height }
}

/**
 * 用 macOS 自带的 sips 裁图、缩图。
 *
 * **裁与缩必须分两次调**：sips 不管参数怎么排都先缩后裁（实测：`-c 80 100 --cropOffset 10 250 -Z 50`
 * 出来是 12×10，它先把整张缩小再去裁，裁到图外面去了）。
 * `-Z` 只在真超了长边时才给：它会把小图放大，放大了既费 token 又不会更清楚。
 * 中间文件放在自己建的临时目录里，用完连目录一起删——删的只是这里 mkdtemp 出来的那一个。
 */
export async function resizeImageWithSips(request: FileImageResizeRequest): Promise<FileImageResizeResult> {
  const output = sipsOutputOf(request.mediaType)
  const directory = await mkdtemp(join(tmpdir(), 'velaros-image-'))
  try {
    let current = join(directory, 'source')
    await writeFile(current, request.data)
    let size = request.region ? { width: request.region.width, height: request.region.height } : await sipsPixelSize(current)

    if (request.region) {
      const cropped = join(directory, `cropped.${output.extension}`)
      const { x, y, width, height } = request.region
      await runPlatformCommand({ file: 'sips', args: ['-s', 'format', output.format, '-c', String(height), String(width), '--cropOffset', String(y), String(x), current, '--out', cropped] })
      current = cropped
    }
    const oversized = Math.max(size.width, size.height) > request.longEdge
    if (oversized || !request.region) {
      const resized = join(directory, `resized.${output.extension}`)
      await runPlatformCommand({ file: 'sips', args: ['-s', 'format', output.format, ...(oversized ? ['-Z', String(request.longEdge)] : []), current, '--out', resized] })
      current = resized
      size = await sipsPixelSize(current)
    }

    return { data: await readFile(current), mediaType: output.mediaType, width: size.width, height: size.height }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
