/** 落回前核对的入参。只放类型。 */

import type { SandboxDiff } from './rehearsal-sandbox.js'

/** 给一次落回做核对要的东西。 */
export interface SandboxApplyPrepareInput {
  /** 宿主给的不附文本差量的差量（`diffSandbox({ textDiffs: false })`）；三列永远完整。 */
  diff: SandboxDiff
  /** 模型点名只落这些相对路径；不给就全部。 */
  paths?: readonly string[]
}
