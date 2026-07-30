import { BrowserActionEffectScriptBuilder } from './BrowserActionEffectScriptBuilder'
import { BrowserDragTargetScriptBuilder } from './BrowserDragTargetScriptBuilder'
import { BrowserElementQueryScriptBuilder } from './BrowserElementQueryScriptBuilder'
import { BrowserEvaluateScriptBuilder } from './BrowserEvaluateScriptBuilder'
import { BrowserExtractionScriptBuilder } from './BrowserExtractionScriptBuilder'
import { BrowserFileUploadScriptBuilder } from './BrowserFileUploadScriptBuilder'
import { BrowserInspectionScriptBuilder } from './BrowserInspectionScriptBuilder'
import { BrowserMediaSourcesScriptBuilder } from './BrowserMediaSourcesScriptBuilder'
import { BrowserPageScrollScriptBuilder } from './BrowserPageScrollScriptBuilder'
import { BrowserPageStorageScriptBuilder } from './BrowserPageStorageScriptBuilder'
import { BrowserPageWaitScriptBuilder } from './BrowserPageWaitScriptBuilder'
import {
  BrowserTargetActionScriptBuilder,
  type BrowserTargetActionScriptBuildOptions,
} from './BrowserTargetActionScriptBuilder'
import { BrowserTargetHighlightScriptBuilder } from './BrowserTargetHighlightScriptBuilder'
import { BrowserWaitForSelectorScriptBuilder } from './BrowserWaitForSelectorScriptBuilder'
import type {
  BrowserDragOptions,
  BrowserElementQueryOptions,
  BrowserElementTargetHint,
  BrowserEvaluateScriptOptions,
  BrowserPageScrollOptions,
  BrowserPageStorageOptions,
  BrowserPageWaitOptions,
  BrowserTargetActionOptions,
  BrowserWaitForSelectorOptions,
} from './types'

/**
 * 浏览器页面脚本构造门面。
 *
 * ElectronBrowserRuntime 与四个 engine 只依赖这一层，不直接知道每种页面脚本的具体构造类。
 *
 * **别把它当「零价值转发层」删掉**（判决，防复辟）：这里每个方法确实只有一行，但门面是
 * 架构面而不是函数面——它把 14 个构造类收成 engine 构造函数里的**一个**注入依赖。删掉的
 * 代价是每个 engine 各 import 14 个 builder，且新增一种页面脚本要改 N 处装配。§3.2 的恒等
 * 转发禁令针对「没有域含义的一行函数」，这里适用的是 §1.9 门面收口。
 */
class BrowserPageScriptBuilder {
  private readonly actionEffectScriptBuilder = new BrowserActionEffectScriptBuilder()
  private readonly dragTargetScriptBuilder = new BrowserDragTargetScriptBuilder()
  private readonly elementQueryScriptBuilder = new BrowserElementQueryScriptBuilder()
  private readonly evaluateScriptBuilder = new BrowserEvaluateScriptBuilder()
  private readonly extractionScriptBuilder = new BrowserExtractionScriptBuilder()
  private readonly inspectionScriptBuilder = new BrowserInspectionScriptBuilder()
  private readonly pageScrollScriptBuilder = new BrowserPageScrollScriptBuilder()
  private readonly pageStorageScriptBuilder = new BrowserPageStorageScriptBuilder()
  private readonly pageWaitScriptBuilder = new BrowserPageWaitScriptBuilder()
  private readonly targetActionScriptBuilder = new BrowserTargetActionScriptBuilder()
  private readonly targetHighlightScriptBuilder = new BrowserTargetHighlightScriptBuilder()
  private readonly fileUploadScriptBuilder = new BrowserFileUploadScriptBuilder()
  private readonly waitForSelectorScriptBuilder = new BrowserWaitForSelectorScriptBuilder()
  private readonly mediaSourcesScriptBuilder = new BrowserMediaSourcesScriptBuilder()

  public buildInspectionScript(args: {
    includeHtml: boolean
    maxTextChars: number
    maxHtmlChars: number
    maxElements: number
    ignoreSelectors?: string[]
  }): string {
    return this.inspectionScriptBuilder.buildInspectionScript(args)
  }

  public buildTargetActionScript(
    options: BrowserTargetActionOptions,
    buildOptions?: BrowserTargetActionScriptBuildOptions
  ): string {
    return this.targetActionScriptBuilder.buildTargetActionScript(options, buildOptions)
  }

  public buildActionEffectSnapshotScript(): string {
    return this.actionEffectScriptBuilder.buildActionEffectSnapshotScript()
  }

  public buildDragTargetScript(options: BrowserDragOptions): string {
    return this.dragTargetScriptBuilder.buildDragTargetScript(options)
  }

  public buildTargetHighlightScript(input: {
    selector?: LooseOptional<string>
    label?: LooseOptional<string>
    durationMs?: number
  }): string {
    return this.targetHighlightScriptBuilder.buildHighlightScript(input)
  }

  public buildTargetHighlightFromTargetScript(
    target: BrowserElementTargetHint,
    label?: string
  ): string {
    return this.targetHighlightScriptBuilder.buildHighlightFromTargetScript(target, label)
  }

  public buildResolveFileInputScript(target: BrowserElementTargetHint): string {
    return this.fileUploadScriptBuilder.buildResolveFileInputScript(target)
  }

  public buildScrollScript(options: BrowserPageScrollOptions): string {
    return this.pageScrollScriptBuilder.buildScrollScript(options)
  }

  public buildElementQueryScript(options: BrowserElementQueryOptions): string {
    return this.elementQueryScriptBuilder.buildElementQueryScript(options)
  }

  public buildWaitForSelectorScript(options: BrowserWaitForSelectorOptions): string {
    return this.waitForSelectorScriptBuilder.buildWaitForSelectorScript(options)
  }

  public buildPageWaitScript(options: BrowserPageWaitOptions): string {
    return this.pageWaitScriptBuilder.buildPageWaitScript(options)
  }

  public buildPageStorageScript(options: BrowserPageStorageOptions): string {
    return this.pageStorageScriptBuilder.buildPageStorageScript(options)
  }

  public buildEvaluateScript(options: BrowserEvaluateScriptOptions): string {
    return this.evaluateScriptBuilder.buildEvaluateScript(options)
  }

  /** D1: 表格提取脚本 — 返回 headers + rows 结构，支持 CSS selector 或 XPath 定位目标表格 */
  public buildTableExtractionScript(args: {
    selector?: string
    maxRows: number
    tableIndex: number
  }): string {
    return this.extractionScriptBuilder.buildTableExtractionScript(args)
  }

  /** D2: 列表提取脚本 — 提取列表项（标题 + 链接 + 描述），支持 CSS selector 或 XPath */
  public buildListExtractionScript(args: { selector?: string; maxItems: number }): string {
    return this.extractionScriptBuilder.buildListExtractionScript(args)
  }

  public buildListMediaSourcesScript(args: {
    limit: number
    includeDataUrls: boolean
    includeBlobUrls: boolean
  }): string {
    return this.mediaSourcesScriptBuilder.buildListMediaSourcesScript(args)
  }

  public buildPageContentExtractionScript(args: {
    format: 'plain' | 'markdown' | 'html'
    selector?: string
    ignoreSelectors?: string[]
    maxChars: number
  }): string {
    return this.extractionScriptBuilder.buildPageContentExtractionScript(args)
  }

  public buildPageResourcesScript(args: { limit: number; includeIframes: boolean }): string {
    return this.extractionScriptBuilder.buildPageResourcesScript(args)
  }
}

export { BrowserPageScriptBuilder }
