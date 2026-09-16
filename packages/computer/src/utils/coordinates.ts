/** 主屏截图局部坐标与虚拟桌面全局坐标之间的换算，以及回执里坐标字段的投影。 */

import { isPresent, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  ComputerClickOptions,
  ComputerClickResult,
  ComputerMoveOptions,
  ComputerMoveResult,
} from '../types/computer.js'
import type { ComputerClickInput, ComputerPointInput, ResolvedComputerPoint } from '../types/tool.js'

/** 缺截图绑定时给模型的话：主屏坐标只认给出这组坐标的那次截图。 */
function requireSnapshotId(snapshotId: LooseOptional<string>, action: string): string {
  if (!snapshotId)
    throw new AppError(
      'VALIDATION',
      `主屏截图坐标${action}必须携带 computer:screenshot 返回的 snapshotId。请重新截图定位。`
    )
  return snapshotId
}

/** 把移动入参翻成运行时的移动选项；主屏坐标缺截图绑定当场拒绝，不猜、不降级成全局坐标。 */
export function moveOptionsFromInput(input: ComputerPointInput): ComputerMoveOptions {
  if (input.coordinateSpace === 'global') return { coordinateSpace: 'global' }

  return {
    coordinateSpace: 'primary-display',
    snapshotId: requireSnapshotId(input.snapshotId, '移动'),
  }
}

/** 把点击入参翻成运行时的点击选项；主屏坐标缺截图绑定当场拒绝，不猜、不降级成全局坐标。 */
export function clickOptionsFromInput(input: ComputerClickInput): ComputerClickOptions {
  if (input.coordinateSpace === 'global')
    return { button: input.button, count: input.count, coordinateSpace: 'global' }

  return {
    button: input.button,
    count: input.count,
    coordinateSpace: 'primary-display',
    snapshotId: requireSnapshotId(input.snapshotId, '点击'),
  }
}

/** 动作回执里的坐标：局部坐标取模型传进来的那组，全局坐标取运行时真正落下去的那组。 */
export function actionPointFromResult(
  input: { x: number; y: number; coordinateSpace?: string; snapshotId?: string },
  result: ComputerClickResult | ComputerMoveResult
): ResolvedComputerPoint {
  if (input.coordinateSpace === 'global')
    return {
      x: result.x,
      y: result.y,
      localX: input.x,
      localY: input.y,
      coordinateSpace: 'global',
    }

  return {
    x: result.x,
    y: result.y,
    localX: input.x,
    localY: input.y,
    coordinateSpace: 'primary-display',
    displayId: result.displayId,
    snapshotId: input.snapshotId,
  }
}

/** 把运行时回执投影成模型看到的形状：x、y 回到模型传进来的那套坐标，全局坐标另列两格。 */
export function projectComputerPointResult<TResult extends object>(
  result: TResult,
  point: ResolvedComputerPoint
) {
  return {
    ...result,
    x: point.localX,
    y: point.localY,
    coordinateSpace: point.coordinateSpace,
    globalX: point.x,
    globalY: point.y,
    displayId: optionalWhen(isPresent, point.displayId),
    snapshotId: optionalWhen(isPresent, point.snapshotId),
  }
}
