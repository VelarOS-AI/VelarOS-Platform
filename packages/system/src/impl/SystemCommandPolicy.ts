/**
 * 命令策略：`SystemCommandPolicy` 与整个进程唯一的 `systemCommandPolicy`。接口见 `interface/provides.ts` 的 `SystemCommandPolicyApi`。
 * 判定逻辑本身是纯函数，在 `utils/command-policy.ts`；这个类是它对外的唯一出口，`system:run` 和宿主用的是同一份。
 */

import type { SystemCommandExecutionPlan } from '../contract/commands.js'
import type { SystemCommandPolicyApi } from '../interface/provides.js'
import { analyzeCommandExecution, isSystemShellCommandReadOnly } from '../utils/command-policy.js'

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
