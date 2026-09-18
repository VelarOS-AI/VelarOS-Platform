/**
 * 空间端口上流动的数据：一批写入里的一项。
 * 带 `Buffer`，所以不在可移植文件里；公开签名用到它，从根入口导出。
 */

import type { ExpectedBytes } from '@velaros-ai/text-files/contracts'

/**
 * 一批写入里的一项：往 target 写这些字节；bytes 为 null 是删掉这个文件（撤回一次新建时）。
 * 给了 expected 就在落盘时核对磁盘上还是它（或者它仍不存在），不是就不写。
 */
export interface FileWrite {
  target: string
  bytes: Nullable<Buffer>
  expected?: ExpectedBytes
}
