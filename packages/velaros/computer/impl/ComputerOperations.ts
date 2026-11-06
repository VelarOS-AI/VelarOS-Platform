/**
 * 桌面控制能力（`velaros:computer`）的操作：`ComputerOperations` 与整个进程唯一的 `computerOperations`。接口 `ComputerOperationsApi` 在本文件的类上方。
 * 一份实现挂在哪个空间都一样，空间之间的差别全在调用上下文里的端口 `ComputerSpacePort` 与交图通道上。
 */

import { AppError } from '@velaros-ai/core/error'

import type { ComputerOperationContext } from '../contract/requires.js'
import type {
  ComputerCapabilities,
  ComputerClicked,
  ComputerClickInput,
  ComputerDragInput,
  ComputerDragResult,
  ComputerElementAction,
  ComputerElementInput,
  ComputerElementValueInput,
  ComputerInputState,
  ComputerKeyInput,
  ComputerKeyResult,
  ComputerKeyStateInput,
  ComputerMouseDownInput,
  ComputerMouseUpInput,
  ComputerMoved,
  ComputerPoint,
  ComputerRecording,
  ComputerRecordInput,
  ComputerScrollInput,
  ComputerScrollResult,
  ComputerSnapshot,
  ComputerTree,
  ComputerTreeInput,
  ComputerTypeInput,
  ComputerTypeResult,
  ComputerWindow,
  ComputerWindowInput,
} from '../types/computer.js'
import { requireComputerAvailable } from '../utils/availability.js'
import {
  actionPointFromResult,
  clickOptionsFromInput,
  moveOptionsFromInput,
  projectComputerPointResult,
} from '../utils/coordinates.js'
import {
  dragInput,
  elementInput,
  elementValueInput,
  keyStateInput,
  mouseDownInput,
  mouseUpInput,
  recordInput,
  scrollInput,
  treeInput,
  windowInput,
} from '../utils/extended-input.js'
import { clickInput, keyInput, pointInput, typeInput } from '../utils/input.js'

/**
 * @AgentView
 * 桌面控制：观察主屏、窗口与 UI 控件树，执行语义控件操作、键鼠输入、滚动拖拽并录制有限时长视频。
 * 先 capabilities 查平台限制，再 windows 选择目标窗口；有控件树时优先 uiTree / invokeElement / setElementValue。
 * screenshotWindow 的坐标必须写 coordinateSpace: 'window'；窗口移动或尺寸改变后旧绑定失效。
 * 先 screenshot：图交给你看，返回值里有 snapshotId；之后按这张图上量出的坐标 move、click 时原样带上它——helper 在真正动手前核对屏幕没变过，
 * 主屏、分辨率、缩放变了就拒绝，那就重新截图。要用虚拟桌面的全局坐标就写 coordinateSpace: 'global'，不带 snapshotId。
 * 桌面控制不可用（运行时缺失、没给系统权限）时调用抛错，message 说怎么办：照着告诉用户，不要自己去装依赖。
 * 手动按住输入用 try/finally 配对释放，最多保持 5000 毫秒；普通拖拽优先原子 drag。
 * 网页里的东西用浏览器的能力，不要拿桌面截图代替。
 */
export interface ComputerOperationsApi {
  /** @AgentView 查询本平台窗口、控件树和录像能力及限制。
   * @OperationEffect none
   */
  capabilities(ctx: ComputerOperationContext): Promise<ComputerCapabilities>
  /** @AgentView 枚举可见窗口；id 只用于本 helper，失效后重新枚举。
   * @OperationEffect none
   */
  windows(ctx: ComputerOperationContext): Promise<ComputerWindow[]>
  /** @AgentView 截取指定窗口。图经图片通道交给模型；图上坐标使用 coordinateSpace: 'window' 和本次 snapshotId。
   * @OperationEffect none
   */
  screenshotWindow(
    input: ComputerWindowInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerSnapshot>
  /** @AgentView 将指定窗口置前并聚焦；窗口身份失效时失败。
   * @OperationEffect write
   * @OperationModes execute
   */
  focusWindow(input: ComputerWindowInput, ctx: ComputerOperationContext): Promise<ComputerWindow>
  /** @AgentView 在指定位置独立滚动；正数向右/下，负数向左/上，单位为滚轮刻度，每轴最多 100。
   * @OperationEffect write
   * @OperationModes execute
   */
  scroll(input: ComputerScrollInput, ctx: ComputerOperationContext): Promise<ComputerScrollResult>
  /** @AgentView 原子拖拽，两端先校验再按下；durationMs 为 100–3000（默认 500），失败也释放鼠标。
   * @OperationEffect write
   * @OperationModes execute
   */
  drag(input: ComputerDragInput, ctx: ComputerOperationContext): Promise<ComputerDragResult>
  /** @AgentView 在指定位置按下鼠标；用 mouseUp 配对，最多 5000 毫秒后自动释放。
   * @OperationEffect write
   * @OperationModes execute
   */
  mouseDown(
    input: ComputerMouseDownInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerInputState>
  /** @AgentView 释放鼠标按钮；不需要旧截图，可以重复调用。
   * @OperationEffect write
   * @OperationModes execute
   */
  mouseUp(input: ComputerMouseUpInput, ctx: ComputerOperationContext): Promise<ComputerInputState>
  /** @AgentView 按住单个键；必须用 keyUp 配对，最多 5000 毫秒后自动释放。
   * @OperationEffect write
   * @OperationModes execute
   */
  keyDown(input: ComputerKeyStateInput, ctx: ComputerOperationContext): Promise<ComputerInputState>
  /** @AgentView 释放单个键；可重复调用。
   * @OperationEffect write
   * @OperationModes execute
   */
  keyUp(input: ComputerKeyStateInput, ctx: ComputerOperationContext): Promise<ComputerInputState>
  /** @AgentView 释放此 helper 持有的全部键与鼠标按钮，用于错误恢复。
   * @OperationEffect write
   * @OperationModes execute
   */
  releaseInputs(ctx: ComputerOperationContext): Promise<ComputerInputState>
  /** @AgentView 查询窗口的 UI 控件树；maxDepth 最多 12，maxNodes 最多 500；检查 truncated 和 warnings。
   * @OperationEffect none
   */
  uiTree(input: ComputerTreeInput, ctx: ComputerOperationContext): Promise<ComputerTree>
  /** @AgentView 经控件的 Invoke/AXPress 语义激活；绑定 uiTree 的身份，过期或不支持时报错，不猜坐标。
   * @OperationEffect write
   * @OperationModes execute
   */
  invokeElement(
    input: ComputerElementInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerElementAction>
  /** @AgentView 经 Value/AXValue 设置控件文本，最多 10000 字符；不会把文本当快捷键。
   * @OperationEffect write
   * @OperationModes execute
   */
  setElementValue(
    input: ComputerElementValueInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerElementAction>
  /** @AgentView 录制主屏或窗口到新的绝对路径 MP4；durationMs 100–5000，fps 1–10；不覆盖，不含音频。
   * @OperationEffect write
   * @OperationModes execute
   */
  record(input: ComputerRecordInput, ctx: ComputerOperationContext): Promise<ComputerRecording>
  /** @AgentView 截主屏：图交给你看（跟在程序结果后面，只看一次），返回值是它的几何与 snapshotId。
   * @OperationEffect none
   */
  screenshot(ctx: ComputerOperationContext): Promise<ComputerSnapshot>
  /** @AgentView 把指针移到一个坐标，不点击（悬停用）。
   * @OperationEffect write
   * @OperationModes execute
   */
  move(input: ComputerPoint, ctx: ComputerOperationContext): Promise<ComputerMoved>
  /** @AgentView 在一个坐标点击：按钮、菜单、输入框这类桌面元素。
   * @OperationEffect write
   * @OperationModes execute
   */
  click(input: ComputerClickInput, ctx: ComputerOperationContext): Promise<ComputerClicked>
  /** @AgentView 在当前焦点处原样输入文字；先点一下输入框拿到焦点。组合键用 key。
   * @OperationEffect write
   * @OperationModes execute
   */
  typeText(input: ComputerTypeInput, ctx: ComputerOperationContext): Promise<ComputerTypeResult>
  /** @AgentView 按一个键或组合键：Enter、Esc、Tab、快捷键。普通文字用 typeText。
   * @OperationEffect write
   * @OperationModes execute
   */
  key(input: ComputerKeyInput, ctx: ComputerOperationContext): Promise<ComputerKeyResult>
}

/**
 * 顺序是固定的，别调换：先查取消、再核对入参、再查可用性、最后做事。
 * 已经取消的调用不去拉起 helper；入参错了在拉起 helper 之前就拒绝；桌面控制不可用（没装插件、没给系统权限）时
 * 是一句能引导用户的中文报错，而不是让动作打到一半失败。
 */
export class ComputerOperations implements ComputerOperationsApi {
  public async capabilities(ctx: ComputerOperationContext): Promise<ComputerCapabilities> {
    ctx.abortSignal.throwIfAborted()
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.capabilities(ctx.abortSignal)
    ctx.abortSignal.throwIfAborted()
    return result
  }

  public async windows(ctx: ComputerOperationContext): Promise<ComputerWindow[]> {
    ctx.abortSignal.throwIfAborted()
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.windows(ctx.abortSignal)
    ctx.abortSignal.throwIfAborted()
    return result
  }

  public async screenshotWindow(
    input: ComputerWindowInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerSnapshot> {
    ctx.abortSignal.throwIfAborted()
    const value = windowInput(input)
    const attach = ctx.attachImage
    if (!attach)
      throw new AppError('PLATFORM', '这个宿主没有把图交给模型的通道，screenshotWindow 用不了')
    await requireComputerAvailable(ctx)
    const { base64, format, ...snapshot } = await ctx.computer.screenshotWindow(
      value,
      ctx.abortSignal
    )
    ctx.abortSignal.throwIfAborted()
    attach({
      mediaType: `image/${format}`,
      data: base64,
      label: `窗口截图：${snapshot.windowId}，snapshotId ${snapshot.snapshotId}`,
    })
    return snapshot
  }

  public async focusWindow(
    input: ComputerWindowInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerWindow> {
    ctx.abortSignal.throwIfAborted()
    const value = windowInput(input)
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.focusWindow(value, ctx.abortSignal)
    ctx.abortSignal.throwIfAborted()
    return result
  }

  public async scroll(
    input: ComputerScrollInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerScrollResult> {
    ctx.abortSignal.throwIfAborted()
    const value = scrollInput(input)
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.scroll(value, ctx.abortSignal)
    ctx.abortSignal.throwIfAborted()
    return result
  }

  public async drag(
    input: ComputerDragInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerDragResult> {
    ctx.abortSignal.throwIfAborted()
    const value = dragInput(input)
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.drag(value, ctx.abortSignal)
    ctx.abortSignal.throwIfAborted()
    return result
  }

  public async mouseDown(
    input: ComputerMouseDownInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerInputState> {
    ctx.abortSignal.throwIfAborted()
    const value = mouseDownInput(input)
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.mouseDown(value, ctx.abortSignal)
    ctx.abortSignal.throwIfAborted()
    return result
  }

  public async mouseUp(
    input: ComputerMouseUpInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerInputState> {
    ctx.abortSignal.throwIfAborted()
    const value = mouseUpInput(input)
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.mouseUp(value, ctx.abortSignal)
    ctx.abortSignal.throwIfAborted()
    return result
  }

  public async keyDown(
    input: ComputerKeyStateInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerInputState> {
    ctx.abortSignal.throwIfAborted()
    const value = keyStateInput(input)
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.keyDown(value, ctx.abortSignal)
    ctx.abortSignal.throwIfAborted()
    return result
  }

  public async keyUp(
    input: ComputerKeyStateInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerInputState> {
    ctx.abortSignal.throwIfAborted()
    const value = keyStateInput(input)
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.keyUp(value, ctx.abortSignal)
    ctx.abortSignal.throwIfAborted()
    return result
  }

  public async releaseInputs(ctx: ComputerOperationContext): Promise<ComputerInputState> {
    ctx.abortSignal.throwIfAborted()
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.releaseInputs(ctx.abortSignal)
    ctx.abortSignal.throwIfAborted()
    return result
  }

  public async uiTree(
    input: ComputerTreeInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerTree> {
    ctx.abortSignal.throwIfAborted()
    const value = treeInput(input)
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.uiTree(value, ctx.abortSignal)
    ctx.abortSignal.throwIfAborted()
    return result
  }

  public async invokeElement(
    input: ComputerElementInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerElementAction> {
    ctx.abortSignal.throwIfAborted()
    const value = elementInput(input)
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.invokeElement(value, ctx.abortSignal)
    ctx.abortSignal.throwIfAborted()
    return result
  }

  public async setElementValue(
    input: ComputerElementValueInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerElementAction> {
    ctx.abortSignal.throwIfAborted()
    const value = elementValueInput(input)
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.setElementValue(value, ctx.abortSignal)
    ctx.abortSignal.throwIfAborted()
    return result
  }

  public async record(
    input: ComputerRecordInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerRecording> {
    ctx.abortSignal.throwIfAborted()
    const value = recordInput(input)
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.record(value, ctx.abortSignal)
    ctx.abortSignal.throwIfAborted()
    return result
  }

  public async screenshot(ctx: ComputerOperationContext): Promise<ComputerSnapshot> {
    ctx.abortSignal.throwIfAborted()
    const attach = ctx.attachImage
    if (!attach) throw new AppError('PLATFORM', '这个宿主没有把图交给模型的通道，screenshot 用不了')
    await requireComputerAvailable(ctx)
    const { base64, format, ...snapshot } = await ctx.computer.screenshot(ctx.abortSignal)
    attach({
      mediaType: `image/${format}`,
      data: base64,
      label: `桌面截图：主屏 ${snapshot.width}×${snapshot.height}，snapshotId ${snapshot.snapshotId}`,
    })
    return snapshot
  }

  public async move(input: ComputerPoint, ctx: ComputerOperationContext): Promise<ComputerMoved> {
    ctx.abortSignal.throwIfAborted()
    const point = pointInput(input, '移动')
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.mouseMove(
      point.x,
      point.y,
      moveOptionsFromInput(point),
      ctx.abortSignal
    )
    return projectComputerPointResult(result, actionPointFromResult(point, result))
  }

  public async click(
    input: ComputerClickInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerClicked> {
    ctx.abortSignal.throwIfAborted()
    const click = clickInput(input)
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.click(
      click.x,
      click.y,
      clickOptionsFromInput(click),
      ctx.abortSignal
    )
    return projectComputerPointResult(result, actionPointFromResult(click, result))
  }

  public async typeText(
    input: ComputerTypeInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerTypeResult> {
    ctx.abortSignal.throwIfAborted()
    const { text } = typeInput(input)
    await requireComputerAvailable(ctx)
    return ctx.computer.typeText(text, ctx.abortSignal)
  }

  public async key(
    input: ComputerKeyInput,
    ctx: ComputerOperationContext
  ): Promise<ComputerKeyResult> {
    ctx.abortSignal.throwIfAborted()
    const { keys } = keyInput(input)
    await requireComputerAvailable(ctx)
    return ctx.computer.key(keys, ctx.abortSignal)
  }
}

/** 整个进程只有一份的桌面控制操作；空间把它挂在代码面的 `computer` 命名空间上。 */
export const computerOperations: ComputerOperationsApi = new ComputerOperations()
