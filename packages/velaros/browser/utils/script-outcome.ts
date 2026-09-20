/** 页面脚本求值的结局换成程序拿到的东西：成功交回值，失败换成带专属码的错误。 */

import { isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { BrowserErrorCodes } from '../contract/constants.js'
import type { BrowserScriptOutcome } from '../types/browser.js'

/** 成功交回解开的值（脚本返回 undefined 时就是 undefined）；页面里抛错抛 `BROWSER_SCRIPT_FAILED`；结果太大抛 `BROWSER_RESULT_TOO_LARGE`。 */
export function scriptOutcomeValue(outcome: BrowserScriptOutcome): unknown {
  if (outcome.error) throw new AppError(BrowserErrorCodes.scriptFailed, describeScriptError(outcome))
  if (outcome.tooLargeChars) {
    throw new AppError(
      BrowserErrorCodes.resultTooLarge,
      `页面脚本的结果按 JSON 有 ${outcome.tooLargeChars} 个字符，超过了上限：在脚本里先筛、切片，或者分几次取。`
    )
  }
  if (isPresent(outcome.json)) return JSON.parse(outcome.json)
  return undefined
}

/** 页面脚本报错的说明：错误名、原话，定位得到时加上它在 script 里的行列。 */
function describeScriptError(outcome: BrowserScriptOutcome): string {
  const error = outcome.error!
  const position = error.line ? `（script 第 ${error.line} 行${error.column ? `第 ${error.column} 列` : ''}）` : ''
  return `页面脚本抛错${position}：${error.name}: ${error.message}（页面 ${outcome.url}）`
}
