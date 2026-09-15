/**
 * 命令策略：`SystemCommandPolicy` 与整个进程唯一的 `systemCommandPolicy`。接口见 `interface/provides.ts` 的 `SystemCommandPolicyApi`。
 * 判定逻辑本身是纯函数，在 `utils/command-policy.ts`；这个类是它对外的唯一出口，`system:run` 和宿主用的是同一份。
 */

import type { SystemCommandExecutionPlan } from '../types/commands.js'
import { analyzeCommandExecution, isSystemShellCommandReadOnly } from '../utils/command-policy.js'

/**
 * 执行前给 shell 命令分类的判定，实例是 `systemCommandPolicy`。`system:run` 用的就是这一份，宿主做审批界面、无人值守放行时也用它，保证判定一致。
 *
 * 只读判定是白名单加整体否决：命令名不在只读名单、或出现重定向、子 shell、后台符、换行，整条判非只读。
 * 危险判定是黑名单：递归删除、丢弃未提交改动的 Git 操作、mkfs、dd、shutdown、sudo 等；漏判只是少弹一次确认，真正的授权门在宿主的审批端口。
 */
export interface SystemCommandPolicyApi {
  /** 给一条命令做执行前分类：是否只读、是否危险及原因、是否该转入后台及原因、是否要用户确认，以及命令里可能占用的端口。 */
  analyze(command: string): SystemCommandExecutionPlan
  /** 这条命令是否在任何参数组合下都不写东西；判成只读的命令才允许和别的命令并发执行。 */
  isReadOnly(command: string): boolean
}

export class SystemCommandPolicy implements SystemCommandPolicyApi {
  public analyze(command: string): SystemCommandExecutionPlan {
    return analyzeCommandExecution(command)
  }

  public isReadOnly(command: string): boolean {
    return isSystemShellCommandReadOnly(command)
  }
}

/** 整个进程只有一份的命令策略。 */
export const systemCommandPolicy: SystemCommandPolicyApi = new SystemCommandPolicy()
