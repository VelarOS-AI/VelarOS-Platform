import { AppError } from '@velaros-ai/core/error'

import type { BrowserToolContext } from '../../contract/requires'
import type {
  BrowserEvaluateScriptResult,
  BrowserObserveActionsResult,
  BrowserScreenshotArtifact,
} from '../../types/browser'
import { buildObserveActionsResult, clampObserveActionLimit } from '../../utils/observe-actions'
import { buildElementBoundsScript } from '../../utils/page-scripts/element-bounds'
import { buildBrowserScreenshotOptions } from '../../utils/screenshot-options'
import { requireActiveBrowserSite } from '../../utils/tool.js'
import { BrowserTuning } from '../../utils/tuning'

/**
 * 页面观察里需要**先读一遍页面再算**的那几件事：动作候选、元素矩形、区域截图。
 *
 * 每次工具调用建一份，实例带住这一次调用的工具上下文。读状态、读诊断这类一次调用就能回答的，
 * 工具直接调宿主端口，不经过这里。
 */
export interface BrowserInspectOperationsApi {
  /** 按意图给出当前页面可执行的动作候选与回放入参。 */
  observeActions(input: {
    instruction?: string
    limit?: number
    ignoreSelectors?: string[]
  }): Promise<BrowserObserveActionsResult>
  /** 读第一个匹配元素在视口里的矩形。 */
  elementBounds(selector: string): Promise<BrowserEvaluateScriptResult>
  /** 按 selector 或矩形截取页面上的一块。 */
  captureRegion(input: {
    selector?: string
    x?: number
    y?: number
    width?: number
    height?: number
    path?: string
  }): Promise<BrowserScreenshotArtifact>
}

export class BrowserInspectOperations implements BrowserInspectOperationsApi {
  constructor(private readonly ctx: BrowserToolContext) {}

  public async observeActions(input: {
    instruction?: string
    limit?: number
    ignoreSelectors?: string[]
  }): Promise<BrowserObserveActionsResult> {
    this.begin()

    const limit = clampObserveActionLimit(input.limit)
    const inspection = await this.ctx.browser.inspectPage({
      maxTextChars: BrowserTuning.page.observeTextChars,
      // 候选要从元素里挑，所以元素取得比 limit 宽一些，再按意图排序截断。
      maxElements: Math.max(BrowserTuning.page.observeMinElements, limit * 4),
      ignoreSelectors: input.ignoreSelectors,
    })

    return buildObserveActionsResult(inspection, input.instruction, limit)
  }

  public async elementBounds(selector: string): Promise<BrowserEvaluateScriptResult> {
    this.begin()

    return this.ctx.browser.evaluateScript({
      script: buildElementBoundsScript(selector),
      mode: 'function-body',
    })
  }

  public async captureRegion(input: {
    selector?: string
    x?: number
    y?: number
    width?: number
    height?: number
    path?: string
  }): Promise<BrowserScreenshotArtifact> {
    this.begin()

    if (
      !input.selector?.trim() &&
      !(Number.isFinite(input.x) && Number.isFinite(input.y) && input.width && input.height)
    ) {
      throw new AppError(
        'VALIDATION',
        'browser:capture_region 需要 selector 或完整的 x/y/width/height。'
      )
    }

    return this.ctx.browser.captureScreenshot(
      buildBrowserScreenshotOptions({
        path: input.path ?? `artifacts/screenshots/region-${Date.now()}.png`,
        region: {
          selector: input.selector,
          x: input.x,
          y: input.y,
          width: input.width,
          height: input.height,
        },
        modelFacing: true,
      })
    )
  }

  /** 进入任一动作分支前的共用前置：响应中止信号、确认已经进站点。 */
  private begin(): void {
    this.ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(this.ctx)
  }
}
