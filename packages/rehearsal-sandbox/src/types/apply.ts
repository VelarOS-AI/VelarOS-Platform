/** 落回前核对与确认请求的入参与结果。只放类型。 */

import type { ToolConfirmationDecisionOptions } from '@velaros-ai/agent/contracts'

import type { SandboxDiff, SandboxSelection } from './rehearsal-sandbox.js'

/** 给一次落回做核对、构造确认请求要的东西。 */
export interface SandboxApplyPrepareInput {
  /** 宿主给的不截断、不附文本差量的完整差量（`diffSandbox({ maxFiles: Number.MAX_SAFE_INTEGER, textDiffs: false })`）。 */
  diff: SandboxDiff
  /** 模型点名只落这些相对路径；不给就全部。 */
  paths?: readonly string[]
  /** 确认文案里「落回哪儿」那一段，例如源目录本身，或「项目 <源目录>」。 */
  targetLabel: string
  /** 确认文案的最后一句：空间自己的提醒，例如删除和覆盖无法撤销、不经过撤销账本。 */
  closingNote: string
  /** 空间自己的风险分类，例如 `system-sandbox:apply`。 */
  riskScope: string
  /** 空间要特别点名的路径（系统敏感路径、凭证文件）：参数是相对源目录的路径（要绝对路径就自己拼上差量里的 source）；不给就不点名。 */
  isSensitive?: (relativePath: string) => boolean
}

/** 一个空间落回时的政策：`prepareApply` 的入参里跟这次改动无关、只跟空间有关的那几项，由宿主按空间给。 */
export type SandboxApplyPolicy = Omit<SandboxApplyPrepareInput, 'diff' | 'paths'>

/** 一次落回的确认请求：筛出来的三列、交给审批端口的文案和选项。 */
export interface SandboxApplyRequest {
  /** 这次要落的三列（完整的，不截断）。 */
  selection: SandboxSelection
  /** 确认文案：落回哪儿，三列的条数与前几条路径，要点名的敏感路径，空间自己的提醒。 */
  message: string
  /** 高风险、必须用户亲自点、不可记忆的确认选项；操作身份含沙箱 id、差量指纹与三列条数。 */
  options: ToolConfirmationDecisionOptions
}
