import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  renameSync,
  rmSync,
  type WriteFileOptions,
  writeFileSync,
} from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { logRuntime } from '../logger'

const DefaultEncoding: BufferEncoding = 'utf-8'
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
    await rename(tmpPath, filePath)
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

function serializeJsonFileContent<T>(
  payload: T,
  options: AtomicJsonFileWriteOptions = {}
): string {
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
  writeJsonFileAtomically,
  writeJsonFileAtomicallySync,
  writeTextFileAtomically,
  writeTextFileAtomicallySync,
}
export type { AtomicFileWriteContent, AtomicJsonFileWriteOptions, AtomicTextFileWriteOptions }
