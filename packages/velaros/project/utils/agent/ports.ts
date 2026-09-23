/**
 * `velaros:project`、`velaros:code` 两件工具用到的纯判定：失败怎么翻成交给程序的错误、路径怎么换成项目内的写法、越界怎么拒。
 */

import { resolve } from 'node:path'

import {
  isArray,
  isEmpty,
  isNumber,
  isPlainObject,
  isPresent,
  isString,
  isTrue,
  optionalWhen,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'

import type { ProjectOperationContext } from '../../contract/requires.js'
import { ProjectError } from '../errors.js'
import { resolveInsideProject } from '../files/path-containment.js'

/** 空间端口抛的通用码对应到哪个原因码：项目的能力只用一套码。 */
const ReasonOfAppCode: Readonly<Record<string, string>> = Object.freeze({
  PERMISSION: 'PERMISSION_DENIED',
  VALIDATION: 'INVALID_INPUT',
  NOT_FOUND: 'TARGET_NOT_FOUND',
})

/** 候选的可信程度怎么说。 */
const ConfidenceLabels: Readonly<Record<string, string>> = Object.freeze({
  exact: '完全一致',
  whitespace: '只差空白',
  similar: '相近',
})

/** 行号或区间写成「第 a 行」「第 a–b 行」。 */
function linesLabel(range: unknown): string {
  if (isNumber(range)) return `第 ${range} 行`
  if (isArray(range) && isNumber(range[0]))
    return isNumber(range[1]) && range[1] !== range[0]
      ? `第 ${range[0]}–${range[1]} 行`
      : `第 ${range[0]} 行`
  return ''
}

/** 一个候选位置：在哪几行、有多像、原文是什么、差在哪儿。 */
function candidateLine(candidate: Record<string, unknown>): string {
  const confidence = isString(candidate.confidence)
    ? (ConfidenceLabels[candidate.confidence] ?? candidate.confidence)
    : undefined
  const where = [
    linesLabel(candidate.range),
    isPresent(confidence) ? `（${confidence}）` : '',
  ].join('')
  const text = isString(candidate.text)
    ? `：${JSON.stringify(candidate.text)}${isTrue(candidate.truncated) ? '（截断了）' : ''}`
    : ''
  const differences =
    isArray(candidate.differences) && candidate.differences.every(isString)
      ? `，差在：${candidate.differences.join('；')}`
      : ''
  return `  - ${where}${text}${differences}`
}

/** 一条诊断：路径:行:列 说明。 */
function diagnosticLine(diagnostic: Record<string, unknown>): string {
  const location = [diagnostic.path, diagnostic.line, diagnostic.column]
    .filter((part) => isString(part) || isNumber(part))
    .join(':')
  return `  - ${location ? `${location} ` : ''}${String(diagnostic.message ?? '')}`
}

/** 改完之后的候选预览（没写进磁盘）：出错那几行。 */
function previewText(window: Record<string, unknown>): Optional<string> {
  if (!isArray(window.lines)) return undefined
  const lines = window.lines.filter(
    (line): line is [number, string] => isArray(line) && isNumber(line[0]) && isString(line[1])
  )
  if (isEmpty(lines)) return undefined
  const title = [window.path, window.line]
    .filter((part) => isString(part) || isNumber(part))
    .join(':')
  return `改完之后（没写进去）${title ? ` ${title}` : ''} 附近是这样：\n${lines.map(([line, text]) => `  ${line}: ${text}`).join('\n')}`
}

/** 把一个项目错误写成交给程序的说明：位置、说明、候选、诊断、预览，最后是下一步。 */
function describeProjectFailure(error: ProjectError): string {
  const details = isPlainObject(error.details) ? error.details : {}
  const where = [
    Number.isInteger(details.stepIndex) ? `steps[${String(details.stepIndex)}]` : '',
    Number.isInteger(details.editIndex) ? `edits[${String(details.editIndex)}]` : '',
  ]
    .filter(Boolean)
    .join('.')
  const parts = [where ? `${where}：${error.message}` : error.message]
  const recovery = optionalWhen(isPlainObject, details.recovery)
  const candidates = isArray(recovery?.candidates) ? recovery.candidates.filter(isPlainObject) : []
  if (candidates.length) parts.push(`候选：\n${candidates.map(candidateLine).join('\n')}`)
  const diagnostics = isArray(details.diagnostics) ? details.diagnostics.filter(isPlainObject) : []
  if (diagnostics.length) parts.push(`诊断：\n${diagnostics.map(diagnosticLine).join('\n')}`)
  const previews = isArray(recovery?.windows)
    ? recovery.windows.filter(isPlainObject).map(previewText).filter(isString)
    : []
  parts.push(...previews)
  if (error.suggestedNextAction) parts.push(`下一步：${error.suggestedNextAction}`)
  return parts.join('\n')
}

/**
 * 把失败翻成交给程序的样子：代码面只把 error.code 与 error.message 交出去，所以项目错误的 `reason` 当错误码（程序按它分支），
 * details 里的位置、候选、诊断与下一步都写进 message——不写进去就等于没说；空间端口抛的通用码换成对应的原因码，别的原样抛回去。
 */
export function projectFailure(error: unknown): unknown {
  if (error instanceof ProjectError)
    return new AppError(error.reason, describeProjectFailure(error), error)
  if (error instanceof AppError && ReasonOfAppCode[error.code])
    return new AppError(ReasonOfAppCode[error.code]!, error.message, error, error.context)
  return error
}

/**
 * 把项目内的绝对路径换成相对项目根的写法：内核、写授权、事务一律用相对路径。
 * 两个根都要认——项目根可能是符号链接（macOS 的 /var 就是 /private/var 的链接），
 * 而定位给出的是解开链接后的真实路径，只按字面根去掉前缀会漏出一条绝对路径。
 */
export function relativeToRoot(roots: readonly string[], target: string): string {
  const matched = roots.find(
    (root) => target === root || target.startsWith(`${root}/`) || target.startsWith(`${root}\\`)
  )
  const relative = matched ? target.slice(matched.length) : target
  return relative.replace(/^[\\/]+/u, '') || '.'
}

/**
 * 把模型给的路径钳在项目之内，返回解析后的绝对路径与解开符号链接后的真实路径。
 * 判定按**真实路径**算：只看字面时，项目里一个指向项目外的链接就能把读写引到项目外面去。
 */
export async function insideProject(
  root: string,
  requested: string,
  what: '文件' | '工作目录' | '沙箱的源目录'
): Promise<{ resolved: string; realPath: string }> {
  const { resolved, realPath, inside } = await resolveInsideProject(root, requested)
  if (!inside) {
    throw new AppError(
      'PERMISSION',
      `${what}必须在当前项目之内：${requested}（经符号链接指到项目外的也不行）；项目空间只碰项目里的东西，要碰外面的换系统空间`
    )
  }
  return { resolved, realPath }
}

/**
 * 把模型给的文件路径定到项目里，交回相对项目根的写法（项目根本身是空串）：越出项目（含经符号链接指到外面的）抛 PERMISSION。
 * 项目根自己可能是符号链接（macOS 的 /var 就是 /private/var），模型给的绝对路径两种写法都认。
 */
export async function projectRelativePath(
  ctx: ProjectOperationContext,
  requested: string
): Promise<string> {
  const root = resolve(ctx.project.getRootPath())
  const { resolved } = await insideProject(root, requested, '文件')
  const relative = relativeToRoot([root, await resolveRealPath(root)], resolved)
  return relative === '.' ? '' : relative
}
