/**
 * 读时间线给模型看：`ScriptTimelineViews`，接口 `ScriptTimelineViewsApi` 在本文件的类上方；门每次查询建一个。
 *
 * `script:history` 列调用与步骤；`script:show` 看一次调用、一步、一版脚本，或者脚本库目录；
 * `script:diff` 比两版代码（逐行）或者两个时间点之间的工作区（按文件，只有哈希）。只读，不改时间线。
 */

import { isEmpty, isNull, isString, isUndefined } from '@velaros-ai/core'

import { CodeSurfaceLimits } from '../contract/constants.js'
import type { ScriptDiffInput, ScriptHistoryInput, ScriptShowInput } from '../types/gate.js'
import type { TimelineRef, TimelineStepRecord } from '../types/timeline.js'
import { unifiedLineDiff } from '../utils/line-diff.js'
import { callRef, parseCallBound, parseTimelineRef, stepRef, versionRef } from '../utils/refs.js'
import { markerAt, selectHistory } from '../utils/timeline.js'
import {
  describeCalls,
  describeStepSubject,
  fitReply,
  formatMoment,
  formatPoint,
  historyCallLine,
  historyStepLine,
  leadingComment,
  listChanges,
  renderLibrary,
} from '../utils/timeline-text.js'

import type { ScriptTimelineApi } from './ScriptTimeline.js'

/** 给模型看的时间线：列、看、比。 */
export interface ScriptTimelineViewsApi {
  /** 列时间线上的调用与步骤，最新的在后面；按脚本、文件、调用号的范围筛，最多列 limit 条。 */
  history(query: ScriptHistoryInput): Promise<string>
  /** 看一样东西：调用、步骤、一版脚本；不给 ref 是脚本库目录；给了 blob 只看那一步 blobs 里的那一段。 */
  show(query: ScriptShowInput): Promise<string>
  /** 比两样东西：两版代码逐行比，两个时间点之间的工作区按文件比。 */
  diff(query: ScriptDiffInput, signal?: AbortSignal): Promise<string>
}

export class ScriptTimelineViews implements ScriptTimelineViewsApi {
  /** 查哪条时间线、谁在看（history 据此标出别的会话的调用）。 */
  public constructor(
    private readonly timeline: ScriptTimelineApi,
    private readonly sessionId: string,
  ) {}

  public async history(query: ScriptHistoryInput): Promise<string> {
    const timeline = this.timeline
    const bounds = { from: parseCallBound(query.from), to: parseCallBound(query.to) }
    if (isNull(bounds.from) || isNull(bounds.to)) return 'from、to 要写成调用号，比如 C10。'
    const limit = Math.min(Math.max(query.limit ?? CodeSurfaceLimits.historyDefaultEntries, 1), CodeSurfaceLimits.historyEntries)
    const selected = selectHistory(timeline.calls(), { script: query.script, file: query.file, from: bounds.from, to: bounds.to, limit })
    if (isEmpty(selected.calls)) return isEmpty(timeline.calls()) ? '时间线上还没有记录。' : '没有符合条件的记录。'
    const lines: string[] = []
    if (selected.omitted > 0) lines.push(`（更早的还有 ${selected.omitted} 条，用 from、to 圈一段或者加大 limit 看。）`)
    for (const { view, steps } of selected.calls) {
      const same = view.record.marker && view.record.external ? timeline.pointsAt(view.record.marker).find((point) => point.ref !== callRef(view.record.call)) : undefined
      lines.push(historyCallLine(view, this.sessionId, same))
      for (const step of steps) lines.push(historyStepLine(step, await this.inputText(step)))
    }
    return fitReply(lines.join('\n'))
  }

  public async show(query: ScriptShowInput): Promise<string> {
    const timeline = this.timeline
    const { ref, blob } = query
    if (isUndefined(ref)) {
      const summaries = new Map<string, string>()
      for (const [path, versions] of timeline.library()) {
        const latest = versions.at(-1)
        const source = latest ? await timeline.get(latest.code) : undefined
        const summary = isUndefined(source) ? undefined : leadingComment(source)
        if (!isUndefined(summary)) summaries.set(path, summary)
      }
      return fitReply(renderLibrary(timeline.library(), summaries, timeline.removedScripts()))
    }
    const parsed = parseTimelineRef(ref)
    if (isString(parsed)) return parsed
    if (parsed.kind === 'now') return 'now 是时间点：现在和某一点差了什么，用 script:diff（from 填那一点，to 不给）。'
    if (parsed.kind === 'script') return this.showScript(parsed.path, parsed.version)
    if (parsed.kind === 'call') return this.showCall(parsed.call)
    return this.showStep(parsed.call, parsed.step, blob)
  }

  public async diff(query: ScriptDiffInput, signal?: AbortSignal): Promise<string> {
    const { from, to, of } = query
    const left = parseTimelineRef(from)
    const right = isUndefined(to) ? undefined : parseTimelineRef(to)
    if (isString(left)) return left
    if (isString(right)) return right
    const isPoint = (ref: Optional<TimelineRef>): boolean => ref?.kind === 'call' || ref?.kind === 'now'
    const kind = of ?? (isPoint(left) || isPoint(right) ? 'files' : 'code')
    return kind === 'files'
      ? this.diffFiles(left, right ?? { kind: 'now' }, signal)
      : this.diffCode(left, right)
  }

  /** 一版脚本：哪一步存的、各版本、正文。 */
  private async showScript(path: string, version: Optional<number>): Promise<string> {
    const timeline = this.timeline
    const versions = timeline.versions(path)
    const record = timeline.version(path, version)
    const removed = timeline.removedScripts().get(path)
    if (isUndefined(record) && removed && isUndefined(version)) return `${path} 已经从脚本库里拿掉了（最后一版 @${removed.version}）：要看就写 ${versionRef(path, removed.version)}，要找回来用 restore。`
    if (isUndefined(record)) return isEmpty(versions)
        ? `脚本库里没有 ${path}。用 script:show（不给 ref）看库里有哪些。`
        : `${path} 没有第 ${version ?? 0} 版；有的是 ${versions.map((entry) => `@${entry.version}`).join('、')}。`
    const source = await timeline.get(record.code)
    const latest = timeline.version(path)
    const state = isUndefined(latest) ? '已经从脚本库里拿掉了' : `最新是 @${latest.version}`
    return fitReply([
      `${versionRef(path, record.version)}（${state}）· ${formatMoment(record.at)} 由 ${record.step} 存`,
      `各版本：${versions.map((entry) => `@${entry.version} ${entry.step}`).join(' · ')}`,
      '── 正文 ──',
      source ?? '（正文找不到了）',
    ].join('\n'))
  }

  /** 一次调用：开头那一行、外部改动逐个文件、每一步一行。 */
  private async showCall(call: number): Promise<string> {
    const timeline = this.timeline
    const view = timeline.call(call)
    if (isUndefined(view)) return `时间线上没有 ${callRef(call)}。用 script:history 看有哪些调用。`
    const lines = [historyCallLine(view, this.sessionId, undefined)]
    if (view.record.external && !isEmpty(view.record.external)) {
      const same = view.record.marker ? timeline.pointsAt(view.record.marker).find((point) => point.ref !== callRef(call)) : undefined
      lines.push(`开头发现的外部改动${same ? `（改完和 ${formatPoint(same)}一样）` : ''}：`, ...listChanges(view.record.external))
    }
    for (const step of view.steps) lines.push(historyStepLine(step, await this.inputText(step)))
    return fitReply(lines.join('\n'))
  }

  /** 一步的全部：做的什么、代码、参数、结果、调过的能力、改了哪些文件；给了 blob 就只看那一段 blobs。 */
  private async showStep(call: number, index: number, blob: Optional<string>): Promise<string> {
    const timeline = this.timeline
    const step = timeline.step(call, index)
    const ref = stepRef(call, index)
    if (isUndefined(step)) return `时间线上没有 ${ref}。用 script:history 看有哪些步骤。`
    const blobs = isUndefined(step.blobs) ? {} : JSON.parse((await timeline.get(step.blobs)) ?? '{}') as Record<string, string>
    if (!isUndefined(blob)) {
      const text = blobs[blob]
      return isUndefined(text) ? `${ref} 的 blobs 里没有 ${blob}；有的是 ${Object.keys(blobs).join('、') || '（没有 blobs）'}。` : fitReply(text)
    }
    const lines = [`${ref} ${describeStepSubject(step)} · ${formatMoment(step.at)} · ${step.ms} ms · ${step.ok ? '成功' : `没成（${step.error?.code ?? '原因不明'}）`}`]
    if (step.deps && !isEmpty(Object.keys(step.deps))) lines.push(`用到库里的：${Object.entries(step.deps).map(([path, version]) => versionRef(path, version)).join('、')}`)
    const input = await this.inputText(step)
    if (!isUndefined(input)) lines.push(`input：${input}`)
    if (!isEmpty(Object.keys(blobs))) lines.push(`blobs：${Object.entries(blobs).map(([name, text]) => `${name}（${text.length} 字）`).join('、')}（单看一段：blob 填名字）`)
    if (step.dropped && !isEmpty(step.dropped)) lines.push(`时间线的保留上限清掉了：${step.dropped.map((part) => (part === 'input' ? '参数（不能再重放）' : '结果正文')).join('、')}`)
    if (step.calls && !isEmpty(step.calls)) lines.push(`调过的能力：${describeCalls(step.calls)}`)
    if (step.changes && !isEmpty(step.changes)) lines.push(`改了 ${step.changes.length} 个文件：`, ...listChanges(step.changes))
    const source = isUndefined(step.code) ? undefined : await timeline.get(step.code)
    if (!isUndefined(source)) lines.push('── 代码 ──', source)
    const result = isUndefined(step.result) ? undefined : await timeline.get(step.result)
    if (!isUndefined(result)) lines.push('── 结果 ──', result)
    return fitReply(lines.join('\n'))
  }

  /** 两版代码逐行比：to 不给时比 from 那个脚本的最新版。 */
  private async diffCode(left: TimelineRef, right: Optional<TimelineRef>): Promise<string> {
    const target = right ?? (left.kind === 'script' ? { kind: 'script' as const, path: left.path } : undefined)
    if (isUndefined(target)) return '比代码要给 to：另一版脚本（lib/x.js@3）或者另一步（C12.2）。'
    const before = await this.codeOf(left)
    const after = await this.codeOf(target)
    if ('failed' in before) return before.failed
    if ('failed' in after) return after.failed
    return unifiedLineDiff(before.source, after.source, { from: before.ref, to: after.ref }) || `${before.ref} 和 ${after.ref} 一模一样。`
  }

  /** 两个时间点之间的工作区按文件比：哪些新增、删除、改了，前后哈希。 */
  private async diffFiles(left: TimelineRef, right: TimelineRef, signal: Optional<AbortSignal>): Promise<string> {
    const timeline = this.timeline
    if (!timeline.marking) return '这个空间没有给工作区打标记（系统空间只记操作），比不了文件。'
    const before = await this.markerOf(left, signal)
    const after = await this.markerOf(right, signal)
    if ('failed' in before) return before.failed
    if ('failed' in after) return after.failed
    const changes = await timeline.diffMarkers(before.marker, after.marker)
    if (isEmpty(changes)) return `${before.label}和${after.label}的工作区一模一样。`
    return fitReply([`${before.label} → ${after.label}：改了 ${changes.length} 个文件`, ...listChanges(changes)].join('\n'))
  }

  /** 一个引用下的代码：脚本的一版，或者一步当时的代码。 */
  private async codeOf(ref: TimelineRef): Promise<{ source: string; ref: string } | { failed: string }> {
    const timeline = this.timeline
    if (ref.kind === 'script') {
      const record = timeline.version(ref.path, ref.version)
      const source = record ? await timeline.get(record.code) : undefined
      if (isUndefined(record) || isUndefined(source)) return { failed: `脚本库里没有 ${isUndefined(ref.version) ? ref.path : versionRef(ref.path, ref.version)}。` }
      return { source, ref: versionRef(ref.path, record.version) }
    }
    if (ref.kind === 'step') {
      const step = timeline.step(ref.call, ref.step)
      const source = step?.code ? await timeline.get(step.code) : undefined
      if (isUndefined(source)) return { failed: `${stepRef(ref.call, ref.step)} 没有代码可比。` }
      return { source, ref: stepRef(ref.call, ref.step) }
    }
    return { failed: '比代码要给两份代码：lib/x.js@2、lib/x.js，或者步骤号 C12.2；比两个时间点之间的文件用 of: "files"。' }
  }

  /** 一个时间点的工作区标记：调用号是那次调用做完时，步骤号是那一步做完时，now 是现在扫一遍。 */
  private async markerOf(ref: TimelineRef, signal: Optional<AbortSignal>): Promise<{ marker: string; label: string } | { failed: string }> {
    const timeline = this.timeline
    if (ref.kind === 'now') {
      const scan = await timeline.scan(signal)
      return scan ? { marker: scan.marker, label: '现在' } : { failed: '这次没能给工作区打上标记（文件太多），比不了。' }
    }
    if (ref.kind === 'script') return { failed: `${ref.path} 是脚本，不是时间点：时间点写调用号（C12）、步骤号（C12.2）或 now。` }
    const call = timeline.call(ref.call)
    const label = ref.kind === 'call' ? `${callRef(ref.call)} 之后` : `${stepRef(ref.call, ref.step)} 之后`
    if (isUndefined(call) || (ref.kind === 'step' && isUndefined(timeline.step(ref.call, ref.step)))) return { failed: `时间线上没有 ${label.replace(' 之后', '')}。` }
    const marker = markerAt(timeline.calls(), ref.call, ref.kind === 'step' ? ref.step : undefined)
    return isUndefined(marker) ? { failed: `${label}的标记已经不在了（太旧，被时间线的保留上限清掉了），比不了。` } : { marker, label }
  }

  /** 一步的参数原文（JSON）；没有参数、或者清掉了时交回 undefined。 */
  private async inputText(step: TimelineStepRecord): Promise<Optional<string>> {
    return isUndefined(step.input) ? undefined : this.timeline.get(step.input)
  }
}

