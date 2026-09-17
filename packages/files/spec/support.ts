/**
 * 验收测试与实现测试共用的假对象：一个落在真磁盘上的空间端口、造 PNG 的小工具、跑一段模型程序的会话。
 * 放在 spec 下，因为验收测试依赖它们；实现测试也从这里取，不再各抄一份。
 */

import { mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'
import type { CodeCapabilityPort } from '@velaros-ai/code-surface'
import { codeProgramChecker, createCodeSurfaceSession, nodeSubprocessCodeRunner } from '@velaros-ai/code-surface'
import { AppError } from '@velaros-ai/core/error'
import { textFileIo } from '@velaros-ai/text-files'

import type { FileAttachedImage, FileConfirmation, FileEditInput, FileImageResizeRequest, FileImageResizeResult, FileOperationContext, FileReadInput, FileSpacePort, FileViewInput, FileWrite } from '../src/index'
import { fileOperations } from '../src/index'

/** 解开符号链接后的真实路径；文件还不存在时解开它的上级目录。 */
async function realTarget(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return join(await realTarget(dirname(path)).catch(() => dirname(path)), basename(path))
  }
}

/**
 * 一个落在真磁盘上的空间：相对路径相对 root；`clamp` 为真时像项目空间那样越出 root 就拒绝。
 * 审查按给的函数答（缺省什么都不问），每次确认交给 `answer`（缺省放行）；落盘一个一个原子替换，核对 expected。
 */
export function diskSpace(options: {
  root: string
  clamp?: boolean
  reviewRead?: (target: string) => FileConfirmation[]
  reviewWrite?: (target: string) => FileConfirmation[]
  answer?: (message: string) => void | Promise<void>
  resize?: (request: FileImageResizeRequest) => Promise<FileImageResizeResult>
  attach?: boolean
}) {
  const confirmations: string[] = []
  const commits: FileWrite[][] = []
  const resized: FileImageResizeRequest[] = []
  const attached: FileAttachedImage[] = []
  const port: FileSpacePort = {
    locate: async (path) => {
      const absolute = isAbsolute(path) ? resolve(path) : resolve(options.root, path)
      const target = await realTarget(absolute)
      if (options.clamp) {
        const rootTarget = await realpath(options.root)
        const inside = relative(rootTarget, target)
        if (inside.startsWith('..') || isAbsolute(inside)) throw new AppError('PERMISSION', `${path} 在这个空间之外`)
      }
      return { path: options.clamp ? relative(options.root, absolute) : absolute, target, linked: target !== absolute }
    },
    reviewRead: async (target) => options.reviewRead?.(target) ?? [],
    reviewWrite: async (target) => options.reviewWrite?.(target) ?? [],
    commit: async (writes) => {
      commits.push([...writes])
      const applied: string[] = []
      for (const write of writes) {
        try {
          await mkdir(dirname(write.target), { recursive: true })
          await textFileIo.writeBytes(write.target, write.bytes, write.expected ? { expected: write.expected } : {})
          applied.push(write.target)
        } catch (error) {
          throw new AppError('VALIDATION', `写 ${write.target} 失败：${AppError.from(error).message}`, error, { applied })
        }
      }
    },
  }
  if (options.resize) {
    const resize = options.resize
    port.resizeImage = async (request) => {
      resized.push(request)
      return resize(request)
    }
  }
  const approval: ApprovalPort = {
    awaitConfirmation: async (message) => {
      confirmations.push(message)
      await options.answer?.(message)
    },
    awaitConfirmationDecision: async () => ({ approved: true, message: null, autoApproved: false }),
  }
  const context: FileOperationContext = { abortSignal: new AbortController().signal, files: port, approval }
  if (options.attach !== false) context.attachImage = (image) => attached.push(image)
  return { port, context, confirmations, commits, resized, attached }
}

/** 一个会问用户的审查结果：文案就是路径，选项是高风险。 */
export function asking(target: string): FileConfirmation[] {
  return [{ message: `要动 ${target} 吗？`, options: { approvalRisk: 'high' } }]
}

/** 等一个调用失败，交出它的码与说明。 */
export async function failureOf(call: Promise<unknown>): Promise<{ code: string; message: string; context: Record<string, unknown> }> {
  try {
    await call
  } catch (error) {
    const failure = AppError.from(error)
    return { code: failure.code, message: failure.message, context: failure.context }
  }
  throw new Error('应当失败，却成功了')
}

/** 让一段真程序照生成的声明过 typecheck，再在隔离里跑完，交出整个结果。 */
export async function runModelProgram(space: ReturnType<typeof diskSpace>, declarations: string, source: string, timeoutMs = 20_000) {
  const capabilities: CodeCapabilityPort = {
    listOperations: () => ({ files: ['read', 'view', 'edit'] }),
    invoke: async ({ operation, input }) => {
      try {
        if (operation === 'read') return { value: await fileOperations.read(input as FileReadInput, space.context) }
        if (operation === 'view') return { value: await fileOperations.view(input as FileViewInput, space.context) }
        if (operation === 'edit') return { value: await fileOperations.edit(input as FileEditInput, space.context) }
        return { error: { code: 'UNKNOWN_OPERATION', message: `没有 files.${operation}` } }
      } catch (error) {
        const failure = AppError.from(error)
        return { error: { code: failure.code, message: failure.message } }
      }
    },
  }
  const session = createCodeSurfaceSession({ checker: codeProgramChecker, runner: nodeSubprocessCodeRunner, capabilities })
  const outcome = await session.submit({ program: { source }, granted: [{ namespace: 'files', declarations }], timeoutMs })
  if (!outcome.checked) {
    const why = 'needsModules' in outcome ? `要先补模块 ${outcome.needsModules.join(', ')}` : JSON.stringify(outcome.check.diagnostics)
    throw new Error(`程序没过 typecheck：${why}`)
  }
  return outcome.result
}

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

/** 造一张纯色 PNG：左半红、右半蓝，裁剪后看颜色就知道裁的是哪一边。 */
export function solidPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed))
    return Buffer.concat([length, typed, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8)
  header.writeUInt8(2, 9)
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x += 1) row.set(x < width / 2 ? [255, 0, 0] : [0, 0, 255], 1 + x * 3)
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
