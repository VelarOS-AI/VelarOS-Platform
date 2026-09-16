/** 主屏截图局部坐标与虚拟桌面全局坐标之间的换算，以及回执里坐标字段的投影。 */

import { isPresent, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ComputerToolContext } from '../contract/requires.js'
import type {
  ComputerClickOptions,
  ComputerClickResult,
  ComputerScreenSize,
} from '../types/computer.js'
import type { ComputerClickInput, ComputerPointInput, ResolvedComputerPoint } from '../types/tool.js'

/**
 * 把主屏截图内的局部坐标换算成虚拟桌面全局坐标：越界就拒绝，绝不钳到边上。
 *
 * 工具层的 x、y 是**截图左上角**起算的，运行时收的是全局坐标，多显示器下两者相差一个主屏原点。
 */
export function resolvePrimaryDisplayPoint(
  display: ComputerScreenSize,
  x: number,
  y: number
): ResolvedComputerPoint {
  if (x >= display.width || y >= display.height) {
    throw new AppError(
      'VALIDATION',
      `主屏局部坐标超出截图边界：(${x}, ${y})，有效范围是 x=0-${display.width - 1}、y=0-${display.height - 1}。请重新截图定位。`
    )
  }

  return {
    x: display.originX + x,
    y: display.originY + y,
    localX: x,
    localY: y,
    coordinateSpace: 'primary-display',
    displayId: display.displayId,
  }
}

/** 全局坐标不需要换算：局部坐标与全局坐标是同一组数。 */
export function resolveGlobalPoint(x: number, y: number): ResolvedComputerPoint {
  return { x, y, localX: x, localY: y, coordinateSpace: 'global' }
}

/** 把模型给的点解析成全局坐标：全局坐标原样用，主屏坐标要先问一次当前屏幕几何。 */
export async function resolveComputerPoint(
  input: ComputerPointInput,
  ctx: ComputerToolContext
): Promise<ResolvedComputerPoint> {
  if (input.coordinateSpace === 'global') return resolveGlobalPoint(input.x, input.y)

  const display = await ctx.computer.screenSize()
  ctx.abortSignal.throwIfAborted()
  return resolvePrimaryDisplayPoint(display, input.x, input.y)
}

/** 把点击入参翻成运行时的点击选项；主屏坐标缺截图绑定当场拒绝，不猜、不降级成全局坐标。 */
export function clickOptionsFromInput(input: ComputerClickInput): ComputerClickOptions {
  if (input.coordinateSpace === 'global')
    return { button: input.button, count: input.count, coordinateSpace: 'global' }

  if (!input.snapshotId)
    throw new AppError(
      'VALIDATION',
      '主屏截图坐标点击必须携带 computer:screenshot 返回的 snapshotId。请重新截图定位。'
    )

  return {
    button: input.button,
    count: input.count,
    coordinateSpace: 'primary-display',
    snapshotId: input.snapshotId,
  }
}

/** 点击回执里的坐标：局部坐标取模型传进来的那组，全局坐标取运行时真正点下去的那组。 */
export function clickPointFromResult(
  input: ComputerClickInput,
  result: ComputerClickResult
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
