/**
 * Node 文件 IO 的路径与落盘辅助：解真实路径、读权限位、把内容刷到盘上。
 *
 * 这些函数直接碰 `node:fs`，只给 Node 实现用；端口本身与内存实现都不引它。
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { basename, dirname, join as joinPath, resolve } from 'node:path'

import { isEmpty, isNotNull } from '@velaros-ai/core'

import { MemoryTuning } from '../tuning'

/** 读一个路径解开符号链接后的真实路径；解不开返回 null，由调用方继续往上找。 */
export function readRealPath(path: string): Nullable<string> {
  try {
    return realpathSync(path)
  } catch {
    // arch-guard:silent-catch-ok 路径不存在或读不了都只说明「这一层还解不开」，由调用方继续往上找。
    return null
  }
}

/** 读一个符号链接指向哪里；不是符号链接返回 null。 */
export function readLinkTarget(path: string): Nullable<string> {
  try {
    return readlinkSync(path)
  } catch {
    // arch-guard:silent-catch-ok 不是符号链接就没有目标，与「解不开」同一处置。
    return null
  }
}

/**
 * `@velaros-ai/core` 的 `resolveRealPath` 的同步版（端口是同步的，异步实现接不进来）：
 * 解开路径上所有的符号链接；路径还不存在时解开最近一个存在的祖先，再把余下各段接回；
 * 途中或末端是悬空符号链接时照它指向的路径继续解。链接成环、读不了链接时返回规整后的字面路径。
 */
export function resolveRealPathSync(path: string): string {
  const literal = resolve(path)
  const trailing: string[] = []
  let current = literal
  let hops = 0
  while (true) {
    const real = readRealPath(current)
    if (isNotNull(real)) return isEmpty(trailing) ? real : joinPath(real, ...[...trailing].reverse())
    const target = readLinkTarget(current)
    if (isNotNull(target)) {
      hops += 1
      if (hops > MemoryTuning.files.danglingLinkHops) return literal
      current = resolve(dirname(current), target)
      continue
    }
    const parent = dirname(current)
    if (parent === current) return literal
    trailing.push(basename(current))
    current = parent
  }
}

/** 已有文件的权限位；不存在（或读不到）时返回 undefined，让 umask 决定新文件的权限。 */
export function readFileMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777
  } catch {
    // arch-guard:silent-catch-ok 文件还不存在是最常见的一支，没有权限位可恢复。
    return undefined
  }
}

/** 把文件或目录的内容刷到盘上；平台不支持（Windows 的目录 fsync）时忽略。 */
export function syncPath(path: string): void {
  let handle: Nullable<number> = null
  try {
    handle = openSync(path, 'r')
    fsyncSync(handle)
  } catch {
    // arch-guard:silent-catch-ok 目录 fsync 在部分平台不被支持；刷不动只影响耐久性，不影响这次写入的正确性。
  } finally {
    if (isNotNull(handle)) closeSync(handle)
  }
}
