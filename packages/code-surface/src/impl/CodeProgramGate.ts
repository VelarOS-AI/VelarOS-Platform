/**
 * 代码面的门：`CodeProgramGate`，接口 `CodeProgramGateApi` 在本文件的类上方，由 `createCodeProgramGate` 创建。
 *
 * 模型交来一段程序，门把它办完：定下跑哪份源码 → 按「常驻 + 本会话导入过的」声明检查并执行 → 编成模型读的回执。
 * 一个会话一份状态：导入过的模块、上一份程序。常驻、索引、导入三档与租约的道理见 docs/engineering/code-surface-design.md。
 */

import { isEmpty, isUndefined } from '@velaros-ai/core'

import type { CodeRunnerApi } from '../contract/requires.js'
import type { MountedCapabilityModule } from '../types/code-surface.js'
import type { CodeGateReply, CodeGateRunInput, CodeGateSessionState } from '../types/gate.js'
import { renderDiagnostics } from '../utils/diagnostics.js'
import { describeGate, describeNeededModules, grantedModules, renderProgramResult } from '../utils/gate.js'
import { resolveProgramSource } from '../utils/result.js'
import { CodeSurfaceTuning } from '../utils/tuning.js'

import type { CodeProgramCheckerApi } from './CodeProgramChecker.js'
import { createCodeSurfaceSession } from './CodeSurfaceSession.js'

/**
 * 模型写程序的那扇门，宿主每个进程装一个，按会话记状态。
 * 门不认识任何一件具体能力：空间挂了哪些、端口怎么办调用，都在每次调用的入参里。
 */
export interface CodeProgramGateApi {
  /** 给模型看的门的说明：怎么写程序、常驻模块的完整声明、其余模块的方法名。空间一定，这段文字就一定。 */
  describe(modules: readonly MountedCapabilityModule[]): string
  /**
   * 办一次程序：import 了头一次见的模块就不执行、交回它们的完整声明（之后这个会话一直可用）；
   * 退租过的模块再用到时静默装回去；检查不过交回带代码帧的诊断；跑完交回结果与图。
   */
  run(input: CodeGateRunInput): Promise<CodeGateReply>
  /** 会话结束：丢掉它导入过的模块与上一份程序。 */
  forget(sessionId: string): void
}

class CodeProgramGate implements CodeProgramGateApi {
  private readonly sessions = new Map<string, CodeGateSessionState>()

  public constructor(
    private readonly checker: CodeProgramCheckerApi,
    private readonly runner: CodeRunnerApi,
  ) {}

  public describe(modules: readonly MountedCapabilityModule[]): string {
    return describeGate(modules)
  }

  public async run(input: CodeGateRunInput): Promise<CodeGateReply> {
    const state = this.stateOf(input.sessionId)
    const session = createCodeSurfaceSession({ checker: this.checker, runner: this.runner, capabilities: input.capabilities, events: input.events })
    const resolved = resolveProgramSource(input.program, state.previousSource)
    if ('failed' in resolved) {
      const outcome = { checked: true as const, result: { failed: resolved.failed } }
      return { text: renderProgramResult(outcome.result), images: [], outcome }
    }
    const source = resolved.source
    // 后面的 edits 都在这一份上改，不管它这次检查过没过。
    state.previousSource = source
    // 模版不常驻：跟着程序送进隔离进程，程序用 template() 读到才进上下文。
    const templates = Object.fromEntries(input.modules.map(({ surface }) => [surface.specifier, surface.template]))
    const submit = () => session.submit({ program: { source, blobs: input.program.blobs }, granted: grantedModules(input.modules, state.imported), templates, timeoutMs: input.timeoutMs, signal: input.signal })
    let outcome = await submit()
    if (!outcome.checked && 'needsModules' in outcome) {
      const byName = new Map(input.modules.map((module) => [module.surface.namespace, module]))
      // 模型见过声明、后来退租的：静默装回去再来一次，回收对它不可见。
      const returning = outcome.needsModules.filter((name) => state.retired.has(name) && byName.has(name))
      const fresh = outcome.needsModules.filter((name) => !returning.includes(name))
      for (const name of outcome.needsModules) {
        if (!byName.has(name)) continue
        state.imported.add(name)
        state.retired.delete(name)
      }
      if (isEmpty(fresh)) outcome = await submit()
      else {
        const needed = fresh.flatMap((name) => byName.get(name) ?? [])
        const unknown = fresh.filter((name) => !byName.has(name))
        return { text: describeNeededModules(needed, unknown, input.modules), images: [], outcome }
      }
    }
    if (!outcome.checked) {
      if ('needsModules' in outcome) return { text: describeNeededModules([], outcome.needsModules, input.modules), images: [], outcome }
      const omitted = outcome.check.omitted ? `\n还有 ${outcome.check.omitted} 条没列出，多半是上面这几处连带出来的——先改这些再交。` : ''
      return { text: `${renderDiagnostics(source, outcome.check.diagnostics)}${omitted}`, images: [], outcome }
    }
    // 租约：once 查一下就完、done 用完了——这一次之后退租；常驻的不受影响。
    for (const imported of outcome.imports ?? []) {
      if (imported.lease !== 'once' && imported.lease !== 'done') continue
      if (state.imported.delete(imported.namespace)) state.retired.add(imported.namespace)
    }
    return { text: renderProgramResult(outcome.result), images: outcome.attachments ?? [], outcome }
  }

  public forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** 这个会话的状态；超过记账上限时丢掉最久没用的那个会话（它下一次来就当新会话）。 */
  private stateOf(sessionId: string): CodeGateSessionState {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      this.sessions.delete(sessionId)
      this.sessions.set(sessionId, existing)
      return existing
    }
    const created: CodeGateSessionState = { imported: new Set(), retired: new Set() }
    this.sessions.set(sessionId, created)
    while (this.sessions.size > CodeSurfaceTuning.gateSessions) {
      const oldest = this.sessions.keys().next().value
      if (isUndefined(oldest)) break
      this.sessions.delete(oldest)
    }
    return created
  }
}

/** 装一扇门：检查器与隔离运行器由宿主选（正式版不许用开发期的子进程运行器）。 */
export function createCodeProgramGate(input: { checker: CodeProgramCheckerApi; runner: CodeRunnerApi }): CodeProgramGateApi {
  return new CodeProgramGate(input.checker, input.runner)
}
