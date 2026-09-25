/**
 * 在对话里给用户显示小部件（`velaros:widget`）的操作：`WidgetOperations` 与整个进程唯一的 `widgetOperations`。
 * 接口 `WidgetOperationsApi` 在本文件的类上方。核对标题与代码长度、把高度收进上下限，再交给宿主显示。
 */

import { AppError } from '@velaros-ai/core/error'

import { WidgetLimits } from '../contract/constants.js'
import type { WidgetOperationContext } from '../contract/requires.js'
import type { WidgetRequest } from '../types/widget.js'

/**
 * @AgentView
 * 在对话里给用户显示小部件：图表、示意图、可交互的小工具。用户在界面上直接看到它，小部件里调用 sendPrompt(text)
 * 会替用户发一句话过来。代码在沙箱里跑：颜色、字体跟随界面主题，用 CSS 变量写（如 var(--color-text-primary)、
 * var(--color-background-secondary)、var(--color-border-tertiary)、var(--font-sans)）；外部脚本只能从 cdnjs、jsdelivr、
 * unpkg、esm.sh 加载，不能访问网络接口。
 */
export interface WidgetOperationsApi {
  /** @AgentView 显示一个小部件，立即返回，不等用户操作。
   * @OperationEffect none
   * @OperationModes execute
   */
  show(input: WidgetRequest, ctx: WidgetOperationContext): Promise<null>
}

export class WidgetOperations implements WidgetOperationsApi {
  public async show(input: WidgetRequest, ctx: WidgetOperationContext): Promise<null> {
    ctx.abortSignal.throwIfAborted()
    const title = input.title.trim()
    if (!title || title.length > WidgetLimits.titleChars)
      throw new AppError('VALIDATION', `小部件标题要 1 到 ${WidgetLimits.titleChars} 个字符`)
    if (!input.code.trim() || input.code.length > WidgetLimits.codeChars)
      throw new AppError('VALIDATION', `小部件代码要 1 到 ${WidgetLimits.codeChars} 个字符`)
    const height = Number.isFinite(input.height)
      ? Math.min(
          Math.max(Math.round(input.height!), WidgetLimits.minHeight),
          WidgetLimits.maxHeight
        )
      : WidgetLimits.defaultHeight
    await ctx.show({ id: ctx.invocationId, title, code: input.code, height })
    return null
  }
}

/** 整个进程只有一份的小部件操作；装配时把宿主的显示端口塞进每次调用的上下文。 */
export const widgetOperations: WidgetOperationsApi = new WidgetOperations()
