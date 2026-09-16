// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 域:远端身份到本地身份的命名换算——主机名收敛、能力 id 与工具名的本地化。
//
// 这三件都只看字符串,不看连接状态,所以留在 utils:投影类只负责组装清单,命名规则改一处,
// 两端与 Agent 主干看到的名字跟着一起变。
import { createHash } from 'node:crypto'

import { isNonBlankString } from '@velaros-ai/core'

/**
 * 把人给的主机名收敛成 `[a-z0-9-]+`。
 *
 * 全非 ASCII 的名字(中文主机名很常见)归一化后会空掉,这时用名字摘要兜底而不是报错:
 * id 需要的是唯一与稳定,不是可读——可读性由 `hostName` 自己承担。
 */
export function slugifyRemoteHostName(hostName: string): string {
  const replaced = hostName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
  let start = 0
  let end = replaced.length
  while (replaced[start] === '-') start += 1
  while (end > start && replaced[end - 1] === '-') end -= 1
  const slug = replaced.slice(start, end)
  if (isNonBlankString(slug)) return slug
  return `host-${createHash('sha256').update(hostName).digest('hex').slice(0, 8)}`
}

/** 远端 id 的本地化:`velaros.system` → `velaros.remote.<slug>.system`。 */
export function namespaceRemoteId(hostSlug: string, remoteId: string): string {
  const tail = remoteId.startsWith('velaros.')
    ? remoteId.slice('velaros.'.length)
    : remoteId
  return `velaros.remote.${hostSlug}.${tail}`
}

/** 工具名的本地化:`<hostSlug>:<toolName>`,模型看得见是哪台机器在干活。 */
export function namespaceRemoteToolName(
  hostSlug: string,
  toolName: string,
): string {
  return `${hostSlug}:${toolName}`
}
