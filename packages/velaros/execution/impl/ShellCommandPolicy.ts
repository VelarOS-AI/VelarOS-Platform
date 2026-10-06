/**
 * 命令策略：`ShellCommandPolicy` 与整个进程唯一的 `shellCommandPolicy`。接口 `ShellCommandPolicyApi` 在本文件的类上方。
 * 判定逻辑本身是纯函数，在 `utils/command-policy.ts`；这个类是它对外的唯一出口。
 */

import type {
  ShellCommandConcurrencyInput,
  ShellCommandConcurrencyOptions,
  ShellCommandPlan,
} from '../types/shell-command.js'
import {
  analyzeCommandExecution,
  isParallelCommandExecutionSafe,
  isShellCommandReadOnly,
} from '../utils/command-policy.js'

/**
 * 执行前给一条 shell 命令分类，实例是 `shellCommandPolicy`。`execution 宿主` 的 run、演练沙箱里的 run、项目空间的 run、宿主的审批界面与无人值守放行都用这一份，判定处处一致。
 *
 * 只读判定是白名单加整体否决：命令名不在只读名单，或者带能写盘、能执行别的程序的参数、前缀、环境变量赋值，或者出现重定向、子 shell、后台符、换行，整条判非只读。
 * 危险判定是黑名单，只收成片毁掉、找不回来的：递归/批量删除、清掉未跟踪文件、强推、mkfs、dd、shutdown 等；只查真会执行的部分（heredoc 写进文件的正文、引号里的文字不算）。漏判只是少弹一次确认。
 */
export interface ShellCommandPolicyApi {
  /** 给一条命令做执行前分类：是否只读、是否危险及理由、是否该转后台及理由，以及命令里可能占用的端口。 */
  analyze(command: string): ShellCommandPlan
  /** 这条命令是否在任何参数组合下都不写盘、不执行别的程序；判成只读的才允许并发、无人值守放行。 */
  isReadOnly(command: string): boolean
  /** 一次命令调用能不能与别的调用并发：只读、不危险、不转后台；optIn（缺省为真）时还要求入参显式写了 parallel: true。 */
  isParallelSafe(
    input: ShellCommandConcurrencyInput,
    options?: ShellCommandConcurrencyOptions
  ): boolean
}

export class ShellCommandPolicy implements ShellCommandPolicyApi {
  public analyze(command: string): ShellCommandPlan {
    return analyzeCommandExecution(command)
  }

  public isReadOnly(command: string): boolean {
    return isShellCommandReadOnly(command)
  }

  public isParallelSafe(
    input: ShellCommandConcurrencyInput,
    options: ShellCommandConcurrencyOptions = {}
  ): boolean {
    return isParallelCommandExecutionSafe(input, options.optIn ?? true)
  }
}

/** 整个进程只有一份的命令策略。 */
export const shellCommandPolicy: ShellCommandPolicyApi = new ShellCommandPolicy()
