// AgentGoalService 用到的纯函数（不碰实例状态）。
import { isNumber, isPlainObject, isString } from '@velaros-ai/core'

import type { AgentGoal } from '../../types/product-session.js'

/** 判断一条落盘记录是不是活跃目标。 */
export function isGoal(value: unknown): value is AgentGoal {
  return isRecord(value)
    && isString(value.id)
    && isString(value.sessionId)
    && isString(value.objective)
    && value.status === 'active'
    && isNumber(value.createdAt)
    && isNumber(value.updatedAt)
}

/** 判断一条入参是不是目标的终态更新（完成、受阻或取消）。 */
export function isGoalUpdate(value: unknown): value is Pick<AgentGoal, 'id' | 'status'> {
  return isRecord(value)
    && isString(value.id)
    && (value.status === 'complete' || value.status === 'blocked' || value.status === 'cancelled')
}

/** 判断是不是普通对象（落盘记录的最外层形状）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value)
}
