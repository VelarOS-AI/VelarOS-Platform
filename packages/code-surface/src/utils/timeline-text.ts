/**
 * 时间线写成给模型读的文字：exec 回执里每一步的段头与改动、外部改动，history 的每一行，show 的详情，diff 的文件差。
 * 都是纯函数：要读的东西（代码、参数、结果）由调用方先取好再交进来。
 */

import { isEmpty, isString, isUndefined } from '@velaros-ai/core'

import { CodeSurfaceLimits } from '../contract/constants.js'
import type { CompletedCall, ScriptFileChange } from '../types/code-surface.js'
import type { ScriptVersionRecord, TimelineCallView, TimelinePoint, TimelineStepRecord } from '../types/timeline.js'

import { shortHash } from './markers.js'
import { callRef, stepRef, versionRef } from './refs.js'
import { CodeSurfaceTuning } from './tuning.js'

/** 两位数补零。 */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 时刻写成本地的 `09-18 14:03`。 */
export function formatMoment(at: number): string {
  const date = new Date(at)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 一个时间点写成「C12.2 之后」或「C13 开头」。 */
export function formatPoint(point: TimelinePoint): string {
  return point.start ? `${point.ref} 开头` : `${point.ref} 之后`
}

/** 改过的文件点名：新增的标「新」、删掉的标「删」，多了只点前几个，说「等 N 个」。 */
export function nameChanges(changes: readonly ScriptFileChange[]): string {
  const named = changes.slice(0, CodeSurfaceTuning.historyFileNames).map((change) => {
    if (isUndefined(change.before)) return `${change.path}（新）`
    if (isUndefined(change.after)) return `${change.path}（删）`
    return change.path
  })
  const more = changes.length - named.length
  return `${named.join('、')}${more > 0 ? ` 等 ${changes.length} 个` : ''}`
}

/** 一步改了哪些文件的那一句。 */
export function describeChanges(changes: readonly ScriptFileChange[]): string {
  return `改了 ${changes.length} 个文件：${nameChanges(changes)}`
}

/** 调用开头发现的外部改动：哪些文件，现在和之前哪个时间点一样（有的话）。 */
export function describeExternal(changes: readonly ScriptFileChange[], same: Optional<TimelinePoint>): string {
  const back = same ? `现在工作区和 ${formatPoint(same)}一模一样。` : ''
  return `开头发现：上次记录之后，工作区被外面改了 ${changes.length} 个文件：${nameChanges(changes)}。${back}`
}

/** 逐个文件列出改动：每行「改 / 新增 / 删除」、路径、前后哈希（前八位）。 */
export function listChanges(changes: readonly ScriptFileChange[]): string[] {
  return changes.map((change) => {
    const kind = isUndefined(change.before) ? '新增' : isUndefined(change.after) ? '删除' : '改'
    return `  ${kind} ${change.path}  ${shortHash(change.before)} → ${shortHash(change.after)}`
  })
}

/** 参数写进一行：短的原样摆出来，长的只说有多长。 */
function describeInput(text: Optional<string>): string {
  if (isUndefined(text)) return ''
  return text.length <= CodeSurfaceTuning.historyInputChars ? ` · input ${text}` : ` · input ${text.length} 字`
}

/** 一步做的是什么：写成段头与时间线里那一行的主体。 */
export function describeStepSubject(step: TimelineStepRecord): string {
  const saved = step.path && !isUndefined(step.version) ? ` → ${versionRef(step.path, step.version)}` : ''
  if (step.op === 'write') return `write ${step.path ?? ''}${saved}`
  if (step.op === 'edit') return `edit ${step.base ?? step.path ?? ''}${saved}`
  if (step.op === 'restore') return `restore ${step.base ?? step.path ?? ''}${saved}`
  if (step.op === 'replay') return `replay ${step.replayOf ?? ''}`
  return isUndefined(step.base) ? 'run 直接跑的代码' : `run from ${step.base}`
}

/** 一步成没成的那几个字。 */
function describeStatus(step: TimelineStepRecord): string {
  return step.ok ? '成功' : `没成（${step.error?.code ?? '原因不明'}）`
}

/**
 * 时间线里一步的那一行：步骤号、做的什么、参数、成没成、改了哪些文件。
 * inputText 是这一步的参数原文（JSON），调用方取好交进来；没有参数时不给。
 */
export function historyStepLine(step: TimelineStepRecord, inputText: Optional<string>): string {
  const changes = step.changes && !isEmpty(step.changes) ? ` · ${describeChanges(step.changes)}` : ''
  const cleared = step.dropped?.includes('input') ? ' · 参数已清' : ''
  return `  ${stepRef(step.call, step.step)} ${describeStepSubject(step)}${describeInput(inputText)}${cleared} · ${describeStatus(step)}${changes}`
}

/** 时间线里一次调用的那一行：调用号、时刻、几步、是不是别的会话、开头发现的外部改动。 */
export function historyCallLine(view: TimelineCallView, sessionId: string, same: Optional<TimelinePoint>): string {
  const parts = [callRef(view.record.call), formatMoment(view.record.at), `${view.steps.length} 步`]
  if (view.record.session !== sessionId) parts.push('别的会话')
  const external = view.record.external
  if (external && !isEmpty(external)) parts.push(`外部改动 ${external.length} 个文件：${nameChanges(external)}${same ? `（和 ${formatPoint(same)}一样）` : ''}`)
  return parts.join(' · ')
}

/** 调过的能力写成一行：连着的同一件事带 ×次数，带 changeRef 的写出它和它改的文件。 */
export function describeCalls(calls: readonly CompletedCall[]): string {
  return calls.map((entry) => {
    const times = isUndefined(entry.times) ? '' : ` ×${entry.times}`
    const failed = entry.ok ? '' : '（失败）'
    const change = isString(entry.changeRef) ? `（changeRef ${entry.changeRef}${entry.changedFiles && !isEmpty(entry.changedFiles) ? `：${entry.changedFiles.join('、')}` : ''}）` : ''
    return `${entry.call}${times}${failed}${change}`
  }).join('、')
}

/** 脚本库目录：每个脚本一行，最新版、什么时候由哪一步存的、正文的第一行说明（有的话）。 */
export function renderLibrary(library: ReadonlyMap<string, readonly ScriptVersionRecord[]>, summaries: ReadonlyMap<string, string>): string {
  if (library.size === 0) return '脚本库是空的。用 script:exec 的 write 把要反复用的代码存进来（比如 lib/changelog.js），别的脚本用相对路径 import 它。'
  const lines = [`脚本库里有 ${library.size} 个脚本：`]
  for (const [path, versions] of library) {
    const latest = versions.at(-1)
    if (isUndefined(latest)) continue
    const summary = summaries.get(path)
    lines.push(`${versionRef(path, latest.version)} · ${formatMoment(latest.at)} 由 ${latest.step} 存${summary ? ` · ${summary}` : ''}`)
  }
  return lines.join('\n')
}

/** 脚本正文开头那句说明：第一行是注释就取它（去掉注释记号），不是就没有。 */
export function leadingComment(source: string): Optional<string> {
  const first = source.split('\n').find((line) => !isEmpty(line.trim()))?.trim() ?? ''
  const matched = /^(?:\/\/+|\/\*+|\*)\s*(.*?)\s*(?:\*\/)?$/u.exec(first)
  const text = matched?.[1]
  return text && !isEmpty(text) ? text : undefined
}

/** 整份回执最后守一道总上限（一次调用的几步合起来算）：超了保留开头（要紧的在前面），说明省了多少、剩下的去哪看。 */
export function fitReply(text: string): string {
  if (text.length <= CodeSurfaceLimits.resultChars) return text
  const dropped = text.length - CodeSurfaceLimits.resultChars
  return `${text.slice(0, CodeSurfaceLimits.resultChars)}\n…后面 ${dropped} 字省略；要看的那一段用 script:show 单看。`
}
