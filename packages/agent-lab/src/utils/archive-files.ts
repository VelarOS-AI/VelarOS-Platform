/**
 * 归档文件边界：run id 与路径、严格当前格式读取，以及原子发布。
 * 原子写只有这一份实现：先写同目录临时文件再改名，失败时把临时文件清掉，不留半份归档。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
