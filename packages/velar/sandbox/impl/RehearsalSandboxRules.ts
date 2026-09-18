/**
 * 落回前的核对与确认请求、镜像里危险命令的确认请求：`RehearsalSandboxRules` 与整个进程唯一的 `rehearsalSandboxRules`。接口 `RehearsalSandboxRulesApi` 在本文件的类上方。
 */

import { agentToolContracts } from '@velaros-ai/agent/tool-contract'
import { isEmpty, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ShellCommandApprovalRequest } from '@velaros-ai/velar/shell'
import { shellCommandApproval, shellCommandPolicy } from '@velaros-ai/velar/shell'

import { RehearsalSandboxLimits, SandboxApplyOperationKind } from '../contract/constants.js'
import type { SandboxApplyPrepareInput, SandboxApplyRequest } from '../types/apply.js'
import type { SandboxSelection } from '../types/rehearsal-sandbox.js'
import { buildSandboxApplyConfirmationMessage, selectSandboxChanges } from '../utils/apply.js'

/**
 * 演练沙箱落回前的规则，实例是 `rehearsalSandboxRules`；`velar:sandbox` 的 apply 与 run 用它，保证「确认的就是要落的」、镜像里的危险命令照常先问。
 * 只出核对结果与确认请求：交给哪个审批端口、被拒了是抛错还是返回结构化拒绝、落回之前还要不要别的授权，由空间自己决定。
 */
export interface RehearsalSandboxRulesApi {
  /** 按点名的相对路径筛三列；不点名就全部。点名了、三列里都没有的路径放进 unknown。路径里的反斜杠当 /，开头的 ./ 去掉。 */
  select(changes: { created: readonly string[]; modified: readonly string[]; deleted: readonly string[] }, paths: LooseOptional<readonly string[]>): SandboxSelection
  /**
   * 落回前的核对与确认请求。差量必须是不截断的完整差量，宿主给了截断的就拒绝；点名了没有变化的路径就拒绝——两种拒绝都在问用户之前，什么都没写（VALIDATION）。
   * 镜像里什么都没变返回 null（调用方回「什么都没落」）。否则按完整的三列算条数、预览和要点名的敏感路径，给出确认文案与审批选项：
   * 高风险、必须用户亲自点、不可记忆，操作身份含沙箱 id、差量指纹和三列条数。确认之后把同一个指纹交给宿主落回，镜像又变过就整批不落。
   */
  prepareApply(input: SandboxApplyPrepareInput): Nullable<SandboxApplyRequest>
  /**
   * 镜像里跑的命令要不要先问用户。危险命令（递归删除、丢未提交改动的 git、提权这类，判定用 `velar:shell` 的那一套）照常问：
   * 它写不出镜像，但用户仍然要看得到脚本在做什么（ADR 0006）。不危险返回 null；危险就给出确认文案与审批选项——
   * 高风险、必须用户亲自点、不可记忆，操作身份与 `velar:shell` 同一个种类，工作目录记成这个沙箱。
   */
  prepareRun(sandboxId: string, command: string): Nullable<ShellCommandApprovalRequest>
}

export class RehearsalSandboxRules implements RehearsalSandboxRulesApi {
  /** 镜像里危险命令的风险分类；宿主靠 `:dangerous` 后缀认出这是每次都要人点的硬门。 */
  private static readonly CommandRiskScope = 'sandbox-command:dangerous'

  public select(changes: { created: readonly string[]; modified: readonly string[]; deleted: readonly string[] }, paths: LooseOptional<readonly string[]>): SandboxSelection {
    return selectSandboxChanges(changes, paths)
  }

  public prepareApply(input: SandboxApplyPrepareInput): Nullable<SandboxApplyRequest> {
    const { diff } = input
    const selection = selectSandboxChanges(diff, input.paths)
    if (!isEmpty(selection.unknown)) {
      throw new AppError('VALIDATION', `这些路径在沙箱里没有变化，什么都没写：${selection.unknown.slice(0, RehearsalSandboxLimits.reportedPaths).join('、')}`)
    }
    if (isEmpty(selection.created) && isEmpty(selection.modified) && isEmpty(selection.deleted)) return null
    const sensitive = input.isSensitive ? [...selection.created, ...selection.modified, ...selection.deleted].filter((path) => input.isSensitive?.(path)) : []
    return {
      selection,
      message: buildSandboxApplyConfirmationMessage(input.targetLabel, selection, sensitive, input.closingNote),
      options: agentToolContracts.createManualApprovalOptions({
        approvalRisk: 'high',
        riskScope: input.riskScope,
        operation: {
          key: agentToolContracts.createApprovalOperationKey(SandboxApplyOperationKind, {
            sandboxId: diff.sandboxId,
            fingerprint: toNullable(diff.fingerprint),
            created: selection.created.length,
            modified: selection.modified.length,
            deleted: selection.deleted.length,
          }),
          label: `把演练沙箱的改动落回 ${input.targetLabel}`,
          target: diff.source,
        },
      }),
    }
  }

  public prepareRun(sandboxId: string, command: string): Nullable<ShellCommandApprovalRequest> {
    const plan = shellCommandPolicy.analyze(command)
    if (!plan.isDangerous) return null
    const mirror = `演练沙箱 ${sandboxId}`
    return shellCommandApproval.dangerous({ command, plan, cwd: mirror, background: false, scopeLabel: `${mirror} 的镜像里`, riskScope: RehearsalSandboxRules.CommandRiskScope })
  }
}

/** 整个进程只有一份的落回核对与确认请求。 */
export const rehearsalSandboxRules: RehearsalSandboxRulesApi = new RehearsalSandboxRules()
