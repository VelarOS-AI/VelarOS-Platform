/**
 * 代码面的门：`CodeProgramGate`，接口 `CodeProgramGateApi` 在本文件的类上方，由 `createCodeProgramGate` 创建。
 *
 * 模型经 `script:exec` 交一串步骤，门把它交给一次执行（`ScriptExecution`）按顺序办完，每一步记进这个空间的时间线；
 * `script:history`、`script:show`、`script:diff` 只读时间线。门按会话记导入过的模块，按空间开时间线（同一个目录一条，进程里共用）。
 * 常驻、索引、导入三档与租约的道理见 docs/engineering/code-surface-design.md。
 */

import { isUndefined, toNullable } from '@velaros-ai/core'

import type { CodeRunnerApi, CodeSurfaceTimelinePort } from '../contract/requires.js'
import type { MountedCapabilityModule } from '../types/code-surface.js'
import type { CodeGateExecInput, CodeGateQuery, CodeGateReply, CodeGateSessionState, ScriptDiffInput, ScriptHistoryInput, ScriptShowInput } from '../types/gate.js'
import { describeGate } from '../utils/gate.js'
import { CodeSurfaceTuning } from '../utils/tuning.js'

import type { CodeProgramCheckerApi } from './CodeProgramChecker.js'
import { ScriptExecution } from './ScriptExecution.js'
import type { ScriptTimelineApi } from './ScriptTimeline.js'
import { ScriptTimeline } from './ScriptTimeline.js'
import type { ScriptTimelineViewsApi } from './ScriptTimelineViews.js'
import { ScriptTimelineViews } from './ScriptTimelineViews.js'

/**
 * 模型写脚本的那扇门，宿主每个进程装一个：按会话记导入过的模块，按空间开时间线。
 * 门不认识任何一件具体能力：空间挂了哪些、端口怎么办调用、时间线放在哪，都在每次调用的入参里。
 */
export interface CodeProgramGateApi {
  /** 给模型看的门的说明：怎么写脚本、怎么用四个工具、常驻模块的完整声明、其余模块的方法名。空间一定，这段文字就一定。 */
  describe(modules: readonly MountedCapabilityModule[]): string
  /**
   * 办一次 `script:exec`：按顺序做每一步，某一步没成就停；每一步连同代码、参数、结果记进时间线。
   * 同一条时间线上的 exec 排队做，每一步前后的工作区标记才对得上。
   */
  exec(input: CodeGateExecInput): Promise<CodeGateReply>
  /** `script:history`：列时间线上的调用与步骤，最新的在后面。 */
  history(input: CodeGateQuery<ScriptHistoryInput>): Promise<string>
  /** `script:show`：看一次调用、一步、一版脚本，或者脚本库目录。 */
  show(input: CodeGateQuery<ScriptShowInput>): Promise<string>
  /** `script:diff`：两版代码逐行比，或者两个时间点之间的工作区按文件比。 */
  diff(input: CodeGateQuery<ScriptDiffInput>): Promise<string>
  /** 会话结束：丢掉它导入过的模块。时间线不受影响，它属于空间。 */
  forget(sessionId: string): void
}

class CodeProgramGate implements CodeProgramGateApi {
  private readonly sessions = new Map<string, CodeGateSessionState>()
  private readonly timelines = new Map<string, ScriptTimelineApi>()

  public constructor(
    private readonly checker: CodeProgramCheckerApi,
    private readonly runner: CodeRunnerApi,
  ) {}

  public describe(modules: readonly MountedCapabilityModule[]): string {
    return describeGate(modules)
  }

  public async exec(input: CodeGateExecInput): Promise<CodeGateReply> {
    const timeline = await this.timelineOf(input.space.timeline)
    const state = this.stateOf(input.sessionId)
    return timeline.exclusive(() => new ScriptExecution(timeline, this.checker, this.runner, state, input).run())
  }

  public async history(input: CodeGateQuery<ScriptHistoryInput>): Promise<string> {
    return (await this.viewsOf(input)).history(input.query)
  }

  public async show(input: CodeGateQuery<ScriptShowInput>): Promise<string> {
    return (await this.viewsOf(input)).show(input.query)
  }

  public async diff(input: CodeGateQuery<ScriptDiffInput>): Promise<string> {
    return (await this.viewsOf(input)).diff(input.query, input.signal)
  }

  public forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** 查询用的视图：这一次查的那条时间线。 */
  private async viewsOf(input: CodeGateQuery<unknown>): Promise<ScriptTimelineViewsApi> {
    return new ScriptTimelineViews(await this.timelineOf(input.timeline), input.sessionId)
  }

  /**
   * 这个空间的时间线：同一个目录进程里只开一条；开着的超过上限时丢掉最久没用的（有 exec 在做的不丢），下次用到再从磁盘读。
   */
  private async timelineOf(port: CodeSurfaceTimelinePort): Promise<ScriptTimelineApi> {
    const key = JSON.stringify([port.directory, toNullable(port.workspace), toNullable(port.retainBytes)])
    let timeline = this.timelines.get(key)
    if (timeline) this.timelines.delete(key)
    else timeline = new ScriptTimeline(port)
    this.timelines.set(key, timeline)
    const idle = [...this.timelines.entries()].filter(([name, open]) => name !== key && !open.busy).map(([name]) => name)
    for (const name of idle.slice(0, Math.max(0, this.timelines.size - CodeSurfaceTuning.gateTimelines))) this.timelines.delete(name)
    await timeline.load()
    return timeline
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
