/** 解析宿主的原生 Node 执行文件。 */

import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { isUndefined } from '@velaros-ai/core'

/** 当前运行时是不是 node 本身。 */
function runningOnNode(): boolean {
  return isUndefined((process.versions as Record<string, string | undefined>).bun)
}

/**
 * 解析出 node 的路径：本来就在 node 上就用自己，否则按 PATH 找。
 * 找不到返回 null——找不到就该拒绝执行，而不是退回一个不认旗标的运行时接着跑。
 */
export function resolveNodeExecutable(): Nullable<string> {
  if (!isUndefined((process.versions as Record<string, string | undefined>).electron)) return null
  if (runningOnNode()) return process.execPath
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}
