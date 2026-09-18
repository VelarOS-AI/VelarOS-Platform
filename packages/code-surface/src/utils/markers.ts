/**
 * 工作区标记的几件纯活：算哈希、把「路径 → 内容哈希」拼成只含哈希的目录树、比两棵树、写短哈希。
 *
 * 标记就是树根的哈希：每个目录一个节点，节点里按名字排好每一项的名字、是文件还是目录、内容哈希（目录是它那个节点的哈希）。
 * 内容相同，标记就相同；没变的目录节点哈希不变，存一次就够。树里只有哈希，不存文件本身。
 */

import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { createReadStream } from 'node:fs'
import { readlink } from 'node:fs/promises'

import { isArray, isString, isUndefined } from '@velaros-ai/core'

import type { ScriptFileChange } from '../types/code-surface.js'
import type { MarkerDirectory, MarkerEntry } from '../types/timeline.js'

import { CodeSurfaceTuning } from './tuning.js'

/**
 * 打标记时不算进去的文件名：系统自己随手写的（Finder、资源管理器），它们变了不代表工作区变了。
 * 被 .gitignore 忽略的与默认跳过的目录另外按 `@velaros-ai/path-rules` 的规矩判。
 */
export const MarkerSkippedFileNames: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/** 一段文字的 sha256（十六进制）：时间线里存的每样东西都按它寻址。 */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 一个文件内容的 sha256：边读边算，不把大文件整个读进内存。 */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * 一个工作区文件的内容哈希：符号链接不跟进去，记它指向哪；超过上限的大文件不读内容，按大小与修改时间算；其余读内容算。
 */
export async function hashWorkspaceFile(path: string, info: Stats): Promise<string> {
  if (info.isSymbolicLink()) return sha256Text(`symlink:${await readlink(path)}`)
  if (info.size > CodeSurfaceTuning.markerHashBytes) return sha256Text(`large:${info.size}:${info.mtimeMs}`)
  return sha256File(path)
}

/** 哈希只摆前八位给模型看：同一个工作区里够分得开。 */
export function shortHash(hash: Optional<string>): string {
  return isUndefined(hash) ? '（无）' : hash.slice(0, 8)
}

/** 名字按码点排：同一组条目在哪台机器上都排成一样，节点哈希才稳定。 */
function byName(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * 把「相对路径 → 内容哈希」拼成目录树：交回根哈希（标记）与这棵树的全部节点（节点哈希 → 节点正文）。
 * 调用方把还没存过的节点存起来。
 */
export function buildMarkerTree(files: ReadonlyMap<string, string>): { marker: string; nodes: Map<string, string> } {
  const root: MarkerDirectory = new Map()
  for (const [path, hash] of files) {
    const segments = path.split('/')
    const name = segments.pop() ?? path
    let directory = root
    for (const segment of segments) {
      const next = directory.get(segment)
      if (next instanceof Map) directory = next
      else {
        const created: MarkerDirectory = new Map()
        directory.set(segment, created)
        directory = created
      }
    }
    directory.set(name, hash)
  }
  const nodes = new Map<string, string>()
  const hashDirectory = (directory: MarkerDirectory): string => {
    const entries: MarkerEntry[] = [...directory.entries()]
      .sort(([left], [right]) => byName(left, right))
      .map(([name, value]) => (isString(value) ? [name, 'f', value] : [name, 'd', hashDirectory(value)]))
    const text = JSON.stringify(entries)
    const hash = sha256Text(text)
    nodes.set(hash, text)
    return hash
  }
  return { marker: hashDirectory(root), nodes }
}

/** 读一个目录节点的正文；读不出来（清掉了、坏了）当空目录。 */
export function parseMarkerNode(text: Optional<string>): MarkerEntry[] {
  if (isUndefined(text)) return []
  try {
    const parsed: unknown = JSON.parse(text)
    return isArray(parsed) ? (parsed as MarkerEntry[]) : []
  } catch {
    // arch-guard:silent-catch-ok 节点坏了当空目录：比不出来的文件会显示成新增或删除，不会让整次比较失败。
    return []
  }
}

/** 一个节点下的全部文件，路径前面接上 prefix。 */
async function collectFiles(hash: string, prefix: string, readNode: (hash: string) => Promise<Optional<string>>, out: Map<string, string>): Promise<void> {
  for (const [name, kind, child] of parseMarkerNode(await readNode(hash))) {
    const path = prefix ? `${prefix}/${name}` : name
    if (kind === 'd') await collectFiles(child, path, readNode, out)
    else out.set(path, child)
  }
}

/** 一个标记下的全部文件：相对路径 → 内容哈希。 */
export async function markerFiles(marker: string, readNode: (hash: string) => Promise<Optional<string>>): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  await collectFiles(marker, '', readNode, files)
  return files
}

/**
 * 两棵树之间改了哪些文件，按路径排。哈希相同的子树整棵跳过，所以只读变了的那几层节点。
 * 一边没有标记（那时没打成）时，另一边的文件全算新增或删除。
 */
export async function diffMarkerTrees(
  from: Optional<string>,
  to: Optional<string>,
  readNode: (hash: string) => Promise<Optional<string>>,
): Promise<ScriptFileChange[]> {
  const changes: ScriptFileChange[] = []
  const walk = async (left: Optional<string>, right: Optional<string>, prefix: string): Promise<void> => {
    if (left === right) return
    const before = new Map(parseMarkerNode(isUndefined(left) ? undefined : await readNode(left)).map((entry) => [entry[0], entry]))
    const after = new Map(parseMarkerNode(isUndefined(right) ? undefined : await readNode(right)).map((entry) => [entry[0], entry]))
    const names = [...new Set([...before.keys(), ...after.keys()])].sort(byName)
    for (const name of names) {
      const path = prefix ? `${prefix}/${name}` : name
      const was = before.get(name)
      const now = after.get(name)
      // 目录那一边往下走，文件那一边就地记一笔：同名的文件换成目录（或反过来）两边都照记。
      const wasDirectory = was?.[1] === 'd' ? was[2] : undefined
      const nowDirectory = now?.[1] === 'd' ? now[2] : undefined
      if (!isUndefined(wasDirectory) || !isUndefined(nowDirectory)) await walk(wasDirectory, nowDirectory, path)
      const wasFile = was?.[1] === 'f' ? was[2] : undefined
      const nowFile = now?.[1] === 'f' ? now[2] : undefined
      if (wasFile === nowFile) continue
      const change: ScriptFileChange = { path }
      if (!isUndefined(wasFile)) change.before = wasFile
      if (!isUndefined(nowFile)) change.after = nowFile
      changes.push(change)
    }
  }
  await walk(from, to, '')
  return changes.sort((left, right) => byName(left.path, right.path))
}

/** 两份文件表之间改了哪些文件，按路径排：同一次扫描前后都在内存里时用，不用去读节点。 */
export function diffFileMaps(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): ScriptFileChange[] {
  const changes: ScriptFileChange[] = []
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(path)
    const now = after.get(path)
    if (was === now) continue
    const change: ScriptFileChange = { path }
    if (!isUndefined(was)) change.before = was
    if (!isUndefined(now)) change.after = now
    changes.push(change)
  }
  return changes.sort((left, right) => byName(left.path, right.path))
}
