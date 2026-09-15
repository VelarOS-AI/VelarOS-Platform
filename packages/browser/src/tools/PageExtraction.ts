import {
  isNonBlankString,
  isPlainObject,
  isString,
  isTrue,
  stringifyPretty,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserWorkspaceArtifactFormat } from '../core'
import { BrowserEvaluateMaxResultChars, BrowserPageScriptBuilder } from '../core'

import { createArtifactManager, getActiveBrowserContext } from './Context'
import { createBrowserPageContentBoundary } from './PageContentBoundary'
import type { ToolContext } from './Types'

/** 页面提取脚本返回的载荷：页面侧构造的纯 JSON 对象。 */
type BrowserExtractionPayload = Record<string, unknown>

type BrowserPageContentFormat = 'plain' | 'markdown' | 'html'

/** 提取结果的落盘选项。 */
interface BrowserExtractionSaveOptions {
  /** 是否把提取结果写入当前站点 extracts/。 */
  save: boolean
  /** 产物名称；省略时由 artifact manager 生成。 */
  name?: string
}

interface BrowserTableExtractionInput extends BrowserExtractionSaveOptions {
  selector?: string
  tableIndex: number
  maxRows: number
}

interface BrowserListExtractionInput extends BrowserExtractionSaveOptions {
  selector?: string
  maxItems: number
}

interface BrowserPageContentExtractionInput extends BrowserExtractionSaveOptions {
  format: BrowserPageContentFormat
  selector?: string
  ignoreSelectors?: string[]
  maxChars: number
}

const BrowserStructuredExtractionTimeoutMs = 10_000
const BrowserPageContentExtractionTimeoutMs = 15_000

/** 正文格式到 extract 产物格式（决定 .txt / .md / .html 扩展名）的映射。 */
const BrowserPageContentArtifactFormats: Record<BrowserPageContentFormat, BrowserWorkspaceArtifactFormat> = {
  plain: 'text',
  markdown: 'markdown',
  html: 'html',
}

/**
 * 在页面上下文执行宿主自建的提取脚本，完整取回它返回的对象。
 *
 * 提取脚本借用通用求值通道 `ctx.browser.evaluateScript`：它恒返回 BrowserEvaluateScriptResult
 * 信封，载荷只在 `.result`；而且这条通道为「模型直读任意脚本结果」做了两道收敛——simplify 把
 * 数组截到前 100 项，JSON 文本超过 maxResultChars（默认 2 万字符）时 `.result` 直接置 null。
 * 结构化提取要的是完整载荷：直接读 `.result` 会静默丢掉第 100 行之后的表格行，长正文则整份
 * 拿不到。所以页面侧先把载荷 JSON.stringify 成一个字符串（字符串不受 simplify 截断），通道上限
 * 按最大值申请，工具侧再 parse 回来；仍超出上限就明确失败，绝不把半截结果当完整结果返回。
 */
async function evaluateBrowserExtractionScript(
  ctx: ToolContext,
  script: string,
  timeoutMs: number
): Promise<BrowserExtractionPayload> {
  const envelope = await ctx.browser.evaluateScript({
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

/** 把提取结果写入当前站点 extracts/，返回追加到结果上的落盘路径字段。 */
async function saveBrowserExtraction(
  ctx: ToolContext,
  input: { format: BrowserWorkspaceArtifactFormat; content: string; name?: string }
): Promise<{ savedPath: string; savedRelativePath: string }> {
  const saved = await createArtifactManager(ctx).writeArtifact({
    context: getActiveBrowserContext(ctx),
    kind: 'extract',
    format: input.format,
    content: input.content,
    name: input.name,
  })

  return { savedPath: saved.path, savedRelativePath: saved.relativePath }
}

/** 表格/列表载荷提取成功且要求保存时，整份写成 extracts/ 下的 JSON 并追加落盘路径。 */
async function saveStructuredExtraction(
  ctx: ToolContext,
  payload: BrowserExtractionPayload,
  options: BrowserExtractionSaveOptions
): Promise<BrowserExtractionPayload> {
  if (!options.save || !isTrue(payload.ok)) return payload

  const saved = await saveBrowserExtraction(ctx, {
    format: 'json',
    content: `${stringifyPretty(payload)}\n`,
    name: options.name,
  })
  return { ...payload, ...saved }
}

/**
 * 提取表格：返回 headers / rows / rowCount 等字段；没找到表格时 ok=false 并附 error，不落盘。
 * save=true 且提取成功时追加 savedPath / savedRelativePath。
 */
async function extractBrowserTable(
  ctx: ToolContext,
  input: BrowserTableExtractionInput
): Promise<BrowserExtractionPayload> {
  const payload = await evaluateBrowserExtractionScript(
    ctx,
    new BrowserPageScriptBuilder().buildTableExtractionScript({
      selector: input.selector,
      tableIndex: input.tableIndex,
      maxRows: input.maxRows,
    }),
    BrowserStructuredExtractionTimeoutMs
  )
  return saveStructuredExtraction(ctx, payload, input)
}

/** 提取列表：返回 items（title / href / description）与 itemCount；save=true 时追加落盘路径。 */
async function extractBrowserList(
  ctx: ToolContext,
  input: BrowserListExtractionInput
): Promise<BrowserExtractionPayload> {
  const payload = await evaluateBrowserExtractionScript(
    ctx,
    new BrowserPageScriptBuilder().buildListExtractionScript({
      selector: input.selector,
      maxItems: input.maxItems,
    }),
    BrowserStructuredExtractionTimeoutMs
  )
  return saveStructuredExtraction(ctx, payload, input)
}

/**
 * 提取可见正文：返回 content / format / truncated 等字段，并附 contentBoundary 标明 content
 * 是来自该站点的不可信网页内容。save=true 且正文非空时按 format 写成 extracts/ 下的
 * .txt / .md / .html，并追加 savedPath / savedRelativePath。
 */
async function extractBrowserPageContent(
  ctx: ToolContext,
  input: BrowserPageContentExtractionInput
): Promise<BrowserExtractionPayload> {
  const context = getActiveBrowserContext(ctx)
  const payload = await evaluateBrowserExtractionScript(
    ctx,
    new BrowserPageScriptBuilder().buildPageContentExtractionScript({
      format: input.format,
      selector: input.selector,
      ignoreSelectors: input.ignoreSelectors,
      maxChars: input.maxChars,
    }),
    BrowserPageContentExtractionTimeoutMs
  )
  const result = { ...payload, contentBoundary: createBrowserPageContentBoundary(context.url) }
  if (!input.save || !isTrue(payload.ok) || !isNonBlankString(payload.content)) return result

  const saved = await saveBrowserExtraction(ctx, {
    format: BrowserPageContentArtifactFormats[input.format],
    content: payload.content,
    name: input.name,
  })
  return { ...result, ...saved }
}

export { extractBrowserList, extractBrowserPageContent, extractBrowserTable, saveBrowserExtraction }
