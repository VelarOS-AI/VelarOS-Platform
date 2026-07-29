/**
 * 内容寻址哈希原语：provider 请求编译链路里多处（指纹前缀、工具载荷去重、
 * 折叠桩内容寻址、历史改写指纹）共用同一份 sha256 与其短哈希投影，单源在此。
 */
import { createHash } from 'node:crypto'

/** 全量 sha256 十六进制摘要，用于工具载荷内容寻址与指纹种子。 */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 短哈希：取 sha256 前 16 位，用于指纹与改写签名等无需抗碰撞强度的场景。 */
export function shortHash(text: string): string {
  return sha256(text).slice(0, 16)
}
