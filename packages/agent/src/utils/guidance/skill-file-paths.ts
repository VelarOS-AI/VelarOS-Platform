/**
 * 技能目录里的 id 收敛：id 来自 IPC 与模型，落到路径拼接前必须先在这里削一刀。
 */

import { basename } from 'node:path'

/**
 * 把一个技能 id 收敛成安全的单段文件名：去首尾空白后只取 `basename`，
 * 于是 `../../etc/passwd` 这类写法拼不出技能目录之外的路径。
 * 传进来全是分隔符时会得到空串，调用方据此当「没给 id」处理。
 * 读、写、删、启停任何一处落到路径拼接的 id 都必须先过它，漏一处就是一个目录穿越口子。
 */
export function normalizeSkillFileId(id: string): string {
  return basename(id.trim())
}
