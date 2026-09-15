/**
 * 磁盘读写的工具函数：非阻塞地打开普通文件、有界读、读文件头、原子替换、核对原字节。只给 Node 用。
 */

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { type FileHandle, lstat, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { isPlainObject, isPresent, isString, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { TextFileErrorCodes } from '../contract/constants.js'
import type { ExpectedBytes } from '../types/text-files.js'

/** 原子替换在写前、改名前核对原字节对不上时的说明。 */
const WriteMismatchMessage = '字节写入前检测到外部修改。'

/** 读出文件系统错误的 errno 码（如 ENOENT）；不是这类错误返回 null。 */
export function errnoOf(error: unknown): Nullable<string> {
  return isPlainObject(error) && isString(error.code) ? error.code : null
}

/** 权限位是不是 0 到 0777 之间的整数。 */
function isPermissionBits(mode: number): boolean {
  return Number.isInteger(mode) && mode >= 0 && mode <= 0o777
}

/**
 * 只读打开一个普通文件：目录、管道、设备这类不是普通文件的，关掉句柄抛 notRegular；不存在时照常抛文件系统的 ENOENT。
 * 非 Windows 上按非阻塞方式打开，命名管道没有写端也立刻返回、随即按类型拒掉，不会把调用卡住。
 */
export async function openRegularFile(path: string): Promise<FileHandle> {
  const handle = await open(path, process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NONBLOCK)
  let regular = false
  try {
    regular = (await handle.stat()).isFile()
  } finally {
    if (!regular) await handle.close()
  }
  if (!regular) throw new AppError(TextFileErrorCodes.notRegular, '不是普通文件（目录、管道或设备），不能当文本读写。', undefined, { path })
  return handle
}

/** 在同一个句柄上有界读整个文件：不存在返回 undefined；超过 maxBytes 抛 tooLarge，不分配大缓冲；多读一个字节，读的过程中文件变长抛 externalEdit。 */
export async function readBoundedBytes(path: string, maxBytes: number): Promise<Buffer | undefined> {
  const handle = await openRegularFile(path).catch((error: unknown) => {
    if (errnoOf(error) === 'ENOENT') return undefined
    throw error
  })
  if (!handle) return undefined
  try {
    const { size } = await handle.stat()
    if (size > maxBytes) throw new AppError(TextFileErrorCodes.tooLarge, `文件字节长度 ${size} 超过上限 ${maxBytes}。`, undefined, { path, size, maxBytes })
    // 多要一个字节：读得到第 size + 1 个字节，说明文件在读的过程中变长了。
    const bytes = Buffer.alloc(size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > size) throw new AppError(TextFileErrorCodes.externalEdit, '文件在读取期间变长了，已被外部修改。', undefined, { path })
    return bytes.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

/** 读文件开头最多 bytes 个字节，不把整个文件读进来；不是普通文件抛 notRegular，不存在抛文件系统的 ENOENT。 */
export async function readHeadBytes(path: string, bytes: number): Promise<Buffer> {
  const handle = await openRegularFile(path)
  try {
    const head = Buffer.alloc(bytes)
    let offset = 0
    while (offset < head.length) {
      const { bytesRead } = await handle.read(head, offset, head.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return head.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

/** 磁盘上现在的字节（不存在为 undefined）是不是预期的那一份。 */
export function matchesExpected(current: Optional<Uint8Array>, expected: ExpectedBytes): boolean {
  if (!expected.exists) return isUndefined(current)
  if (isUndefined(current) || isUndefined(expected.bytes)) return false
  return Buffer.from(current.buffer, current.byteOffset, current.byteLength).equals(expected.bytes)
}

/** 核对磁盘上的字节还是预期那份：按预期的长度有界读，多出字节、变成了别的类型、内容不同都算被外部改过，抛 externalEdit（message 说明是哪一步的核对）。 */
export async function assertBytesOnDisk(path: string, expected: ExpectedBytes, message: string): Promise<void> {
  const current = await readBoundedBytes(path, expected.bytes?.length ?? 0).catch((error: unknown) => {
    const changedShape = error instanceof AppError && (error.code === TextFileErrorCodes.tooLarge || error.code === TextFileErrorCodes.notRegular)
    throw changedShape ? new AppError(TextFileErrorCodes.externalEdit, message, error, { path }) : error
  })
  if (!matchesExpected(current, expected)) throw new AppError(TextFileErrorCodes.externalEdit, message, undefined, { path })
}

/**
 * 原子替换一个文件的全部字节：沿符号链接找到真正的文件（链接本身不动），已有的只接受普通文件、拒绝多硬链接的（替换会把它和其余链接拆开）；
 * prepare 在建临时文件之前算出要写的字节，它抛错时磁盘一个字节都不动；在同目录写完整临时文件、fsync、改名覆盖，再 fsync 目录（Windows 不做这一步）。
 * 已有文件精确恢复它的权限位，新文件用 mode 并精确设上（不给就由 umask 定）；给了 expected 时，写前与改名前各核对一次磁盘上的字节。
 */
export async function replaceFileAtomically(
  path: string,
  prepare: (target: string, exists: boolean) => Uint8Array | Promise<Uint8Array>,
  options: { mode?: number; expected?: ExpectedBytes },
): Promise<void> {
  if (isPresent(options.mode) && !isPermissionBits(options.mode))
    throw new AppError(TextFileErrorCodes.invalidMode, '文件权限必须是 0 到 0777 的普通权限位。', undefined, { path, mode: options.mode })
  const entry = await lstat(path).catch((error: unknown) => {
    if (errnoOf(error) === 'ENOENT') return undefined
    throw error
  })
  const target = entry?.isSymbolicLink() ? await realpath(path) : path
  const existing = entry?.isSymbolicLink() ? await lstat(target) : entry
  if (existing && (!existing.isFile() || existing.nlink > 1)) {
    throw new AppError(
      TextFileErrorCodes.notRegular,
      '原子替换只接受普通文件或指向普通文件的符号链接；有多个硬链接的文件替换后会和其余链接分家，拒绝写入。',
      undefined,
      { path, nlink: existing.nlink },
    )
  }
  if (options.expected) await assertBytesOnDisk(target, options.expected, WriteMismatchMessage)
  // 要写的字节在建临时文件之前算好：编码失败时磁盘上什么都没发生。
  const bytes = await prepare(target, !isUndefined(existing))
  const temporary = join(dirname(target), `.velaros-write-${randomUUID()}.tmp`)
  const mode = existing ? existing.mode & 0o777 : options.mode
  // 没有要设的权限时不传 mode：open 按 0o666 建文件，再由 umask 收紧。
  const handle = await open(temporary, 'wx', mode)
  try {
    // 要设的权限一律精确设上，不受 umask 影响。
    if (isPresent(mode)) await handle.chmod(mode)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    if (options.expected) await assertBytesOnDisk(target, options.expected, WriteMismatchMessage)
    await rename(temporary, target)
    if (process.platform !== 'win32') await syncDirectory(dirname(target))
  } finally {
    await handle.close()
    await rm(temporary, { force: true })
  }
}

/** fsync 一个目录，让刚才的改名在断电之后也算数。 */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
