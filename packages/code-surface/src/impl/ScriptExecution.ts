/**
 * 办一次 `script:exec`：`ScriptExecution`，接口 `ScriptExecutionApi` 在本文件的类上方；门每次 exec 建一个。
 *
 * 开头给工作区打个标记，和上一次记下的比一比，外面改过的记成外部改动；然后按顺序做每一步：
 * write、edit、restore 只改脚本库（先过检查，不跑）；run 跑一段代码；replay 按记录把之前的一步再跑一遍，前后都核对文件哈希。
 * 每一步做完先落日志（代码、参数、结果、调过的能力、改了哪些文件），再做下一步；某一步没成就停，后面的不做。
 */

import { isEmpty, isNull, isString, isUndefined } from '@velaros-ai/core'

import type { CodeSurfaceErrorCode } from '../contract/constants.js'
import { CodeSurfaceErrorCodes, CodeSurfaceLimits } from '../contract/constants.js'
import type { CodeRunnerApi } from '../contract/requires.js'
import type { CodeAttachment, CodeProgramFailure, CodeSurfaceOutcome, ScriptFileChange } from '../types/code-surface.js'
import type { CodeGateExecInput, CodeGateReply, CodeGateSessionState, ScriptStepInput, ScriptStepReport } from '../types/gate.js'
import type { ResolvedCode, ScriptRunPlan, ScriptStepResult, TimelineStepRecord, WorkspaceScan } from '../types/timeline.js'
import { renderDiagnostics } from '../utils/diagnostics.js'
import { applyProgramEdits } from '../utils/edit.js'
import { describeNeededModules, grantedModules, renderProgramResult } from '../utils/gate.js'
import { readModuleSpecifiers } from '../utils/module-form.js'
import { readCapabilityNamespace } from '../utils/program.js'
import { callRef, checkScriptPath, isRelativeSpecifier, parseCallBound, parseTimelineRef, resolveLibraryImport, stepRef, versionRef } from '../utils/refs.js'
import { describeReplayMismatch, replayPostMismatches, replayPreMismatches } from '../utils/replay.js'
import { rangeEndState, replayTargets, stepRefOf } from '../utils/timeline.js'
import { describeChanges, describeExternal, describeStepSubject, fitReply } from '../utils/timeline-text.js'

import type { CodeProgramCheckerApi } from './CodeProgramChecker.js'
import { createCodeSurfaceSession } from './CodeSurfaceSession.js'
import type { ScriptTimelineApi } from './ScriptTimeline.js'

/** 一次 exec：从头到尾办完。 */
export interface ScriptExecutionApi {
  /** 开一次调用、按顺序做每一步、某一步没成就停，交回回执与每一步的结果。 */
  run(): Promise<CodeGateReply>
}

export class ScriptExecution implements ScriptExecutionApi {
  /** 这次调用的号。 */
  private call = 0
  /** 最近一次扫描：下一步的「改前」。 */
  private scan: Optional<WorkspaceScan>

  /** 这一次 exec 的时间线、检查器、运行器、这个会话的状态与入参。 */
  public constructor(
    private readonly timeline: ScriptTimelineApi,
    private readonly checker: CodeProgramCheckerApi,
    private readonly runner: CodeRunnerApi,
    private readonly state: CodeGateSessionState,
    private readonly input: CodeGateExecInput,
  ) {}

  public async run(): Promise<CodeGateReply> {
    const sections: string[] = []
    const images: CodeAttachment[] = []
    const reports: ScriptStepReport[] = []
    this.scan = await this.timeline.scan(this.input.signal)
    const last = this.timeline.lastMarker()
    const external = this.scan && last && last !== this.scan.marker ? await this.timeline.diffMarkers(last, this.scan.marker) : []
    // 现在和之前哪个时间点一模一样（整份撤回去的时候最有用）：取最近的那个。
    const same = this.scan && !isEmpty(external) ? this.timeline.pointsAt(this.scan.marker).at(-1) : undefined
    this.call = await this.timeline.begin({ session: this.input.sessionId, marker: this.scan?.marker, external })
    if (!isEmpty(external)) sections.push(describeExternal(external, same))

    let number = 0
    for (const [index, step] of this.input.steps.entries()) {
      const singles = this.expand(step)
      let failedAt = -1
      for (const [position, single] of singles.entries()) {
        number += 1
        const started = Date.now()
        const done = await this.perform(single.step, number, started, single.rangeEnd)
        done.record.ms = Date.now() - started
        await this.timeline.record(done.record)
        reports.push(done.report)
        images.push(...done.images)
        sections.push(`── ${done.report.ref} ${describeStepSubject(done.record)} ──`, done.text)
        if (done.report.ok) continue
        failedAt = position
        break
      }
      if (failedAt < 0) continue
      const rest = singles.length - failedAt - 1
      if (rest > 0) sections.push(`这一段后面的 ${rest} 步没有接着重放。`)
      const left = this.input.steps.length - index - 1
      if (left > 0) sections.push(`这一步没成，后面 ${left} 步没做。`)
      break
    }
    await this.timeline.prune()
    return { text: fitReply(sections.join('\n')), images, call: callRef(this.call), steps: reports }
  }

  /**
   * 一步展开成要做的几步：replay 给了一段调用号（from、to）时，展开成那一段里跑成了、改过文件的每一步，按先后各自重放，
   * 已经在了的跳过（见 perform）；别的原样一步。这一段写错了或者是空的，原样交给 replay 去说清楚。
   */
  private expand(step: ScriptStepInput): Array<{ step: ScriptStepInput; rangeEnd?: ReadonlyMap<string, Optional<string>> }> {
    const single = [{ step }]
    if (step.op !== 'replay' || !isUndefined(step.step) || isUndefined(step.from)) return single
    const targets = replayTargets(this.timeline.calls(), parseCallBound(step.from), parseCallBound(step.to), this.call)
    const rangeEnd = rangeEndState(targets)
    return isEmpty(targets) ? single : targets.map((target) => ({ step: { op: 'replay', step: stepRefOf(target) }, rangeEnd }))
  }

  /**
   * 按 op 做一步。rangeEnd 是一段一段地重放时这一段做完每个文件该是什么样：某一步改过的文件已经是它改后的样子、
   * 或者已经是这一段的终态（后面的步骤接着改过），这一步算已经在了，跳过、不算没成。
   */
  private perform(step: ScriptStepInput, index: number, at: number, rangeEnd: Optional<ReadonlyMap<string, Optional<string>>>): Promise<ScriptStepResult> {
    const record: TimelineStepRecord = { t: 'step', call: this.call, step: index, op: step.op, at, ms: 0, ok: false }
    if (step.op === 'write') return this.write(step, record)
    if (step.op === 'edit') return this.edit(step, record)
    if (step.op === 'restore') return this.restore(step, record)
    if (step.op === 'replay') return this.replay(step, record, rangeEnd)
    return this.runCode(step, record)
  }

  /** write：把 program 存成 path 的新版本。 */
  private async write(step: ScriptStepInput, record: TimelineStepRecord): Promise<ScriptStepResult> {
    if (isUndefined(step.path) || isUndefined(step.program)) return this.fail(record, CodeSurfaceErrorCodes.invalidStep, 'write 要给 path（存到脚本库的哪个路径）和 program（正文）。')
    const invalid = checkScriptPath(step.path)
    if (invalid) return this.fail(record, CodeSurfaceErrorCodes.invalidStep, invalid)
    return this.save(record, step.path, step.program)
  }

  /** edit：在 from（缺省是 path 的最新版）上改几处，存成 path 的新版本。 */
  private async edit(step: ScriptStepInput, record: TimelineStepRecord): Promise<ScriptStepResult> {
    if (isUndefined(step.path) || isUndefined(step.edits) || isEmpty(step.edits)) return this.fail(record, CodeSurfaceErrorCodes.invalidStep, 'edit 要给 path（存成哪个脚本的新版本）和 edits（改哪几处）；from 不给就在 path 的最新版上改。')
    const invalid = checkScriptPath(step.path)
    if (invalid) return this.fail(record, CodeSurfaceErrorCodes.invalidStep, invalid)
    const base = await this.resolveCode(step.from ?? step.path)
    if ('failed' in base) return this.fail(record, base.failed.code, base.failed.message)
    record.base = base.ref
    const edited = applyProgramEdits(base.source, step.edits)
    if ('failed' in edited) return this.fail(record, CodeSurfaceErrorCodes.editFailed, edited.failed)
    this.grantQuietly([base.source])
    return this.save(record, step.path, edited.source)
  }

  /** restore：把 path 的旧版本 version 存成最新版（追加一个同样内容的新版本）。 */
  private async restore(step: ScriptStepInput, record: TimelineStepRecord): Promise<ScriptStepResult> {
    if (isUndefined(step.path) || isUndefined(step.version)) return this.fail(record, CodeSurfaceErrorCodes.invalidStep, 'restore 要给 path 和 version（退回到第几版）。')
    const base = await this.resolveCode(versionRef(step.path, step.version))
    if ('failed' in base) return this.fail(record, base.failed.code, base.failed.message)
    record.base = base.ref
    this.grantQuietly([base.source])
    return this.save(record, step.path, base.source)
  }

  /** 存进脚本库：先过检查（要是 JavaScript），和最新版一样就不存新版本。检查没过的代码也记下，下一步能在它上面改。 */
  private async save(record: TimelineStepRecord, path: string, source: string): Promise<ScriptStepResult> {
    record.path = path
    if (source.length > CodeSurfaceLimits.sourceChars) return this.fail(record, CodeSurfaceErrorCodes.tooLarge, `脚本正文 ${source.length} 字符，超过上限 ${CodeSurfaceLimits.sourceChars}。拆成几个脚本，互相 import。`)
    record.code = await this.timeline.put(source)
    const library = await this.library(source, path)
    this.grantQuietly(Object.values(library.modules))
    const target = { source, path, modules: library.modules }
    const needed = this.admitNeeded(this.checker.missingModules({ ...target, granted: this.granted() }))
    if (!isUndefined(needed)) return this.fail(record, CodeSurfaceErrorCodes.modulesNeeded, `${needed}\n\n照着改好再存：edit 的 path 照旧、from 填 ${this.ref(record)}，edits 写要改的几处。`)
    const checked = this.checker.check({ ...target, granted: this.granted() })
    if (!checked.ok) {
      const omitted = checked.omitted ? `\n还有 ${checked.omitted} 条没列出，多半是上面这几处连带出来的。` : ''
      return this.fail(record, CodeSurfaceErrorCodes.checkFailed, `${renderDiagnostics(source, checked.diagnostics, library.modules)}${omitted}\n没存进脚本库。改的时候不用整份重发：edit 的 path 照旧、from 填 ${this.ref(record)}，edits 写要改的几处（oldText 照上面框出来的原文一字不差、在代码里唯一，newText 写新的）。`)
    }
    if (checked.wroteTypeScript) return this.fail(record, CodeSurfaceErrorCodes.checkFailed, '存进脚本库的要是 JavaScript：这份里有 TypeScript 语法（类型标注、as、interface 这类），去掉再存。没存进脚本库。')
    const latest = this.timeline.version(path)
    record.ok = true
    if (latest?.code === record.code) return this.finish(record, `和 ${versionRef(path, latest.version)} 一模一样，没存新版本。`, { saved: versionRef(path, latest.version) })
    record.version = (latest?.version ?? 0) + 1
    return this.finish(record, `存成 ${versionRef(path, record.version)}（检查通过）。`, { saved: versionRef(path, record.version) })
  }

  /** run：跑一段代码——program 直接给，或者 from 已有的代码（可以带 edits）；参数不给就沿用那一步当时的。 */
  private async runCode(step: ScriptStepInput, record: TimelineStepRecord): Promise<ScriptStepResult> {
    if (isUndefined(step.program) === isUndefined(step.from)) return this.fail(record, CodeSurfaceErrorCodes.invalidStep, 'run 的 program 和 from 给一个：program 是这次直接跑的正文，from 是已有的代码（lib/x.js、lib/x.js@3、C12.2）。')
    if (!isUndefined(step.edits) && isUndefined(step.from)) return this.fail(record, CodeSurfaceErrorCodes.invalidStep, 'edits 要和 from 一起给：在 from 那份代码上改。')
    let source = step.program ?? ''
    let path: Optional<string>
    let reused: Optional<TimelineStepRecord>
    if (!isUndefined(step.from)) {
      const base = await this.resolveCode(step.from)
      if ('failed' in base) return this.fail(record, base.failed.code, base.failed.message)
      record.base = base.ref
      path = base.path
      reused = base.step
      // 这份代码不是这一轮写的：它 import 的能力模块直接给上，不再让模型先读一遍声明。
      this.grantQuietly([base.source])
      source = base.source
      if (step.edits && !isEmpty(step.edits)) {
        const edited = applyProgramEdits(base.source, step.edits)
        if ('failed' in edited) return this.fail(record, CodeSurfaceErrorCodes.editFailed, edited.failed)
        source = edited.source
      }
    }
    const params = await this.params(step, reused)
    if ('failed' in params) return this.fail(record, params.failed.code, params.failed.message)
    const library = await this.library(source, path)
    this.grantQuietly(Object.values(library.modules))
    const plan: ScriptRunPlan = { source, modules: library.modules, deps: library.deps }
    if (!isUndefined(path)) plan.path = path
    if (!isUndefined(params.input)) plan.input = params.input
    if (!isUndefined(params.blobs)) plan.blobs = params.blobs
    return this.execute(record, plan)
  }

  /**
   * replay：按记录重跑之前的一步——同一份代码、同一组参数、当时的库版本；跑前跑后都核对文件哈希，对不上就算没成。
   * 走到这里还没有 step 的，是一段调用号写错了或者这一段里没有能重放的，说清楚是哪一种。
   */
  private async replay(step: ScriptStepInput, record: TimelineStepRecord, rangeEnd: Optional<ReadonlyMap<string, Optional<string>>>): Promise<ScriptStepResult> {
    if (isUndefined(step.step)) {
      const from = parseCallBound(step.from)
      const to = parseCallBound(step.to)
      if (isUndefined(from)) return this.fail(record, CodeSurfaceErrorCodes.invalidStep, 'replay 要给 step（一步，比如 C12.2），或者 from、to（一段调用号，比如 C10 到 C14）。')
      if (isNull(from) || isNull(to)) return this.fail(record, CodeSurfaceErrorCodes.invalidStep, 'replay 一段时 from、to 要写成调用号，比如 C10、C14（to 不给是到最近一次）。')
      return this.fail(record, CodeSurfaceErrorCodes.invalidStep, `${callRef(from)} 到 ${isUndefined(to) ? '最近一次' : callRef(to)} 之间没有跑成、改过文件的步骤，没什么可重放。`)
    }
    const parsed = parseTimelineRef(step.step)
    if (isString(parsed) || parsed.kind !== 'step') return this.fail(record, CodeSurfaceErrorCodes.invalidStep, `replay 的 step 要写成步骤号（C12.2），${step.step} 不是。`)
    const original = this.timeline.step(parsed.call, parsed.step)
    const ref = stepRef(parsed.call, parsed.step)
    record.replayOf = ref
    if (isUndefined(original)) return this.fail(record, CodeSurfaceErrorCodes.refNotFound, `时间线上没有 ${ref}。用 script:history 看有哪些步骤。`)
    if (original.op !== 'run' && original.op !== 'replay') return this.fail(record, CodeSurfaceErrorCodes.invalidStep, `${ref} 是 ${original.op}，只有 run 和 replay 能重放；脚本库的版本用 restore 退回。`)
    if (!original.ok) return this.fail(record, CodeSurfaceErrorCodes.invalidStep, `${ref} 当时没跑成，重放它没有意义；要在它上面改了再跑，用 run 的 from 填 ${ref}。`)
    if (original.dropped?.includes('input')) return this.fail(record, CodeSurfaceErrorCodes.invalidStep, `${ref} 的参数已经被时间线的保留上限清掉了，重放不了；要跑它的代码，用 run 的 from 填 ${ref} 并给上参数。`)
    const source = isUndefined(original.code) ? undefined : await this.timeline.get(original.code)
    if (isUndefined(source)) return this.fail(record, CodeSurfaceErrorCodes.refNotFound, `${ref} 的代码找不到了，重放不了。`)
    const params = await this.params({ op: 'replay' }, original)
    if ('failed' in params) return this.fail(record, params.failed.code, params.failed.message)
    const library = await this.library(source, original.path, original.deps ?? {})
    const missing = Object.entries(original.deps ?? {}).filter(([path, version]) => library.deps[path] !== version)
    if (!isEmpty(missing)) return this.fail(record, CodeSurfaceErrorCodes.refNotFound, `${ref} 当时用到的 ${missing.map(([path, version]) => versionRef(path, version)).join('、')} 找不到了，重放不了。`)
    this.grantQuietly([source, ...Object.values(library.modules)])

    // 跑之前：它当时改过的文件，现在得还是当时改前的样子，否则是在别的底子上重放。
    const marked = this.timeline.marking && (!isUndefined(original.marker) || !isUndefined(original.changes))
    const expected = original.changes ?? []
    if (marked && !isEmpty(expected)) {
      if (isUndefined(this.scan)) return this.fail(record, CodeSurfaceErrorCodes.replayMismatch, '这次没能给工作区打上标记（文件太多），核对不了改前的样子，没有重放。')
      const before = replayPreMismatches(expected, this.scan.files)
      if (!isEmpty(before)) {
        const current = (path: string): Optional<string> => this.scan?.files.get(path)
        const applied = expected.every((change) => current(change.path) === change.after)
        const inEffect = rangeEnd && expected.every((change) => current(change.path) === change.after || (rangeEnd.has(change.path) && current(change.path) === rangeEnd.get(change.path)))
        if (inEffect) {
          record.ok = true
          return this.finish(record, applied ? `${ref} 的改动现在已经在了，跳过。` : `${ref} 改过的文件已经是这一段做完的样子（后面的步骤接着改过），跳过。`)
        }
        return this.fail(record, CodeSurfaceErrorCodes.replayMismatch, applied
          ? `${ref} 的改动现在已经在了（它改过的文件都是改后的样子），不用重放。`
          : describeReplayMismatch(`没有重放：${ref} 改过的文件现在已经不是它当时改前的样子，在别的底子上重放会改出别的结果。`, before))
      }
    }
    const plan: ScriptRunPlan = { source, modules: library.modules, deps: library.deps, replayOf: ref }
    if (!isUndefined(original.path)) plan.path = original.path
    if (!isUndefined(original.base)) plan.base = original.base
    if (!isUndefined(params.input)) plan.input = params.input
    if (!isUndefined(params.blobs)) plan.blobs = params.blobs
    const done = await this.execute(record, plan)
    // 跑完之后：改出来的得和当时一模一样。
    if (!marked || !done.report.ok || isUndefined(done.record.marker)) return done
    const after = replayPostMismatches(expected, done.record.changes ?? [])
    if (isEmpty(after)) return done
    const failure: CodeProgramFailure = { code: CodeSurfaceErrorCodes.replayMismatch, message: `${ref} 重放完，改出来的和当时不一样。` }
    done.record.ok = false
    done.record.error = failure
    done.report.ok = false
    done.report.error = failure
    done.text = `${done.text}\n${describeReplayMismatch(`${failure.message}脚本依赖的东西（时间、网络、别的文件）变了时会这样；后面的步骤没有接着重放。`, after)}`
    return done
  }

  /** 交给会话跑一份代码：检查、执行、收图；跑了的话再扫一遍工作区，记下这一步改了哪些文件。 */
  private async execute(record: TimelineStepRecord, plan: ScriptRunPlan): Promise<ScriptStepResult> {
    record.code = await this.timeline.put(plan.source)
    if (!isUndefined(plan.path)) record.path = plan.path
    if (!isUndefined(plan.base)) record.base = plan.base
    if (!isUndefined(plan.replayOf)) record.replayOf = plan.replayOf
    if (!isUndefined(plan.input)) record.input = await this.timeline.put(JSON.stringify(plan.input))
    if (plan.blobs && !isEmpty(Object.keys(plan.blobs))) record.blobs = await this.timeline.put(JSON.stringify(plan.blobs))
    if (!isEmpty(Object.keys(plan.deps))) record.deps = plan.deps
    const { space } = this.input
    const session = createCodeSurfaceSession({ checker: this.checker, runner: this.runner, capabilities: space.capabilities, events: this.input.events })
    // 模版不常驻：跟着程序送进隔离进程，程序用 template() 读到才进上下文。
    const templates = Object.fromEntries(space.modules.map(({ surface }) => [surface.specifier, surface.template]))
    const program = { source: plan.source, path: plan.path, modules: plan.modules, input: plan.input, blobs: plan.blobs }
    const submit = (): Promise<CodeSurfaceOutcome> => session.submit({ program, granted: this.granted(), templates, timeoutMs: this.input.timeoutMs, signal: this.input.signal })
    let outcome = await submit()
    if (!outcome.checked && 'needsModules' in outcome) {
      const needed = this.admitNeeded(outcome.needsModules)
      if (!isUndefined(needed)) return this.fail(record, CodeSurfaceErrorCodes.modulesNeeded, `${needed}\n\n照着改好再跑：run 的 from 填 ${this.ref(record)}，edits 写要改的几处。`)
      outcome = await submit()
    }
    if (!outcome.checked) {
      if ('needsModules' in outcome) return this.fail(record, CodeSurfaceErrorCodes.modulesNeeded, describeNeededModules([], outcome.needsModules, space.modules))
      const omitted = outcome.check.omitted ? `\n还有 ${outcome.check.omitted} 条没列出，多半是上面这几处连带出来的——先改这些。` : ''
      return this.fail(record, CodeSurfaceErrorCodes.checkFailed, `${renderDiagnostics(plan.source, outcome.check.diagnostics, plan.modules)}${omitted}\n改的时候不用整份重发：run 的 from 填 ${this.ref(record)}，edits 写要改的几处（oldText 照上面框出来的原文一字不差、在代码里唯一，newText 写新的）。`)
    }
    // 租约：once 查一下就完、done 用完了——这一次之后退租；常驻的不受影响。
    for (const imported of outcome.imports ?? []) {
      if (imported.lease !== 'once' && imported.lease !== 'done') continue
      if (this.state.imported.delete(imported.namespace)) this.state.retired.add(imported.namespace)
    }
    record.ok = isUndefined(outcome.result.failed)
    if (outcome.result.failed) record.error = outcome.result.failed
    if (outcome.calls && !isEmpty(outcome.calls)) record.calls = [...outcome.calls]
    const lines = [renderProgramResult(outcome.result)]
    const changes = await this.markAfterRun(record)
    if (changes && !isEmpty(changes)) lines.push(describeChanges(changes))
    const text = lines.join('\n')
    record.result = await this.timeline.put(text)
    return { record, report: this.report(record, { outcome, changes }), text, images: outcome.attachments ?? [] }
  }

  /** 跑完一段代码之后扫一遍工作区：记下标记与这一步改了哪些文件。被中止了也扫——副作用是真的，得记下来。 */
  private async markAfterRun(record: TimelineStepRecord): Promise<Optional<ScriptFileChange[]>> {
    const after = await this.timeline.scan()
    if (isUndefined(after)) {
      this.scan = undefined
      return undefined
    }
    const before = this.scan
    this.scan = after
    record.marker = after.marker
    if (isUndefined(before)) return undefined
    const changes = await this.timeline.diffMarkers(before.marker, after.marker)
    if (!isEmpty(changes)) record.changes = changes
    return changes
  }

  /**
   * 解析一份已有的代码：脚本库里的 `lib/x.js`（最新版）、`lib/x.js@3`，或者之前的一步 `C12.2`（它当时的代码）。
   * 解析不出来时说清楚为什么、有哪些。
   */
  private async resolveCode(text: string): Promise<ResolvedCode | { failed: { code: CodeSurfaceErrorCode; message: string } }> {
    const failed = (code: CodeSurfaceErrorCode, message: string) => ({ failed: { code, message } })
    const parsed = parseTimelineRef(text)
    if (isString(parsed)) return failed(CodeSurfaceErrorCodes.invalidStep, parsed)
    if (parsed.kind === 'script') {
      const version = this.timeline.version(parsed.path, parsed.version)
      if (isUndefined(version)) {
        const versions = this.timeline.library().get(parsed.path) ?? []
        return failed(CodeSurfaceErrorCodes.refNotFound, isEmpty(versions)
          ? `脚本库里没有 ${parsed.path}。用 script:show（不给 ref）看库里有哪些。`
          : `${parsed.path} 没有第 ${parsed.version ?? 0} 版；有的是 ${versions.map((entry) => `@${entry.version}`).join('、')}。`)
      }
      const source = await this.timeline.get(version.code)
      if (isUndefined(source)) return failed(CodeSurfaceErrorCodes.refNotFound, `${versionRef(parsed.path, version.version)} 的正文找不到了。`)
      return { source, code: version.code, path: parsed.path, ref: versionRef(parsed.path, version.version) }
    }
    if (parsed.kind === 'step') {
      const ref = stepRef(parsed.call, parsed.step)
      const step = this.timeline.step(parsed.call, parsed.step)
      if (isUndefined(step)) return failed(CodeSurfaceErrorCodes.refNotFound, `时间线上没有 ${ref}。用 script:history 看有哪些步骤。`)
      const source = isUndefined(step.code) ? undefined : await this.timeline.get(step.code)
      if (isUndefined(step.code) || isUndefined(source)) return failed(CodeSurfaceErrorCodes.refNotFound, `${ref} 没有代码（${step.op} 没走到那一步），换一步或者直接给 program。`)
      const resolved: ResolvedCode = { source, code: step.code, ref, step }
      if (!isUndefined(step.path)) resolved.path = step.path
      return resolved
    }
    return failed(CodeSurfaceErrorCodes.invalidStep, `${text} 是时间点，这里要的是代码：lib/x.js、lib/x.js@3，或者之前的一步 C12.2。`)
  }

  /** 这一步的参数：给了就用给的；没给、又是从之前某一步来的，就沿用那一步当时的（各自按字段沿用）。 */
  private async params(step: ScriptStepInput, reused: Optional<TimelineStepRecord>): Promise<{ input?: unknown; blobs?: Record<string, string> } | { failed: { code: CodeSurfaceErrorCode; message: string } }> {
    const params: { input?: unknown; blobs?: Record<string, string> } = {}
    if (!isUndefined(step.input)) params.input = step.input
    if (!isUndefined(step.blobs)) params.blobs = step.blobs
    if (isUndefined(reused) || (!isUndefined(step.input) && !isUndefined(step.blobs))) return params
    const ref = stepRef(reused.call, reused.step)
    // 当时的参数清掉了：给了哪样就用哪样；一样都没给才拒绝。
    if (reused.dropped?.includes('input')) {
      if (isUndefined(step.input) && isUndefined(step.blobs)) return { failed: { code: CodeSurfaceErrorCodes.invalidStep, message: `${ref} 当时的参数已经被时间线的保留上限清掉了：这次把 input（和要用的 blobs）给上再跑。` } }
      return params
    }
    if (isUndefined(step.input) && !isUndefined(reused.input)) {
      const text = await this.timeline.get(reused.input)
      if (isUndefined(text)) return { failed: { code: CodeSurfaceErrorCodes.refNotFound, message: `${ref} 当时的 input 找不到了：这次给上 input 再跑。` } }
      params.input = JSON.parse(text) as unknown
    }
    if (isUndefined(step.blobs) && !isUndefined(reused.blobs)) {
      const text = await this.timeline.get(reused.blobs)
      if (isUndefined(text)) return { failed: { code: CodeSurfaceErrorCodes.refNotFound, message: `${ref} 当时的 blobs 找不到了：这次给上 blobs 再跑。` } }
      params.blobs = JSON.parse(text) as Record<string, string>
    }
    return params
  }

  /**
   * 这份代码 import 到的库里的脚本，顺着 import 一层层找全：路径 → 正文，和各是哪一版。
   * pinned 给了就用那几版（重放按当时的版本），没给用最新版。库里没有的不放进来——检查器会报「找不到这个模块」。
   */
  private async library(source: string, path: Optional<string>, pinned: Readonly<Record<string, number>> = {}): Promise<{ modules: Record<string, string>; deps: Record<string, number> }> {
    const modules: Record<string, string> = {}
    const deps: Record<string, number> = {}
    const pending: Array<{ source: string; path: Optional<string> }> = [{ source, path }]
    for (let next = pending.shift(); next; next = pending.shift()) {
      for (const specifier of readModuleSpecifiers(next.source)) {
        if (!isRelativeSpecifier(specifier)) continue
        const target = resolveLibraryImport(next.path, specifier)
        if (isNull(target) || target in modules) continue
        const version = this.timeline.version(target, pinned[target])
        const text = isUndefined(version) ? undefined : await this.timeline.get(version.code)
        if (isUndefined(version) || isUndefined(text)) continue
        modules[target] = text
        deps[target] = version.version
        pending.push({ source: text, path: target })
      }
    }
    return { modules, deps }
  }

  /** 这一轮授给检查器的声明：常驻的，加上这个会话导入过的。 */
  private granted(): ReturnType<typeof grantedModules> {
    return grantedModules(this.input.space.modules, this.state.imported)
  }

  /** 不是这一轮写的代码（库里的脚本、之前某一步的代码）import 的能力模块，直接给上，不让模型为别人写的代码先读一遍声明。 */
  private grantQuietly(sources: readonly string[]): void {
    const known = new Set(this.input.space.modules.map(({ surface }) => surface.namespace))
    for (const source of sources) {
      for (const specifier of readModuleSpecifiers(source)) {
        const namespace = readCapabilityNamespace(specifier)
        if (isNull(namespace) || !known.has(namespace)) continue
        this.state.imported.add(namespace)
        this.state.retired.delete(namespace)
      }
    }
  }

  /**
   * 检查时发现 import 了还没给过声明的模块：都记成导入过；其中退租过又用到的静默装回，不算。
   * 有头一次见的（或者空间里根本没有的），交回给模型看的那段（声明或说明）；没有就交回 undefined，调用方再检查一次。
   */
  private admitNeeded(names: readonly string[]): Optional<string> {
    if (isEmpty(names)) return undefined
    const modules = this.input.space.modules
    const byName = new Map(modules.map((module) => [module.surface.namespace, module]))
    const fresh = names.filter((name) => !this.state.retired.has(name) || !byName.has(name))
    for (const name of names) {
      if (!byName.has(name)) continue
      this.state.imported.add(name)
      this.state.retired.delete(name)
    }
    if (isEmpty(fresh)) return undefined
    return describeNeededModules(fresh.flatMap((name) => byName.get(name) ?? []), fresh.filter((name) => !byName.has(name)), modules)
  }

  /** 这一步的步骤号。 */
  private ref(record: TimelineStepRecord): string {
    return stepRef(this.call, record.step)
  }

  /** 这一步没成：记下码与说明。 */
  private fail(record: TimelineStepRecord, code: CodeSurfaceErrorCode, message: string): Promise<ScriptStepResult> {
    record.ok = false
    record.error = { code, message }
    return this.finish(record, message)
  }

  /** 收尾：结果正文存进时间线，编好给宿主的结果。 */
  private async finish(record: TimelineStepRecord, text: string, extra: { saved?: string } = {}): Promise<ScriptStepResult> {
    record.result = await this.timeline.put(text)
    return { record, report: this.report(record, extra), text, images: [] }
  }

  /** 给宿主的这一步的结果。 */
  private report(record: TimelineStepRecord, extra: { saved?: string; outcome?: CodeSurfaceOutcome; changes?: readonly ScriptFileChange[] }): ScriptStepReport {
    const report: ScriptStepReport = { ref: this.ref(record), op: record.op, ok: record.ok }
    if (!isUndefined(extra.saved)) report.saved = extra.saved
    if (!isUndefined(extra.outcome)) report.outcome = extra.outcome
    if (record.error) report.error = record.error
    if (extra.changes && !isEmpty(extra.changes)) report.changes = extra.changes
    return report
  }
}

