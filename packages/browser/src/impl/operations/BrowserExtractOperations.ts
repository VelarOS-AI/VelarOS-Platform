import type { z } from 'zod'

import {
  isArray,
  isNonBlankString,
  isPlainObject,
  isString,
  isTrue,
  stringifyPretty,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { BrowserExtractDefaults } from '../../contract/constants'
import type { BrowserToolContext } from '../../contract/requires'
import type { BrowserWorkspaceArtifactFormat } from '../../types/browser'
import type {
  BrowserExtractionPayload,
  BrowserExtractionSaveOptions,
  BrowserListExtractionInput,
  BrowserPageContentExtractionInput,
  BrowserTableExtractionInput,
} from '../../types/tools.js'
import { BrowserPageContentArtifactFormats, buildBrowserArtifactAccess } from '../../utils/artifacts.js'
import { BrowserEvaluateMaxResultChars } from '../../utils/page-scripts/evaluate'
import {
  buildListExtractionScript,
  buildPageContentExtractionScript,
  buildTableExtractionScript,
} from '../../utils/page-scripts/extraction'
import { encodeBrowserScriptStringLiteral } from '../../utils/page-scripts/literal'
import type { browserExtractExactSchema } from '../../utils/schemas/extract'
import { getActiveBrowserContext, requireActiveBrowserSite } from '../../utils/tool.js'
import { BrowserTuning } from '../../utils/tuning'
import { BrowserWorkspaceArtifactManager } from '../workspace/BrowserWorkspaceArtifactManager.js'

/** browser:extract action=paginate 的入参：逐页提取列表并合并。 */
interface BrowserExtractPaginateInput extends BrowserExtractionSaveOptions {
  selector?: string
  maxPages: number
  maxItemsPerPage: number
  nextPageSelector?: string
}

/**
 * `browser:extract` 背后的执行类：表格、列表、翻页列表、正文四种提取，可选落盘。
 *
 * 每次工具调用建一份，实例带住这一次调用的工具上下文。四个方法都返回页面脚本给出的
 * 结构化载荷（表格给 headers/rows，列表给 items，正文给 content），`save` 为真且提取
 * 成功时追加 `savedPath` / `savedRelativePath`。提取结果超过求值通道上限时明确失败，
 * 绝不把半截结果当完整结果返回。
 */
export interface BrowserExtractOperationsApi {
  /** 按收敛好的入参分派到四个提取分支，缺省值在这里补齐。 */
  run(input: z.output<typeof browserExtractExactSchema>): Promise<BrowserExtractionPayload>
  /** 提取页面表格；没找到表格时载荷里 ok=false 并附 error，不落盘。 */
  extractTable(input: BrowserTableExtractionInput): Promise<BrowserExtractionPayload>
  /** 提取页面列表或搜索结果条目。 */
  extractList(input: BrowserListExtractionInput): Promise<BrowserExtractionPayload>
  /** 逐页提取列表并合并结果；翻不动、内容没变或条目为空时停下。 */
  paginate(input: BrowserExtractPaginateInput): Promise<BrowserExtractionPayload>
  /** 提取页面可见正文，按 format 给 plain / markdown / html。 */
  extractPageContent(input: BrowserPageContentExtractionInput): Promise<BrowserExtractionPayload>
}

export class BrowserExtractOperations implements BrowserExtractOperationsApi {
  /**
   * 翻页缺省的「下一页」选择器：只认明确自称下一页的元素。
   *
   * 宁可翻不动也不要翻错：点错一次之后收集到的就全是别的页面的内容，而回执上看不出来。
   * 页面用别的写法时由模型显式传 nextPageSelector。
   */
  private static readonly NextPageSelector = [
    'a[rel="next"]',
    'button[rel="next"]',
    'a[aria-label*="next" i]',
    'button[aria-label*="next" i]',
    'a[aria-label*="下一页"]',
    'button[aria-label*="下一页"]',
  ].join(', ')

  constructor(private readonly ctx: BrowserToolContext) {}

  public async run(input: z.output<typeof browserExtractExactSchema>): Promise<BrowserExtractionPayload> {
    this.begin()

    switch (input.action) {
      case 'table':
        return this.extractTable({
          selector: input.selector,
          tableIndex: input.tableIndex ?? BrowserExtractDefaults.tableIndex,
          maxRows: input.maxRows ?? BrowserExtractDefaults.tableRows,
          save: !!input.save,
          name: input.name,
        })
      case 'list':
        return this.extractList({
          selector: input.selector,
          maxItems: input.maxItems ?? BrowserExtractDefaults.listItems,
          save: !!input.save,
          name: input.name,
        })
      case 'paginate':
        return this.paginate({
          selector: input.selector,
          maxPages: input.maxPages ?? BrowserExtractDefaults.paginatePages,
          maxItemsPerPage: input.maxItemsPerPage ?? BrowserExtractDefaults.paginateItemsPerPage,
          nextPageSelector: input.nextPageSelector,
          save: input.save ?? true,
          name: input.name,
        })
      case 'content':
        return this.extractPageContent({
          format: input.format ?? 'markdown',
          selector: input.selector,
          ignoreSelectors: input.ignoreSelectors,
          maxChars: input.maxChars ?? BrowserExtractDefaults.contentChars,
          save: !!input.save,
          name: input.name,
        })
      default:
        input satisfies never
        throw new AppError('VALIDATION', 'browser:extract 不认识这个 action。')
    }
  }

  public async extractTable(input: BrowserTableExtractionInput): Promise<BrowserExtractionPayload> {
    const payload = await this.evaluateExtractionScript(
      buildTableExtractionScript({
        selector: input.selector,
        tableIndex: input.tableIndex,
        maxRows: input.maxRows,
      }),
      BrowserTuning.extraction.structuredTimeoutMs
    )
    return this.saveStructured(payload, input)
  }

  public async extractList(input: BrowserListExtractionInput): Promise<BrowserExtractionPayload> {
    const payload = await this.evaluateExtractionScript(
      buildListExtractionScript({ selector: input.selector, maxItems: input.maxItems }),
      BrowserTuning.extraction.structuredTimeoutMs
    )
    return this.saveStructured(payload, input)
  }

  public async paginate(input: BrowserExtractPaginateInput): Promise<BrowserExtractionPayload> {
    // 每页复用列表提取，翻页只负责寻找并点击下一页按钮。
    const allItems: unknown[] = []
    let pagesVisited = 0
    let previousPageItems: Nullable<string> = null
    const nextPageSelector = input.nextPageSelector || BrowserExtractOperations.NextPageSelector

    for (let page = 0; page < input.maxPages; page++) {
      this.ctx.abortSignal.throwIfAborted()

      const pageResult = await this.extractList({
        selector: input.selector,
        maxItems: input.maxItemsPerPage,
        save: false,
      })
      const items = isArray(pageResult.items) ? pageResult.items : []
      // 翻页没生效（按钮点了没反应、链接指回当前页）时条目不变：停下，别把同一页重复收集。
      const pageItems = JSON.stringify(items)
      if (pageItems === previousPageItems) break
      previousPageItems = pageItems
      pagesVisited++
      allItems.push(...items)

      // 当前页没有条目时认为提取结束，避免空页继续翻。
      if (items.length === 0) break
      if (!(await this.advanceToNextPage(nextPageSelector))) break
    }

    const summary = { pagesVisited, totalItems: allItems.length, items: allItems }
    // 默认保存批量提取结果，方便用户后续读取产物而不是重新跑一遍翻页。
    if (!input.save) return summary

    const saved = await this.saveExtraction({
      format: 'json',
      content: `${stringifyPretty(summary)}\n`,
      name: input.name,
    })
    return { ...summary, ...saved }
  }

  public async extractPageContent(
    input: BrowserPageContentExtractionInput
  ): Promise<BrowserExtractionPayload> {
    const payload = await this.evaluateExtractionScript(
      buildPageContentExtractionScript({
        format: input.format,
        selector: input.selector,
        ignoreSelectors: input.ignoreSelectors,
        maxChars: input.maxChars,
      }),
      BrowserTuning.extraction.contentTimeoutMs
    )
    if (!input.save || !isTrue(payload.ok) || !isNonBlankString(payload.content)) return payload

    const saved = await this.saveExtraction({
      format: BrowserPageContentArtifactFormats[input.format],
      content: payload.content,
      name: input.name,
    })
    return { ...payload, ...saved }
  }

  /**
   * 工具入口的共用前置：响应中止信号、确认已经进站点。
   *
   * 只在 `run` 里做一次。四个提取方法自己不做这道门：recipe 的提取步骤是在一次已经进站点的
   * 执行里调它们的，再要求一遍只会让「执行到一半站点被换掉」这种情况报错在错误的地方。
   */
  private begin(): void {
    this.ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(this.ctx)
  }

  /**
   * 在页面上下文执行宿主自建的提取脚本，完整取回它返回的对象。
   *
   * 提取脚本借用通用求值通道 `ctx.browser.evaluateScript`：它恒返回信封，载荷只在 `.result`；
   * 而且这条通道为「模型直读任意脚本结果」做了两道收敛——simplify 把数组截到前 100 项，JSON
   * 文本超过 maxResultChars 时 `.result` 直接置 null。结构化提取要的是完整载荷：直接读 `.result`
   * 会静默丢掉第 100 行之后的表格行，长正文则整份拿不到。所以页面侧先把载荷 JSON.stringify 成
   * 一个字符串（字符串不受 simplify 截断），通道上限按最大值申请，这里再 parse 回来；仍超出上限
   * 就明确失败，绝不把半截结果当完整结果返回。
   */
  private async evaluateExtractionScript(
    script: string,
    timeoutMs: number
  ): Promise<BrowserExtractionPayload> {
    const envelope = await this.ctx.browser.evaluateScript({
      script: `JSON.stringify(${script})`,
      mode: 'expression',
      timeoutMs,
      maxResultChars: BrowserEvaluateMaxResultChars,
    })
    if (!envelope.ok) {
      throw new AppError(
        'EXECUTION_FAILED',
        `页面提取脚本执行失败：${envelope.error?.message ?? '页面没有返回错误信息'}`
      )
    }
    if (envelope.resultTruncated) {
      throw new AppError(
        'EXECUTION_FAILED',
        `提取结果超过页面求值通道上限（${BrowserEvaluateMaxResultChars} 字符），无法完整取回；请调小 maxRows / maxItems / maxChars，或用 selector 缩小范围。`
      )
    }

    const payload: unknown = isString(envelope.result) ? JSON.parse(envelope.result) : null
    if (!isPlainObject(payload)) {
      throw new AppError('EXECUTION_FAILED', '页面提取脚本没有返回结构化结果。')
    }

    return payload
  }

  /** 检查下一页按钮可用就点它，并等页面换完内容；不可用或点不中时返回 false，让调用方停下。 */
  private async advanceToNextPage(nextPageSelector: string): Promise<boolean> {
    const selectorLiteral = encodeBrowserScriptStringLiteral(nextPageSelector)
    // disabled 是布尔属性、值常为空串，只能用 hasAttribute 判断。
    const hasNext = await this.ctx.browser.evaluateScript({
      script: `(() => { const el = document.querySelector(${selectorLiteral}); return !!(el && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true') })()`,
      mode: 'expression',
      timeoutMs: BrowserTuning.extraction.paginateProbeTimeoutMs,
    })
    if (!isTrue(hasNext.result)) return false

    // 点击走宿主端口而不是页面里的 el.click()：后者在宿主的动作策略里被当成「执行脚本」，
    // 绕开了点击该有的遮挡检测与效果指纹。
    const clicked = await this.ctx.browser.performTargetAction({
      action: 'click',
      target: { css: nextPageSelector, role: null, text: null, name: null, attributes: {} },
    })
    if (!clicked.matched) return false

    await TimerScope.sleep(BrowserTuning.extraction.paginateSettleMs, {
      signal: this.ctx.abortSignal,
    })
    return true
  }

  /** 把提取结果写入当前站点 extracts/，返回追加到结果上的落盘路径字段。 */
  private async saveExtraction(input: {
    format: BrowserWorkspaceArtifactFormat
    content: string
    name?: string
  }): Promise<{ savedPath: string; savedRelativePath: string }> {
    const saved = await new BrowserWorkspaceArtifactManager(buildBrowserArtifactAccess(this.ctx)).writeArtifact({
      context: getActiveBrowserContext(this.ctx),
      kind: 'extract',
      format: input.format,
      content: input.content,
      name: input.name,
    })

    return { savedPath: saved.path, savedRelativePath: saved.relativePath }
  }

  /** 表格/列表载荷提取成功且要求保存时，整份写成 extracts/ 下的 JSON 并追加落盘路径。 */
  private async saveStructured(
    payload: BrowserExtractionPayload,
    options: BrowserExtractionSaveOptions
  ): Promise<BrowserExtractionPayload> {
    if (!options.save || !isTrue(payload.ok)) return payload

    const saved = await this.saveExtraction({
      format: 'json',
      content: `${stringifyPretty(payload)}\n`,
      name: options.name,
    })
    return { ...payload, ...saved }
  }
}
