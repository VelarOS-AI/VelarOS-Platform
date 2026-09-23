import { isEmpty } from '@velaros-ai/core'

import { AgentsLimits, InteractionLimits } from '../contract/constants.js'

/** 交互说明的长度核对：空的或超过上限的直接拒绝，一次交互都不发起。 */
export function checkInteractionMessage(message: string): void {
  if (isEmpty(message) || message.length > InteractionLimits.messageChars)
    throw Object.assign(new Error(`message 需要 1 到 ${InteractionLimits.messageChars} 个字符`), {
      code: 'VALIDATION',
    })
}

/** 派给子任务的材料条数核对：超过上限直接拒绝，子任务不会启动。 */
export function checkAgentMaterials(materials: Optional<readonly unknown[]>): void {
  if ((materials?.length ?? 0) > AgentsLimits.materials)
    throw Object.assign(new Error(`materials 最多 ${AgentsLimits.materials} 条`), {
      code: 'VALIDATION',
    })
}
