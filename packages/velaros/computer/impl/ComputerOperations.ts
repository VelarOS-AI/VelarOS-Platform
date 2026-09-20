/**
 * 桌面控制能力（`velaros:computer`）的操作：`ComputerOperations` 与整个进程唯一的 `computerOperations`。接口 `ComputerOperationsApi` 在本文件的类上方。
 * 一份实现挂在哪个空间都一样，空间之间的差别全在调用上下文里的端口 `ComputerSpacePort` 与交图通道上。
 */

import { AppError } from '@velaros-ai/core/error'

import type { ComputerOperationContext } from '../contract/requires.js'
import type {
  ComputerClicked,
  ComputerClickInput,
  ComputerKeyInput,
  ComputerKeyResult,
  ComputerMoved,
  ComputerPoint,
  ComputerSnapshot,
  ComputerTypeInput,
  ComputerTypeResult,
} from '../types/computer.js'
import { requireComputerAvailable } from '../utils/availability.js'
import { actionPointFromResult, clickOptionsFromInput, moveOptionsFromInput, projectComputerPointResult } from '../utils/coordinates.js'
import { clickInput, keyInput, pointInput, typeInput } from '../utils/input.js'

/**
 * @AgentView
 * 桌面控制：看用户的主屏幕，在整台机器上移动指针、点击、输入文字、按组合键。
 * 先 screenshot：图交给你看，返回值里有 snapshotId；之后按这张图上量出的坐标 move、click 时原样带上它——helper 在真正动手前核对屏幕没变过，
 * 主屏、分辨率、缩放变了就拒绝，那就重新截图。要用虚拟桌面的全局坐标就写 coordinateSpace: 'global'，不带 snapshotId。
 * 桌面控制不可用（插件没装、没给系统权限）时调用抛错，message 说怎么办：照着告诉用户，不要自己去装依赖。
 * 网页里的东西用浏览器的能力，不要拿桌面截图代替。
 */
export interface ComputerOperationsApi {
  /** @AgentView 截主屏：图交给你看（跟在程序结果后面，只看一次），返回值是它的几何与 snapshotId。
   * @OperationEffect none
   */
  screenshot(ctx: ComputerOperationContext): Promise<ComputerSnapshot>
  /** @AgentView 把指针移到一个坐标，不点击（悬停用）。
   * @OperationEffect write
   */
  move(input: ComputerPoint, ctx: ComputerOperationContext): Promise<ComputerMoved>
  /** @AgentView 在一个坐标点击：按钮、菜单、输入框这类桌面元素。
   * @OperationEffect write
   */
  click(input: ComputerClickInput, ctx: ComputerOperationContext): Promise<ComputerClicked>
  /** @AgentView 在当前焦点处原样输入文字；先点一下输入框拿到焦点。组合键用 key。
   * @OperationEffect write
   */
  typeText(input: ComputerTypeInput, ctx: ComputerOperationContext): Promise<ComputerTypeResult>
  /** @AgentView 按一个键或组合键：Enter、Esc、Tab、快捷键。普通文字用 typeText。
   * @OperationEffect write
   */
  key(input: ComputerKeyInput, ctx: ComputerOperationContext): Promise<ComputerKeyResult>
}

/**
 * 顺序是固定的，别调换：先查取消、再核对入参、再查可用性、最后做事。
 * 已经取消的调用不去拉起 helper；入参错了在拉起 helper 之前就拒绝；桌面控制不可用（没装插件、没给系统权限）时
 * 是一句能引导用户的中文报错，而不是让动作打到一半失败。
 */
export class ComputerOperations implements ComputerOperationsApi {
  public async screenshot(ctx: ComputerOperationContext): Promise<ComputerSnapshot> {
    ctx.abortSignal.throwIfAborted()
    const attach = ctx.attachImage
    if (!attach) throw new AppError('PLATFORM', '这个宿主没有把图交给模型的通道，screenshot 用不了')
    await requireComputerAvailable(ctx)
    const { base64, format, ...snapshot } = await ctx.computer.screenshot()
    attach({ mediaType: `image/${format}`, data: base64, label: `桌面截图：主屏 ${snapshot.width}×${snapshot.height}，snapshotId ${snapshot.snapshotId}` })
    return snapshot
  }

  public async move(input: ComputerPoint, ctx: ComputerOperationContext): Promise<ComputerMoved> {
    ctx.abortSignal.throwIfAborted()
    const point = pointInput(input, '移动')
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.mouseMove(point.x, point.y, moveOptionsFromInput(point))
    return projectComputerPointResult(result, actionPointFromResult(point, result))
  }

  public async click(input: ComputerClickInput, ctx: ComputerOperationContext): Promise<ComputerClicked> {
    ctx.abortSignal.throwIfAborted()
    const click = clickInput(input)
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.click(click.x, click.y, clickOptionsFromInput(click))
    return projectComputerPointResult(result, actionPointFromResult(click, result))
  }

  public async typeText(input: ComputerTypeInput, ctx: ComputerOperationContext): Promise<ComputerTypeResult> {
    ctx.abortSignal.throwIfAborted()
    const { text } = typeInput(input)
    await requireComputerAvailable(ctx)
    return ctx.computer.typeText(text)
  }

  public async key(input: ComputerKeyInput, ctx: ComputerOperationContext): Promise<ComputerKeyResult> {
    ctx.abortSignal.throwIfAborted()
    const { keys } = keyInput(input)
    await requireComputerAvailable(ctx)
    return ctx.computer.key(keys)
  }
}

/** 整个进程只有一份的桌面控制操作；空间把它挂在代码面的 `computer` 命名空间上。 */
export const computerOperations: ComputerOperationsApi = new ComputerOperations()
