import type { ComputerToolContext } from '../contract/requires.js'
import type {
  ComputerKeyResult,
  ComputerTypeResult,
} from '../types/computer.js'
import type { ComputerClickInput, ComputerPointInput } from '../types/tool.js'
import { requireComputerAvailable } from '../utils/availability.js'
import {
  actionPointFromResult,
  clickOptionsFromInput,
  moveOptionsFromInput,
  projectComputerPointResult,
} from '../utils/coordinates.js'

/**
 * 六个工具的执行体：每个动作前先过可用性门禁，再把坐标换算好交给宿主端口，最后把回执投影成模型看到的形状。
 *
 * 每个方法都收本次调用的上下文（取消信号与宿主端口），自己不持有任何状态；
 * 工具文件里一行交给它，工具定义那边只剩说明与 schema。
 */
export interface ComputerInputOperationsApi {
  /** 截主屏：base64 提成模型可见图片，其余几何字段原样返回。 */
  screenshot(ctx: ComputerToolContext): Promise<object>
  /** 移动指针：主屏坐标连同截图绑定一起交给运行时，由 helper 在移动前再校验一次。 */
  move(input: ComputerPointInput, ctx: ComputerToolContext): Promise<object>
  /** 点击：主屏坐标连同截图绑定一起交给运行时，由 helper 在按下前再校验一次。 */
  click(input: ComputerClickInput, ctx: ComputerToolContext): Promise<object>
  /** 在当前焦点处输入文本。 */
  typeText(text: string, ctx: ComputerToolContext): Promise<ComputerTypeResult>
  /** 按下一个键或组合键。 */
  key(keys: string, ctx: ComputerToolContext): Promise<ComputerKeyResult>
}

/**
 * 桌面动作的执行体。
 *
 * 顺序是固定的，别调换：**先查可用性再做事**——桌面控制不可用时（没装插件、没给系统权限）必须
 * 变成一句能引导用户的中文报错，而不是让动作打到一半失败。取消信号在门禁之前查一次，
 * 免得已经取消的调用还去拉起 helper。
 */
export class ComputerInputOperations implements ComputerInputOperationsApi {
  public async screenshot(ctx: ComputerToolContext): Promise<object> {
    ctx.abortSignal.throwIfAborted()
    await requireComputerAvailable(ctx)
    const { base64, format, ...geometry } = await ctx.computer.screenshot()
    // base64 不放进文本结果；executor 的 liftGenericModelImage 会把 modelImage 提升成模型可见图片。
    return { ...geometry, format, modelImage: { data: base64, mediaType: `image/${format}` as const } }
  }

  public async move(
    input: ComputerPointInput,
    ctx: ComputerToolContext
  ): Promise<object> {
    ctx.abortSignal.throwIfAborted()
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.mouseMove(input.x, input.y, moveOptionsFromInput(input))
    return projectComputerPointResult(result, actionPointFromResult(input, result))
  }

  public async click(
    input: ComputerClickInput,
    ctx: ComputerToolContext
  ): Promise<object> {
    ctx.abortSignal.throwIfAborted()
    await requireComputerAvailable(ctx)
    const result = await ctx.computer.click(input.x, input.y, clickOptionsFromInput(input))
    return projectComputerPointResult(result, actionPointFromResult(input, result))
  }

  public async typeText(text: string, ctx: ComputerToolContext): Promise<ComputerTypeResult> {
    ctx.abortSignal.throwIfAborted()
    await requireComputerAvailable(ctx)
    return ctx.computer.typeText(text)
  }

  public async key(keys: string, ctx: ComputerToolContext): Promise<ComputerKeyResult> {
    ctx.abortSignal.throwIfAborted()
    await requireComputerAvailable(ctx)
    return ctx.computer.key(keys)
  }
}

/** 整个进程共用的那一份执行体：无状态，工具文件里直接调它。 */
export const computerInputOperations: ComputerInputOperationsApi = new ComputerInputOperations()
