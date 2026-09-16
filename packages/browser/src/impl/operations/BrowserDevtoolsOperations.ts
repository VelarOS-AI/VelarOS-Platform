import { toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserToolContext } from '../../contract/requires'
import { requireActiveBrowserSite } from '../../utils/tool.js'

/**
 * 开发者工具那一侧的操作：性能 trace 与 insight、堆快照、页面录屏。
 *
 * 每次工具调用建一份，实例带住这一次调用的工具上下文。这里只做「动作 → 宿主端口」的分派；
 * trace 的录制与解析、GIF 的合成都在宿主那一侧。
 */
export interface BrowserDevtoolsOperationsApi {
  /** 按 action 分派性能动作：开始 / 停止 trace、深入一条结论、抓堆快照。 */
  performance(input: {
    action?: 'start_trace' | 'stop_trace' | 'analyze_insight' | 'take_heapsnapshot'
    reload?: boolean
    autoStopMs?: LooseOptional<number>
    insightSetId?: string
    insightName?: string
    path?: string
  }): Promise<unknown>
  /** 开始或停止录屏；停止时把帧流合成 GIF 落盘。 */
  screencast(input: {
    action: 'start' | 'stop'
    maxWidth?: number
    everyNthFrame?: number
    name?: string
  }): Promise<unknown>
}

export class BrowserDevtoolsOperations implements BrowserDevtoolsOperationsApi {
  constructor(private readonly ctx: BrowserToolContext) {}

  public async performance(input: {
    action?: 'start_trace' | 'stop_trace' | 'analyze_insight' | 'take_heapsnapshot'
    reload?: boolean
    autoStopMs?: LooseOptional<number>
    insightSetId?: string
    insightName?: string
    path?: string
  }): Promise<unknown> {
    this.begin()

    // schema 已保证：action 缺席只在带 insight 字段时被推断补全，否则 superRefine 拦下；
    // 这里的空值分支只是类型收窄兜底。
    switch (input.action) {
      case 'start_trace':
        return this.ctx.browser.startPerformanceTrace({
          reload: input.reload,
          autoStopMs: toOptional(input.autoStopMs),
        })
      case 'stop_trace':
        return this.ctx.browser.stopPerformanceTrace()
      case 'analyze_insight':
        return this.ctx.browser.analyzePerformanceInsight({
          insightSetId: input.insightSetId!,
          insightName: input.insightName!,
        })
      case 'take_heapsnapshot':
        return this.ctx.browser.captureHeapSnapshot({ path: input.path })
      default:
        throw new AppError('VALIDATION', 'browser:performance 不认识这个 action。')
    }
  }

  public async screencast(input: {
    action: 'start' | 'stop'
    maxWidth?: number
    everyNthFrame?: number
    name?: string
  }): Promise<unknown> {
    this.begin()

    if (input.action === 'start')
      return this.ctx.browser.startScreencast({
        maxWidth: input.maxWidth,
        everyNthFrame: input.everyNthFrame,
      })

    return this.ctx.browser.stopScreencast({ name: input.name })
  }

  /** 进入任一动作分支前的共用前置：响应中止信号、确认已经进站点。 */
  private begin(): void {
    this.ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(this.ctx)
  }
}
