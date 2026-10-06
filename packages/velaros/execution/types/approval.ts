/** 危险命令审批请求的入参与结果。只放类型。 */

import type { ToolConfirmationDecisionOptions } from '@velaros-ai/kernel/contracts'

import type { ShellCommandPlan } from './shell-command.js'

/** 给一条危险命令构造审批请求要的东西。 */
export interface ShellCommandApprovalInput {
  /** 模型给的原始命令，确认卡上原样展示。 */
  command: string
  /** 这条命令执行前的分类（`shellCommandPolicy.analyze` 的结果）。 */
  plan: ShellCommandPlan
  /** 解析好的绝对工作目录；演练沙箱的镜像里跑的写成「演练沙箱 <id>」（镜像根只有宿主知道）。 */
  cwd: string
  /** 这次会不会转后台跑。 */
  background: boolean
  /** 确认文案里「在哪儿执行」那一段，例如「当前项目」「系统运行环境」。 */
  scopeLabel: string
  /** 空间自己的风险分类，例如 `project-command:dangerous`；宿主靠 `:dangerous` 后缀认出硬门。 */
  riskScope: string
}

/** 一次危险命令审批请求：交给审批端口的文案和选项。 */
export interface ShellCommandApprovalRequest {
  /** 确认文案：命令、理由、递归删除时的仓库提醒、是否后台、可能占用的端口。 */
  message: string
  /** 高风险、必须用户亲自点、不可记忆的确认选项，带跨入口共享的操作身份。 */
  options: ToolConfirmationDecisionOptions
}
