// 远程节点客户端凭据的落点计算；只算路径，不碰文件内容。
import { homedir } from 'node:os'
import { join } from 'node:path'

import { isNonBlankString } from '@velaros-ai/core'

/**
 * 默认落点:每台远端主机一份,按 slug 分文件,互不影响。
 *
 * 用 `os.homedir()` 而不是 `process.env.HOME`:Windows 通常没有 HOME,原来的 `'/tmp'` 兜底
 * 会把 Ed25519 私钥写到当前盘根的 `\tmp\.velaros\`——NTFS 上 0600 不生效,同机其他用户可读。
 * `homedir()` 在 Windows 走 USERPROFILE,在类 Unix 上 HOME 缺失时退回口令数据库。
 */
export function defaultRemoteNodeCredentialsPath(
  hostSlug: string,
  home: string = homedir()
): string {
  const root = isNonBlankString(home) ? home.trim() : homedir()
  return join(root, '.velaros', 'remote-nodes', `${hostSlug}.json`)
}
