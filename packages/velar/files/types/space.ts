/**
 * 空间端口上流动的数据：要用户确认的请求、一批写入里的一项。
 * 带 `Buffer` 与 agent 的确认选项，所以不在可移植文件里；公开签名用到它们，从根入口导出。
 */

import type { ToolConfirmationDecisionOptions } from '@velaros-ai/agent/contracts'
import type { ExpectedBytes } from '@velaros-ai/text-files/contracts'

/** 空间要操作方法先问用户的一件事：确认文案与审批选项。操作方法交给审批端口去问，被拒就不做。 */
export interface FileConfirmation {
  message: string
  options: ToolConfirmationDecisionOptions
}

/**
 * 一批写入里的一项：往 target 写这些字节；bytes 为 null 是删掉这个文件（撤回一次新建时）。
 * 给了 expected 就在落盘时核对磁盘上还是它（或者它仍不存在），不是就不写。
 */
export interface FileWrite {
  target: string
  bytes: Nullable<Buffer>
  expected?: ExpectedBytes
}
