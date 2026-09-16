/**
 * 模型给的正则的执行护栏：整次扫描放进 `node:vm` 的带时限脚本里跑，灾难回溯不再把主进程卡死。
 * 时限在 `ProjectTuning.regex.executionTimeoutMs`；写错的正则与跑不完都翻成 INVALID_INPUT，带中文下一步。
 */

import { createContext, Script } from 'node:vm'

import { AppError } from '@velaros-ai/core/error'

import type { GuardedRegexMatch } from '../types/text.js'

import { ProjectError } from './errors.js'
import { ProjectTuning } from './tuning.js'

/**
 * 整次扫描必须在一段受时限保护的脚本里跑完：`Script.runInContext` 的 timeout 只覆盖这一次调用，
 * 把扫描循环留在宿主里逐次调用 vm 就没有保护。空匹配按码点前进，与 `nextCodePointOffset` 同口径。
 */
const scanScript = new Script(
  `(function () {
  const regex = new RegExp(pattern, flags)
  const matches = []
  let match
  while (matches.length < limit * 2 && (match = regex.exec(content)) !== null) {
    matches.push(match.index, match[0].length)
    if (match[0].length === 0) {
      const codePoint = content.codePointAt(regex.lastIndex)
      regex.lastIndex += codePoint !== undefined && codePoint > 0xffff ? 2 : 1
    }
  }
  return matches
})()`,
  { filename: 'velaros-project-regex-guard.js' },
)

/** 正则写错时的失败：报 INVALID_INPUT，说明是哪条 pattern。 */
function invalidPattern(pattern: string, message: string): ProjectError {
  return new ProjectError(
    'INVALID_INPUT',
    `正则表达式无效：${pattern}`,
    { pattern, error: message },
    '请改写成合法的 JavaScript 正则，或去掉 regex 改用字面文本查询。',
  )
}

/** 扫描跑不完时的失败：报 INVALID_INPUT，让模型换不会灾难回溯的写法。 */
function patternTimedOut(pattern: string, timeoutMs: number): ProjectError {
  return new ProjectError(
    'INVALID_INPUT',
    `正则表达式在 ${timeoutMs} 毫秒内没跑完，已中止：${pattern}`,
    { pattern, timeoutMs },
    '请把嵌套的重复（如 (a+)+）改写成不会回溯爆炸的形式，或先用字面文本缩小范围再匹配。',
  )
}

/** 跨 realm 的错误只能按名字认：vm 里抛出的 SyntaxError 不是宿主 realm 的那一个。 */
function isSyntaxError(error: unknown): boolean {
  return (error as Nullable<{ name?: unknown }>)?.name === 'SyntaxError'
}

/**
 * 在时限内跑完一次正则扫描，返回最多 limit 条命中的起点与长度。
 * 正则本身写错抛 INVALID_INPUT；跑不完也抛 INVALID_INPUT（V8 能在回溯途中中断；Bun 的正则引擎不回溯，正常跑完）。
 */
export function execGuardedRegex(
  pattern: string,
  flags: string,
  content: string,
  limit: number,
): GuardedRegexMatch[] {
  if (limit <= 0) return []
  const timeoutMs = ProjectTuning.regex.executionTimeoutMs
  let flat: number[]
  try {
    flat = scanScript.runInContext(createContext({ pattern, flags, content, limit }), { timeout: timeoutMs }) as number[]
  } catch (error) {
    throw isSyntaxError(error) ? invalidPattern(pattern, AppError.getMessage(error)) : patternTimedOut(pattern, timeoutMs)
  }
  const matches: GuardedRegexMatch[] = []
  for (let index = 0; index + 1 < flat.length; index += 2) {
    matches.push({ index: flat[index]!, length: flat[index + 1]! })
  }
  return matches
}
