/**
 * 危险命令的审批请求：`ShellCommandApproval` 与整个进程唯一的 `shellCommandApproval`。接口 `ShellCommandApprovalApi` 在本文件的类上方。
 */

import { createApprovalOperationKey, createManualApprovalOptions } from '@velaros-ai/agent/tool-contract'

import { ShellCommandOperationKind } from '../contract/constants.js'
import type { ShellCommandApprovalInput, ShellCommandApprovalRequest } from '../types/approval.js'
import { buildBackgroundCommandConfirmationMessage } from '../utils/command-policy.js'

/**
 * 构造危险命令的审批请求，实例是 `shellCommandApproval`。只出「请求」：确认文案和选项；交给哪个审批端口、被拒了是抛错还是返回结构化拒绝，由空间自己决定。
 * 选项是高风险、必须用户亲自点、不可按类记忆的确认——审批端口会用操作身份覆盖 riskScope，只有 requireManualApproval 能让宿主在任何档位都弹卡；
 * 操作身份跨工具一致（种类 `shell-command`，参数是去掉首尾空白的命令、工作目录、前台还是后台）。
 */
export interface ShellCommandApprovalApi {
  /** 给一条危险命令构造审批请求：确认文案加高风险手动确认选项，选项里带跨工具共享的操作身份，标签是原始命令，目标是工作目录。 */
  dangerous(input: ShellCommandApprovalInput): ShellCommandApprovalRequest
}

export class ShellCommandApproval implements ShellCommandApprovalApi {
  public dangerous(input: ShellCommandApprovalInput): ShellCommandApprovalRequest {
    return {
      message: buildBackgroundCommandConfirmationMessage(input.command, input.plan, input.scopeLabel, input.background),
      options: createManualApprovalOptions({
        approvalRisk: 'high',
        riskScope: input.riskScope,
        operation: {
          key: createApprovalOperationKey(ShellCommandOperationKind, { command: input.command.trim(), cwd: input.cwd, background: input.background }),
          label: input.command,
          target: input.cwd,
        },
      }),
    }
  }
}

/** 整个进程只有一份的危险命令审批请求构造器。 */
export const shellCommandApproval: ShellCommandApprovalApi = new ShellCommandApproval()
