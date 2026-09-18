/** 结构化取内容的底层几步：在页面里跑提取脚本并完整取回载荷、翻到下一页、把列表条目收成固定形状。 */

import { isNonBlankString, isPlainObject, isString, isTrue } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { BrowserOperationContext } from '../contract/requires.js'
import type { BrowserListItem } from '../types/browser.js'
import type { BrowserExtractionPayload } from '../types/operations.js'

import { BrowserEvaluateMaxResultChars } from './page-scripts/evaluate.js'
import { encodeBrowserScriptStringLiteral } from './page-scripts/literal.js'
import { BrowserTuning } from './tuning.js'

/**
 * 在页面上下文执行本单元自建的提取脚本，完整取回它返回的对象。
 *
 * 借用通用求值通道 `ctx.browser.evaluateScript`：它恒返回信封，载荷只在 `.result`；而且这条通道为「直读任意脚本结果」
 * 做了两道收敛——simplify 把数组截到前 100 项，JSON 文本超过 maxResultChars 时 `.result` 直接置 null。结构化提取要的是完整载荷，
 * 所以页面侧先把载荷 JSON.stringify 成一个字符串（字符串不受 simplify 截断），通道上限按最大值申请，这里再 parse 回来；
 * 仍超出上限就明确失败，绝不把半截结果当完整结果交回。
 */
export async function runExtractionScript(ctx: BrowserOperationContext, script: string, timeoutMs: number): Promise<BrowserExtractionPayload> {
  const envelope = await ctx.browser.evaluateScript({
    script: `JSON.stringify(${script})`,
    mode: 'expression',
    timeoutMs,
    maxResultChars: BrowserEvaluateMaxResultChars,
  })
  if (!envelope.ok) {
    throw new AppError('EXECUTION_FAILED', `页面提取脚本执行失败：${envelope.error?.message ?? '页面没有返回错误信息'}`)
  }
  if (envelope.resultTruncated) {
    throw new AppError(
      'EXECUTION_FAILED',
      `提取结果超过页面求值通道上限（${BrowserEvaluateMaxResultChars} 字符），取不全；调小 maxRows、maxItems、maxChars，或用 selector 缩小范围。`
    )
  }
  const payload: unknown = isString(envelope.result) ? JSON.parse(envelope.result) : null
  if (!isPlainObject(payload)) throw new AppError('EXECUTION_FAILED', '页面提取脚本没有返回结构化结果。')
  return payload
}

/** 下一页按钮可用就点它，并等页面换完内容；不可用或点不中时返回 false，让调用方停下。 */
export async function advanceToNextPage(ctx: BrowserOperationContext, nextPageSelector: string): Promise<boolean> {
  const selectorLiteral = encodeBrowserScriptStringLiteral(nextPageSelector)
  // disabled 是布尔属性、值常为空串，只能用 hasAttribute 判断。
  const hasNext = await ctx.browser.evaluateScript({
    script: `(() => { const el = document.querySelector(${selectorLiteral}); return !!(el && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true') })()`,
    mode: 'expression',
    timeoutMs: BrowserTuning.extraction.paginateProbeTimeoutMs,
  })
  if (!isTrue(hasNext.result)) return false

  // 点击走空间端口而不是页面里的 el.click()：后者在宿主的动作策略里被当成「执行脚本」，绕开了点击该有的遮挡检测与效果指纹。
  const clicked = await ctx.browser.performTargetAction({
    action: 'click',
    target: { css: nextPageSelector, role: null, text: null, name: null, attributes: {} },
  })
  if (!clicked.matched) return false

  await TimerScope.sleep(BrowserTuning.extraction.paginateSettleMs, { signal: ctx.abortSignal })
  return true
}

/** 页面脚本给的一条列表条目，收成固定形状。 */
export function toListItem(value: unknown): BrowserListItem {
  const item = isPlainObject(value) ? value : {}
  return {
    title: isNonBlankString(item.title) ? item.title : '',
    href: isString(item.href) ? item.href : null,
    description: isString(item.description) ? item.description : null,
  }
}
