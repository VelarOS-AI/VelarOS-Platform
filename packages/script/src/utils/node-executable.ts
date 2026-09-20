/**
 * 找一个**真的 node** 来起隔离进程。
 *
 * 为什么不能直接用 `process.execPath`：`child_process.fork` 缺省就拿它起子进程，而宿主跑在 bun 下时
 * 它是 bun 的可执行文件。`--permission` 是 node 的旗标，bun 直接忽略——命令行看着完全正常，隔离却一点没生效。
 * 这一条实测栽过：程序在 bun 起的子进程里把 `/etc/hosts` 整个读了出来。
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
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
  if (runningOnNode()) return process.execPath
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** 隔离进程引导脚本的绝对路径；除它之外不放开任何文件读取，程序源码走 IPC 不落盘。 */
export function resolveChildPath(): string {
  return createRequire(import.meta.url).resolve('../../bin/script-child.mjs')
}
