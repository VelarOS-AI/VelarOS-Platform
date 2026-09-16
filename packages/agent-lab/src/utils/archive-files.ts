/**
 * 归档落盘的两件小事：run id 的安全校验与路径拼装，以及原子写一份 JSON。
 * 原子写只有这一份实现：先写同目录临时文件再改名，失败时把临时文件清掉，不留半份归档。
 */
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { AgentLabLimits } from '../contract/constants.js'
import type { DiscoveredRunArchive } from '../types/agent-lab.js'

import { readRunArchiveView } from './measure/archive-view.js'

/** run id 会当目录名用：只许字母数字开头，后面只许字母数字与 `. _ : -`，长度按常量表的上限卡。 */
const SafeRunIdPattern = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${AgentLabLimits.runIdChars - 1}}$`)

/** 校验一个 run id 能不能当目录名；不能就当场报错，不去碰文件系统。 */
export function assertSafeRunId(runId: string): void {
  if (!SafeRunIdPattern.test(runId)) throw new Error(`run id 不安全，不能当目录名: ${runId}`)
}

/** 一份运行归档在归档根下的路径：`<root>/<runId>/report.json`。 */
export function runArchivePath(root: string, runId: string): string {
  assertSafeRunId(runId)
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

/** 这个路径存不存在。 */
export async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

/**
 * 在一个运行目录里找一份归档：先看 `report.json`，读不出来再退回 `progress.json`。
 * 不去把别的 JSON 夹具「发明」成第四种归档格式；都读不出来就是 `null`。
 */
export async function readArchiveCandidate(directory: string): Promise<DiscoveredRunArchive | null> {
  for (const name of ['report.json', 'progress.json'] as const) {
    const path = join(directory, name)
    if (!(await fileExists(path))) continue
    try {
      const view = readRunArchiveView(JSON.parse(await readFile(path, 'utf8')))
      if (view.shape === 'invalid' || view.shape === 'missing') continue
      return { directory, path, source: name === 'report.json' ? 'report' : 'progress', view }
    } catch {
      // 写了一半的 report.json 后面可能还有一份能读的 progress.json。
    }
  }
  return null
}

/** 读一个 JSON 文件并解析；路径先 resolve 成绝对路径。 */
export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), 'utf8'))
}
