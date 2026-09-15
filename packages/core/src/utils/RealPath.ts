/**
 * 判定安全用的真实路径（Node 专用，经 `@velaros-ai/core/utils/RealPath` 引入）：路径还不存在、途中有悬空符号链接时也能算出写入会落到哪里。
 */

import { readlink, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { isNotNull } from '../typeGuards.js'

import { isEmpty } from './array.js'

/** 悬空符号链接最多追几跳；超过（多半是链接成环）就不再追。 */
const MaxDanglingLinkHops = 40

/**
 * 解开路径上所有的符号链接，给判定「在不在根里」「是不是敏感路径」用。
 * 路径还不存在时解开最近一个存在的祖先，再把余下各段接回；途中或末端是悬空的符号链接时照它指向的路径继续解，
 * 这样按结果判定的就是写入真正会落到的位置，而不是链接本身。链接成环、读不了链接时返回规整后的字面路径。
 */
export async function resolveRealPath(path: string): Promise<string> {
  const literal = resolve(path)
  const trailing: string[] = []
  let current = literal
  let hops = 0
  while (true) {
    const real = await realpath(current).catch(() => null)
    if (isNotNull(real)) return isEmpty(trailing) ? real : join(real, ...[...trailing].reverse())
    const target = await readlink(current).catch(() => null)
    if (isNotNull(target)) {
      hops += 1
      if (hops > MaxDanglingLinkHops) return literal
      current = resolve(dirname(current), target)
      continue
    }
    const parent = dirname(current)
    if (parent === current) return literal
    trailing.push(basename(current))
    current = parent
  }
}
