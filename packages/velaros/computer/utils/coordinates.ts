/** 把核对过的坐标交给运行时，再把运行时的回执投影回模型给的那套坐标。换算与截图绑定的校验都在 helper 里，这里一概不算。 */

import { isPresent, optionalWhen } from '@velaros-ai/core'

import type {
  ComputerClickInput,
  ComputerClickOptions,
  ComputerClickResult,
  ComputerMoveOptions,
  ComputerMoveResult,
  ComputerPoint,
} from '../types/computer.js'
import type { ResolvedComputerPoint } from '../types/coordinates.js'

/** 把移动的坐标翻成运行时的移动选项：按截图的坐标连同截图绑定原样交下去。 */
export function moveOptionsFromInput(point: ComputerPoint): ComputerMoveOptions {
  if (point.coordinateSpace === 'global') return { coordinateSpace: 'global' }
  return { coordinateSpace: 'primary-display', snapshotId: point.snapshotId }
}

/** 把点击翻成运行时的点击选项：按截图的坐标连同截图绑定原样交下去，按键与连击次数照带。 */
export function clickOptionsFromInput(input: ComputerClickInput): ComputerClickOptions {
  if (input.coordinateSpace === 'global')
    return { button: input.button, count: input.count, coordinateSpace: 'global' }
  return {
    button: input.button,
    count: input.count,
    coordinateSpace: 'primary-display',
    snapshotId: input.snapshotId,
  }
}

/** 动作回执里的坐标：局部坐标取模型传进来的那组，全局坐标取运行时真正落下去的那组。 */
export function actionPointFromResult(
  point: ComputerPoint,
  result: ComputerClickResult | ComputerMoveResult
): ResolvedComputerPoint {
  if (point.coordinateSpace === 'global')
    return { x: result.x, y: result.y, localX: point.x, localY: point.y, coordinateSpace: 'global' }
  return {
    x: result.x,
    y: result.y,
    localX: point.x,
    localY: point.y,
    coordinateSpace: 'primary-display',
    displayId: result.displayId,
    snapshotId: point.snapshotId,
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
