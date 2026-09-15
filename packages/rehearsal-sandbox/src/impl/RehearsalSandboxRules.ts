/**
 * 落回前的核对与确认请求：`RehearsalSandboxRules` 与整个进程唯一的 `rehearsalSandboxRules`。接口 `RehearsalSandboxRulesApi` 在本文件的类上方。
 */

import { createApprovalOperationKey, createManualApprovalOptions } from '@velaros-ai/agent/tool-contract'
import { isEmpty, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { RehearsalSandboxLimits, SandboxApplyOperationKind } from '../contract/constants.js'
import type { SandboxApplyPrepareInput, SandboxApplyRequest } from '../types/apply.js'
import type { SandboxSelection } from '../types/rehearsal-sandbox.js'
import { buildSandboxApplyConfirmationMessage, selectSandboxChanges } from '../utils/apply.js'

/**
 * 演练沙箱落回前的规则，实例是 `rehearsalSandboxRules`；system:sandbox 与 project:sandbox 共用，保证「确认的就是要落的」。
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
}

export class RehearsalSandboxRules implements RehearsalSandboxRulesApi {
  public select(changes: { created: readonly string[]; modified: readonly string[]; deleted: readonly string[] }, paths: LooseOptional<readonly string[]>): SandboxSelection {
    return selectSandboxChanges(changes, paths)
  }

  public prepareApply(input: SandboxApplyPrepareInput): Nullable<SandboxApplyRequest> {
    const { diff } = input
    if (diff.truncated) throw new AppError('VALIDATION', '宿主给的差量被截断了，没法对着完整的改动向用户确认，什么都没写。')
    const selection = selectSandboxChanges(diff, input.paths)
    if (!isEmpty(selection.unknown)) {
      throw new AppError('VALIDATION', `这些路径在沙箱里没有变化，什么都没写：${selection.unknown.slice(0, RehearsalSandboxLimits.reportedPaths).join('、')}`)
    }
    if (isEmpty(selection.created) && isEmpty(selection.modified) && isEmpty(selection.deleted)) return null
    const sensitive = input.isSensitive ? [...selection.created, ...selection.modified, ...selection.deleted].filter((path) => input.isSensitive?.(path)) : []
    return {
      selection,
      message: buildSandboxApplyConfirmationMessage(input.targetLabel, selection, sensitive, input.closingNote),
      options: createManualApprovalOptions({
        approvalRisk: 'high',
        riskScope: input.riskScope,
        operation: {
          key: createApprovalOperationKey(SandboxApplyOperationKind, {
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
}

/** 整个进程只有一份的落回规则。 */
export const rehearsalSandboxRules: RehearsalSandboxRulesApi = new RehearsalSandboxRules()
