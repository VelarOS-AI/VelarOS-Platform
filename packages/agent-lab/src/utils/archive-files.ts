/**
 * 归档文件边界：run id 与路径、严格当前格式读取，以及原子发布。
 * 同目录临时文件完整写完再发布：运行归档用硬链接首次发布，普通文件用改名替换；临时文件由本次写入清理。
 */
import { randomUUID } from 'node:crypto'
import {
  type FileHandle,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { DiscoveredRunArchive } from '../types/agent-lab.js'

import { runArchiveSchema } from './wire/journey.js'

/** 当前 schema 已校验的运行归档路径：`<root>/<runId>/report.json`。 */
export function runArchivePath(root: string, runId: string): string {
  return join(resolve(root), runId, 'report.json')
}

/** 原子写一段文本：先写同目录临时文件再改名；中途失败把临时文件清掉，磁盘上不留半份。 */
export async function writeTextAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** 原子写一份 JSON：缩进两格、末尾一个换行，写法与上面同一条路径。 */
export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await writeTextAtomically(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** 首次发布运行归档；已有目标只有与本次序列化字节完全相同时才算幂等，不覆盖或改写。 */
export async function writeJsonOnceAtomically(path: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  let handle: FileHandle | undefined
  let created = false
  const errors: unknown[] = []
  try {
    handle = await open(temporary, 'wx')
    created = true
    await handle.writeFile(bytes)
    await handle.close()
    handle = undefined
    try {
      await link(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!(await readFile(path)).equals(bytes))
        throw new Error(`运行归档已存在且内容不同: ${path}`)
    }
  } catch (error) {
    errors.push(error)
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch (error) {
        errors.push(error)
      }
    }
    if (created) {
      try {
        await rm(temporary, { force: true })
      } catch (error) {
        errors.push(error)
      }
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1)
    throw new AggregateError(errors, '运行归档发布与临时文件收尾失败', { cause: errors[0] })
}

/** 读取目录唯一的当前 report.json；只有 ENOENT 是缺席，其余错误保留并上抛。 */
export async function readRunArchiveDirectory(
  directory: string
): Promise<DiscoveredRunArchive | null> {
  const path = join(directory, 'report.json')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return { directory, path, archive: runArchiveSchema.parse(JSON.parse(text)) }
}

/** 读一个 JSON 文件并解析；路径先 resolve 成绝对路径。 */
export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), 'utf8'))
}
