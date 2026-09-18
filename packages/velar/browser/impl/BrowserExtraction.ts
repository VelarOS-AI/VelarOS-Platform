/**
 * 结构化取内容的执行者：`BrowserExtraction` 与整个进程唯一的 `browserExtraction`。接口 `BrowserExtractionApi` 在本文件的类上方。
 * 表格、列表、翻页列表、正文四种，都是在页面里跑本单元生成的提取脚本、完整取回载荷，再按形状交出去；不落盘，要存由程序自己写。
 */

import { isArray, isEmpty, isNumber, isString, isTrue } from '@velaros-ai/core'

import type { BrowserOperationContext } from '../contract/requires.js'
import type {
  BrowserContent,
  BrowserContentInput,
  BrowserList,
  BrowserListInput,
  BrowserListItem,
  BrowserPaginated,
  BrowserPaginateInput,
  BrowserTable,
  BrowserTableInput,
} from '../types/browser.js'
import { advanceToNextPage, runExtractionScript, toListItem } from '../utils/extraction.js'
import {
  buildListExtractionScript,
  buildPageContentExtractionScript,
  buildTableExtractionScript,
} from '../utils/page-scripts/extraction.js'
import { BrowserTuning } from '../utils/tuning.js'

/**
 * 结构化取内容：表格给表头与各行，列表给条目，翻页把各页条目接起来，正文按格式给文字。
 * 提取结果超过页面求值通道的上限时明确失败，绝不把半截结果当完整结果交回。
 */
export interface BrowserExtractionApi {
  /** 取一张表；页面上没有表时 ok 为假并附 error。 */
  table(ctx: BrowserOperationContext, input: Required<Pick<BrowserTableInput, 'tableIndex' | 'maxRows'>> & BrowserTableInput): Promise<BrowserTable>
  /** 按重复出现的容器取一组条目。 */
  list(ctx: BrowserOperationContext, input: Required<Pick<BrowserListInput, 'maxItems'>> & BrowserListInput): Promise<BrowserList>
  /** 逐页取列表再点下一页，翻不动、内容没变或这页是空的就停。 */
  paginate(
    ctx: BrowserOperationContext,
    input: Required<Pick<BrowserPaginateInput, 'maxPages' | 'maxItemsPerPage'>> & BrowserPaginateInput
  ): Promise<BrowserPaginated>
  /** 按格式取页面正文。 */
  content(ctx: BrowserOperationContext, input: Required<Pick<BrowserContentInput, 'format' | 'maxChars'>> & BrowserContentInput): Promise<BrowserContent>
}

export class BrowserExtraction implements BrowserExtractionApi {
  /**
   * 翻页缺省的「下一页」选择器：只认明确自称下一页的元素。
   *
   * 宁可翻不动也不要翻错：点错一次之后收集到的就全是别的页面的内容，而结果上看不出来。
   * 页面用别的写法时由程序显式给 nextPageSelector。
   */
  private static readonly NextPageSelector = [
    'a[rel="next"]',
    'button[rel="next"]',
    'a[aria-label*="next" i]',
    'button[aria-label*="next" i]',
    'a[aria-label*="下一页"]',
    'button[aria-label*="下一页"]',
  ].join(', ')

  public async table(
    ctx: BrowserOperationContext,
    input: Required<Pick<BrowserTableInput, 'tableIndex' | 'maxRows'>> & BrowserTableInput
  ): Promise<BrowserTable> {
    const payload = await runExtractionScript(
      ctx,
      buildTableExtractionScript({ selector: input.selector, tableIndex: input.tableIndex, maxRows: input.maxRows }),
      BrowserTuning.extraction.structuredTimeoutMs
    )
    const table: BrowserTable = {
      ok: isTrue(payload.ok),
      error: isString(payload.error) ? payload.error : null,
      tables: isNumber(payload.tables) ? payload.tables : 0,
      selector: isString(payload.selector) ? payload.selector : null,
      headers: isArray(payload.headers) ? payload.headers.map(String) : [],
      rows: isArray(payload.rows) ? payload.rows.map((row) => (isArray(row) ? row.map(String) : [])) : [],
    }
    if (isString(payload.url)) table.url = payload.url
    return table
  }

  public async list(
    ctx: BrowserOperationContext,
    input: Required<Pick<BrowserListInput, 'maxItems'>> & BrowserListInput
  ): Promise<BrowserList> {
    const payload = await runExtractionScript(
      ctx,
      buildListExtractionScript({ selector: input.selector, maxItems: input.maxItems }),
      BrowserTuning.extraction.structuredTimeoutMs
    )
    const list: BrowserList = {
      ok: isTrue(payload.ok),
      selector: isString(payload.selector) ? payload.selector : null,
      items: isArray(payload.items) ? payload.items.map(toListItem) : [],
    }
    if (isString(payload.url)) list.url = payload.url
    return list
  }

  public async paginate(
    ctx: BrowserOperationContext,
    input: Required<Pick<BrowserPaginateInput, 'maxPages' | 'maxItemsPerPage'>> & BrowserPaginateInput
  ): Promise<BrowserPaginated> {
    const items: BrowserListItem[] = []
    let pagesVisited = 0
    let previousPageItems: Nullable<string> = null
    const nextPageSelector = input.nextPageSelector || BrowserExtraction.NextPageSelector

    for (let page = 0; page < input.maxPages; page++) {
      ctx.abortSignal.throwIfAborted()
      const pageResult = await this.list(ctx, { selector: input.selector, maxItems: input.maxItemsPerPage })
      // 翻页没生效（按钮点了没反应、链接指回当前页）时条目不变：停下，别把同一页重复收集。
      const pageItems = JSON.stringify(pageResult.items)
      if (pageItems === previousPageItems) break
      previousPageItems = pageItems
      pagesVisited++
      items.push(...pageResult.items)
      // 当前页没有条目时认为提取结束，避免空页继续翻。
      if (isEmpty(pageResult.items)) break
      if (!(await advanceToNextPage(ctx, nextPageSelector))) break
    }
    return { pagesVisited, items }
  }

  public async content(
    ctx: BrowserOperationContext,
    input: Required<Pick<BrowserContentInput, 'format' | 'maxChars'>> & BrowserContentInput
  ): Promise<BrowserContent> {
    const payload = await runExtractionScript(
      ctx,
      buildPageContentExtractionScript({
        format: input.format,
        selector: input.selector,
        ignoreSelectors: input.ignoreSelectors,
        maxChars: input.maxChars,
      }),
      BrowserTuning.extraction.contentTimeoutMs
    )
    return {
      ok: isTrue(payload.ok),
      format: input.format,
      selector: isString(payload.selector) ? payload.selector : null,
      content: isString(payload.content) ? payload.content : '',
      truncated: isTrue(payload.truncated),
      url: isString(payload.url) ? payload.url : '',
    }
  }
}

/** 整个进程共用的结构化取内容执行者。 */
export const browserExtraction: BrowserExtractionApi = new BrowserExtraction()
