/**
 * 项目空间要宿主给的那些数据里，引用到 shell 能力数据（命令种类、命令回执）的那几个：在镜像里跑命令的选项。
 * 要从 `@velaros-ai/velar/shell/contracts` 取类型，所以不在可移植文件里；公开签名用到它，从根入口导出。
 */

import type { ShellCommandKind } from '@velaros-ai/velar/shell/contracts'

/** 在镜像里跑一条命令：宿主把它约束在镜像根之内。`shell` 与跑普通命令时的同义、同一套规矩。 */
export interface ProjectSandboxRunOptions {
  sandboxId: string
  command: string
  shell?: ShellCommandKind
  timeoutMs?: number
  maxOutputChars?: number
}
