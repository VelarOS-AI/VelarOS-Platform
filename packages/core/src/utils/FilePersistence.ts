import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  type WriteFileOptions,
  writeFileSync,
} from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { logRuntime } from '../logger'
import { isUndefined } from '../typeGuards'

import { TimerScope } from './TimerScope'

const DefaultEncoding: BufferEncoding = 'utf-8'
const WindowsRenameRetryDelaysMs = [20, 40, 80, 160] as const
const log = logRuntime.tag('FilePersistence')

interface AtomicTextFileWriteOptions {
  encoding?: BufferEncoding
  mode?: number
}

interface AtomicJsonFileWriteOptions extends AtomicTextFileWriteOptions {
  space?: number
  trailingNewline?: boolean
}

type AtomicFileWriteContent = string | Uint8Array

function toWriteFileOptions(options: AtomicTextFileWriteOptions = {}): WriteFileOptions {
  return {
    encoding: options.encoding ?? DefaultEncoding,
    mode: options.mode,
  }
}

function createAtomicTempPath(filePath: string): string {
  return `${filePath}.${process.pid}.${randomUUID()}.tmp`
}

/** Windows 共享读取或文件扫描可能短暂占用目标；只重试原子替换，不删除正式文件或重写临时正文。 */
async function publishAtomicFile(tmpPath: string, filePath: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmpPath, filePath)
      return
    } catch (error) {
      const code = (error as Nullable<NodeJS.ErrnoException>)?.code
      const delay = WindowsRenameRetryDelaysMs[attempt]
      if (
        process.platform !== 'win32' ||
        isUndefined(delay) ||
        (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')
      )
        throw error
      await TimerScope.sleep(delay)
    }
  }
}

/**
 * 原子写文件：先写同目录临时文件，再 rename 覆盖正式文件。
 * 这样进程在写入中途退出时，正式文件不会留下半截内容。
 */
async function writeFileAtomically(
  filePath: string,
  content: AtomicFileWriteContent,
  options: AtomicTextFileWriteOptions = {}
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = createAtomicTempPath(filePath)
  try {
    await writeFile(tmpPath, content, toWriteFileOptions(options))
    await publishAtomicFile(tmpPath, filePath)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch((cleanupError) => {
      log.warn('原子写入失败后清理临时文件失败', {
        cleanupError,
        tmpPath,
      })
    })
    throw error
  }
}

/** 同步版原子写文件，用于窗口关闭前必须阻塞落盘的 sendSync/beforeunload 流程。 */
function writeFileAtomicallySync(
  filePath: string,
  content: AtomicFileWriteContent,
  options: AtomicTextFileWriteOptions = {}
): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = createAtomicTempPath(filePath)
  try {
    writeFileSync(tmpPath, content, toWriteFileOptions(options))
    renameSync(tmpPath, filePath)
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true })
    } catch (cleanupError) {
      log.warn('原子写入失败后清理临时文件失败', {
        cleanupError,
        tmpPath,
      })
    }
    throw error
  }
}

/** 完整写入并刷新临时文件后，以硬链接一次性发布；目标已存在时返回 false，绝不覆盖。 */
function writeFileOnceSync(
  filePath: string,
  content: AtomicFileWriteContent,
  options: AtomicTextFileWriteOptions = {}
): boolean {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = createAtomicTempPath(filePath)
  let descriptor: number | undefined
  try {
    descriptor = openSync(tmpPath, 'wx', options.mode ?? 0o600)
    writeFileSync(descriptor, content, toWriteFileOptions(options))
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    try {
      linkSync(tmpPath, filePath)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  } finally {
    try {
      if (!isUndefined(descriptor)) closeSync(descriptor)
    } finally {
      try {
        rmSync(tmpPath, { force: true })
      } catch (error) {
        log.warn('failed to remove one-time file staging path', { error, tmpPath })
      }
    }
  }
}

async function writeTextFileAtomically(
  filePath: string,
  content: string,
  options: AtomicTextFileWriteOptions = {}
): Promise<void> {
  await writeFileAtomically(filePath, content, options)
}

function writeTextFileAtomicallySync(
  filePath: string,
  content: string,
  options: AtomicTextFileWriteOptions = {}
): void {
  writeFileAtomicallySync(filePath, content, options)
}

function serializeJsonFileContent<T>(payload: T, options: AtomicJsonFileWriteOptions = {}): string {
  const content = JSON.stringify(payload, null, options.space)
  return options.trailingNewline ? `${content}\n` : content
}

async function writeJsonFileAtomically<T>(
  filePath: string,
  payload: T,
  options: AtomicJsonFileWriteOptions = {}
): Promise<void> {
  await writeTextFileAtomically(filePath, serializeJsonFileContent(payload, options), options)
}

function writeJsonFileAtomicallySync<T>(
  filePath: string,
  payload: T,
  options: AtomicJsonFileWriteOptions = {}
): void {
  writeTextFileAtomicallySync(filePath, serializeJsonFileContent(payload, options), options)
}

export {
  writeFileAtomically,
  writeFileAtomicallySync,
  writeFileOnceSync,
  writeJsonFileAtomically,
  writeJsonFileAtomicallySync,
  writeTextFileAtomically,
  writeTextFileAtomicallySync,
}
export type { AtomicFileWriteContent, AtomicJsonFileWriteOptions, AtomicTextFileWriteOptions }
