/**
 * 验收测试与实现测试共用的假对象：一个落在真磁盘上的看图空间（定位、缩图、交图都记下来）、一个像 sips 那样的假缩放器、
 * 造四种图片头的小工具、一张真能交给 sips 解码的纯色 PNG、跑一段模型程序的代码面会话，以及只删自己建的临时目录的清理。
 * 放在 spec 下，因为验收测试依赖它们；实现测试（仓库层的能力模版测试也算）从这里取，不再各抄一份。
 */

import { readFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

import { AppError } from '@velaros-ai/core/error'
import type { CapabilityOperationContext } from '@velaros-ai/script'
import {
  codeProgramChecker,
  createCapabilityPort,
  createCodeSurfaceSession,
  nodeSubprocessCodeRunner,
} from '@velaros-ai/script'

import type {
  ImageAttachment,
  ImageOperationContext,
  ImageResizeRequest,
  ImageResizeResult,
  ImageSpacePort,
} from '../index'
import { ImageLimits, imageOperations } from '../index'

// ── 临时目录 ────────────────────────────────────────────────────

/** 本套测试建的临时目录都带这个前缀；清理只认它。 */
const ScratchPrefix = 'velaros-images-'

/** 在系统临时目录下建一个本套测试专用的空目录，交回解开符号链接之后的路径。 */
export async function makeScratch(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), ScratchPrefix)))
}

/** 删掉 makeScratch 建的目录：不是系统临时目录下、带本套前缀的那一级目录就拒绝，绝不递归删别处。 */
export async function removeScratch(directory: string): Promise<void> {
  const base = await realpath(tmpdir())
  if (dirname(directory) !== base || !basename(directory).startsWith(ScratchPrefix)) {
    throw new Error(`拒绝删除 ${directory}：不是本套测试在系统临时目录下建的目录`)
  }
  await rm(directory, { recursive: true, force: true })
}

// ── 空间 ────────────────────────────────────────────────────────

/** 解开符号链接后的真实路径；文件还不存在时解开它的上级目录。 */
async function realTarget(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(await realTarget(parent), basename(path))
  }
}

/** target 是不是在 root 里（含 root 本身）；两边都是解开符号链接之后的绝对路径。 */
function isInside(root: string, target: string): boolean {
  const inside = relative(root, target)
  return !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`)
}

/**
 * 一个落在真磁盘上的看图空间：相对路径相对 root。`clamp` 为真时像项目空间那样越出 root（经符号链接指出去也算）就拒绝，
 * 交给模型的写法是相对 root 的路径；为假时像系统空间那样收本机任意位置，写法是绝对路径。
 * 给了 `resize` 才有缩图的口子；`attach` 为 false 时宿主没有交图通道。定位过的路径、缩图请求、交出的图都记下来。
 */
export function imageSpace(options: {
  root: string
  clamp?: boolean
  resize?: (request: ImageResizeRequest) => Promise<ImageResizeResult>
  attach?: boolean
  abortSignal?: AbortSignal
}) {
  const located: string[] = []
  const resized: ImageResizeRequest[] = []
  const attached: ImageAttachment[] = []
  const port: ImageSpacePort = {
    locate: async (path) => {
      located.push(path)
      const absolute = isAbsolute(path) ? resolve(path) : resolve(options.root, path)
      const target = await realTarget(absolute)
      if (options.clamp && !isInside(await realpath(options.root), target))
        throw new AppError('PERMISSION', `${path} 在这个空间之外，只能看空间里的图`)
      return { target, shown: options.clamp ? relative(options.root, absolute) || '.' : absolute }
    },
  }
  const resize = options.resize
  if (resize) {
    port.resizeImage = async (request) => {
      resized.push(request)
      return resize(request)
    }
  }
  const context: ImageOperationContext = {
    abortSignal: options.abortSignal ?? new AbortController().signal,
    images: port,
  }
  if (options.attach !== false) context.attachImage = (image) => attached.push(image)
  /** 代码面宿主给每次调用装的上下文，与系统空间、项目空间的装法相同：同一个端口，图交给代码面的图片通道。 */
  const hostContext = (call: CapabilityOperationContext): ImageOperationContext => ({
    abortSignal: call.signal ?? new AbortController().signal,
    images: port,
    attachImage: (image) => call.attach({ type: 'image-data', ...image }),
  })
  return { port, context, hostContext, located, resized, attached }
}

/** 等一个调用失败，交出它的码与说明。 */
export async function failureOf(
  call: Promise<unknown>
): Promise<{ code: string; message: string }> {
  try {
    await call
  } catch (error) {
    const failure = AppError.from(error)
    return { code: failure.code, message: failure.message }
  }
  throw new Error('应当失败，却成功了')
}

// ── 代码面 ──────────────────────────────────────────────────────

/** 模型这一轮读到的 `velaros:images` 声明：就是提交进仓的那份生成物：程序照它核对 import，代码模版照它过类型检查。 */
export const ImageDeclarations = readFileSync(
  fileURLToPath(new URL('../../../../baselines/script/images.d.ts', import.meta.url)),
  'utf8'
)

/** 这一轮授给程序的模块：只有 `images` 一个命名空间。 */
const Granted = [{ namespace: 'images', declarations: ImageDeclarations }]

/** 代码模版照生成的声明做完整类型检查、不执行：交回诊断，过了就是空的。模型交的程序只查语法，不走这里。 */
export function typecheckTemplate(source: string) {
  const checked = codeProgramChecker.typecheck({ source, granted: Granted })
  return checked.ok ? [] : checked.diagnostics
}

/**
 * 让一段真程序过语法检查，再在隔离里跑完。能力端口由一张只有 `images.view` 的操作表接出来，
 * 每次调用经 `hostContext` 装一份 `ImageOperationContext`；交出程序的结果与跟在结果旁边交给模型的图。
 */
export async function runModelProgram(
  space: ReturnType<typeof imageSpace>,
  source: string,
  timeoutMs = 20_000
) {
  const capabilities = createCapabilityPort({
    images: {
      view: async (input, context) => imageOperations.view(input, space.hostContext(context)),
    },
  })
  const session = createCodeSurfaceSession({
    checker: codeProgramChecker,
    runner: nodeSubprocessCodeRunner,
    capabilities,
  })
  const outcome = await session.submit({ program: { source }, granted: Granted, timeoutMs })
  if (!outcome.checked) {
    const why =
      'needsModules' in outcome
        ? `要先补模块 ${outcome.needsModules.join(', ')}`
        : JSON.stringify(outcome.check.diagnostics)
    throw new Error(`程序没过检查：${why}`)
  }
  return { result: outcome.result, attachments: outcome.attachments ?? [] }
}

// ── 造图 ────────────────────────────────────────────────────────

/** PNG 的文件签名。 */
const PngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** CRC32 表：PNG 每个块都要校验，测试里现算，不依赖运行时有没有 zlib.crc32。 */
const Crc32Table = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (Crc32Table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** 一个 PNG 块：数据长度、类型、数据、对类型加数据的 CRC。 */
function pngChunk(type: string, data: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

/**
 * 造一张真能解码的 PNG：1 位灰度，左半黑、右半白。位深 1 让 4000×3000 的像素也只有 1.5 MB，zlib 压起来很快。
 * 给了 bytes 就在 IEND 之前插一个私有辅助块（解码器会跳过），把整个文件垫到正好这么多字节，用来卡 base64 体积的边。
 */
export function pngImage(width: number, height: number, options: { bytes?: number } = {}): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(1, 8)
  const row = Buffer.alloc(1 + Math.ceil(width / 8))
  for (let x = Math.ceil(width / 2); x < width; x += 1) row[1 + (x >> 3)] |= 0x80 >> (x & 7)
  const chunks = [
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
  ]
  const end = pngChunk('IEND', Buffer.alloc(0))
  if (options.bytes !== undefined) {
    const used =
      PngSignature.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0) + end.length
    const padding = options.bytes - used - 12
    if (padding < 0)
      throw new Error(`${width}×${height} 的 PNG 至少 ${used + 12} 字节，垫不到 ${options.bytes}`)
    chunks.push(pngChunk('vpAd', Buffer.alloc(padding)))
  }
  return Buffer.concat([PngSignature, ...chunks, end])
}

/**
 * 造一张真能解码的纯色 PNG：8 位 RGB，左半红、右半蓝，裁剪后看颜色就知道裁的是哪一边。
 * 交给真的缩放器（macOS 的 sips）用；只核对头的测试用更小的 `pngImage`。
 */
export function solidPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8)
  header.writeUInt8(2, 9)
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x += 1) row.set(x < width / 2 ? [255, 0, 0] : [0, 0, 255], 1 + x * 3)
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    PngSignature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 一段 JPEG 段：0xFF、标记、两字节段长（算上段长自己），再接内容。 */
export function jpegSegment(marker: number, body: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0])
  head.writeUInt16BE(body.length + 2, 2)
  return Buffer.concat([head, body])
}

/** 真实 JPEG 在帧头之前都有的两段：JFIF 的 APP0 与一张量化表。认宽高得顺着段长跳过去。 */
const JpegPreamble = [
  jpegSegment(
    0xe0,
    Buffer.from([
      0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    ])
  ),
  jpegSegment(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)])),
]

/**
 * 造一张只有头的 JPEG：SOI、帧头之前的几段（缺省 APP0 与量化表）、帧头（缺省 SOF0：精度、高、宽、三个分量），再接 EOI。
 * 看图不解码像素，宽高就在帧头里，这些就够认。
 */
export function jpegImage(
  width: number,
  height: number,
  options: { frame?: number; before?: Buffer[] } = {}
): Buffer {
  const frame = Buffer.from([8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  frame.writeUInt16BE(height, 1)
  frame.writeUInt16BE(width, 3)
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...(options.before ?? JpegPreamble),
    jpegSegment(options.frame ?? 0xc0, frame),
    Buffer.from([0xff, 0xd9]),
  ])
}

/** 造一张只有头的 GIF：签名、逻辑屏幕（宽高是小端两字节）、两色的全局色表，再接结束符。 */
export function gifImage(width: number, height: number, version: '87a' | '89a' = '89a'): Buffer {
  const screen = Buffer.alloc(7)
  screen.writeUInt16LE(width, 0)
  screen.writeUInt16LE(height, 2)
  screen.writeUInt8(0x80, 4)
  return Buffer.concat([
    Buffer.from(`GIF${version}`, 'ascii'),
    screen,
    Buffer.from([0, 0, 0, 0xff, 0xff, 0xff, 0x3b]),
  ])
}

/** 一个 RIFF 包着的 WebP：RIFF、其后的长度、WEBP，再接一个块（块长是奇数时补一个字节）。 */
export function webpFile(chunkType: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(8)
  chunk.write(chunkType, 0, 'ascii')
  chunk.writeUInt32LE(data.length, 4)
  const body = Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    chunk,
    data,
    Buffer.alloc(data.length % 2),
  ])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

/**
 * 造一张只有头的 WebP，三种头：有损 VP8（帧标记、起始码 9d 01 2a，再是 14 位宽高，每个的高两位是缩放）、
 * 无损 VP8L（签名字节 0x2f 之后的位域：14 位宽减一、14 位高减一）、扩展 VP8X（标志与保留位，再是 24 位的画布宽减一、高减一）。
 */
export function webpImage(
  width: number,
  height: number,
  kind: 'VP8 ' | 'VP8L' | 'VP8X',
  options: { scaleBits?: number } = {}
): Buffer {
  const data = Buffer.alloc(10)
  if (kind === 'VP8 ') {
    data.set([0x9d, 0x01, 0x2a], 3)
    data.writeUInt16LE(width | ((options.scaleBits ?? 0) << 14), 6)
    data.writeUInt16LE(height | ((options.scaleBits ?? 0) << 14), 8)
  } else if (kind === 'VP8L') {
    data.writeUInt8(0x2f, 0)
    data.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1)
  } else {
    data.writeUIntLE(width - 1, 4, 3)
    data.writeUIntLE(height - 1, 7, 3)
  }
  return webpFile(kind, data)
}

/** 假缩放器认得的原图尺寸：PNG 与 GIF 从头里读。 */
function sizeOf(data: Buffer): { width: number; height: number } {
  if (data.subarray(0, PngSignature.length).equals(PngSignature))
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  if (data.toString('ascii', 0, 3) === 'GIF')
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) }
  throw new Error('假缩放器只认 PNG 与 GIF')
}

/**
 * 一个像 sips 那样的假缩放器：先裁（给了 region 就只留那一块），再等比缩到长边不超过 longEdge（不放大），交回一张新造的 PNG。
 * `bloat` 说是的那几次故意交回 base64 之后超上限的字节，用来逼出「再收一截」。
 */
export function pngResizer(options: { bloat?: (request: ImageResizeRequest) => boolean } = {}) {
  return async (request: ImageResizeRequest): Promise<ImageResizeResult> => {
    const kept = request.region ?? sizeOf(request.data)
    const scale = Math.min(1, request.longEdge / Math.max(kept.width, kept.height))
    const width = Math.max(1, Math.round(kept.width * scale))
    const height = Math.max(1, Math.round(kept.height * scale))
    const bloated = options.bloat?.(request) ?? false
    return {
      data: pngImage(width, height, bloated ? { bytes: ImageLimits.base64Bytes } : {}),
      mediaType: 'image/png',
      width,
      height,
    }
  }
}
