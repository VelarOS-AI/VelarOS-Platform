/**
 * 会话层：把一次「模型交了段程序」办完。
 *
 * 顺序是硬的——**先 typecheck，不过就不执行**。这一关拦掉的是模型对回执形状的误解，
 * 而那正是今天工具面最常见的一类缺陷；让不合法的程序跑起来，等于用真实副作用去试错。
 */

import { isEmpty, isString, isTrue } from '@velaros-ai/core'

import { CodeSurfaceErrorCodes, CodeSurfaceLimits } from '../contract/constants.js'
import type { CodeCapabilityPort, CodeRunnerApi, CodeSurfaceEventSink } from '../contract/requires.js'
import type {
  CodeCallNotice,
  CodeProgramRequest,
  CodeSurfaceOutcome,
} from '../types/code-surface.js'
import type { GrantedModule } from '../types/code-surface.js'
import { readProgramImports, rewriteModuleForIsolate } from '../utils/module-form.js'
import { composeProgramResult, describeProgramOversize, resolveProgramSource } from '../utils/result.js'
import { CodeSurfaceTuning } from '../utils/tuning.js'

import type { CodeProgramCheckerApi } from './CodeProgramChecker.js'

/** 代码面会话。 */
export interface CodeSurfaceSessionApi {
  /**
   * 办完一次程序：查体量 → typecheck → 隔离里跑 → 把能力调用转给宿主 → 编成给模型看的结果。
   * `declarations` 是这一轮给模型看的能力声明，检查用的就是它——两边同一份，模型写得出来的就检查得过。
   */
  submit(input: {
    program: CodeProgramRequest
    /**
     * 这一轮授给程序的能力模块（常驻的 + 本会话已导入的）。
     * **只给授权的**：没授权的模块 `import` 不出来，这道闸是语言给的。
     */
    granted: readonly GrantedModule[]
    /**
     * 上一份程序的正文，宿主记着并给进来；模型传 `edits` 时在它上面改。
     * 不给而模型又传了 `edits`，会被明确拒绝并让它改发整份——**不猜一份出来**。
     */
    previousSource?: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<CodeSurfaceOutcome>
}

class CodeSurfaceSession implements CodeSurfaceSessionApi {
  public constructor(
    private readonly checker: CodeProgramCheckerApi,
    private readonly runner: CodeRunnerApi,
    private readonly capabilities: CodeCapabilityPort,
    private readonly events: CodeSurfaceEventSink = {}
  ) {}

  public async submit(input: {
    program: CodeProgramRequest
    granted: readonly GrantedModule[]
    previousSource?: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<CodeSurfaceOutcome> {
    const resolved = resolveProgramSource(input.program, input.previousSource)
    if ('failed' in resolved) return { checked: true, result: { failed: resolved.failed } }
    const source = resolved.source

    const oversized = describeProgramOversize(source, input.program.blobs)
    if (isString(oversized)) return {
        checked: true,
        result: { failed: { code: CodeSurfaceErrorCodes.tooLarge, message: oversized } },
      }

    // 非常驻能力必须先导入才能用：import 了没授权的模块时**一行都不执行**，回它们的签名让模型重写。
    // 这不是失败，是「先拿说明书」——代码面里写错一处的代价是整段程序不执行，不是一次调用失败。
    const missing = this.checker.missingModules({ source, granted: input.granted })
    if (!isEmpty(missing)) return { checked: false, needsModules: missing }

    const checked = this.checker.check({ source, granted: input.granted })
    if (!checked.ok) return { checked: false, check: checked }

    const notices: CodeCallNotice[] = []
    if (isTrue(checked.wroteTypeScript)) {
      notices.push({
        call: 'program',
        action: 'normalized',
        detail: '这次的程序里有 TypeScript 语法，已经替你剥掉后执行。下次直接写 JavaScript。',
      })
    }
    let calls = 0
    const outcome = await this.runner.run(
      {
        // 隔离里没有模块系统：import 改写成 __velar(...)、export default 改写成 return，行数一个不变。
        source: rewriteModuleForIsolate(checked.transpiled ?? source),
        blobs: input.program.blobs ?? {},
        operations: this.capabilities.listOperations(),
        timeoutMs: Math.min(input.timeoutMs ?? CodeSurfaceTuning.defaultTimeoutMs, CodeSurfaceLimits.timeoutMs),
      },
      async (call) => {
        calls += 1
        if (calls > CodeSurfaceLimits.calls) return {
            error: {
              code: CodeSurfaceErrorCodes.tooLarge,
              message: `这次程序已经发了 ${CodeSurfaceLimits.calls} 次能力调用，到上限了。把循环收窄，或者分几次程序做。`,
            },
          }
        this.events.callStarted?.({ ...call })
        const startedAt = Date.now()
        const result = await this.capabilities.invoke(
          { namespace: call.namespace, operation: call.operation, input: call.input },
          input.signal
        )
        this.events.callSettled?.({ callId: call.callId, ok: !result.error, elapsedMs: Date.now() - startedAt })
        if (result.notices) notices.push(...result.notices)
        if (result.error) {
          notices.push({
            call: `${call.namespace}.${call.operation}`,
            action: 'denied',
            detail: result.error.message,
          })
        }
        return result
      },
      (line) => this.events.logged?.(line),
      input.signal
    )

    const result = composeProgramResult(outcome, notices)
    const imports = readProgramImports(source)
    return isEmpty(imports) ? { checked: true, result } : { checked: true, result, imports }
  }




}

/** 装一个代码面会话；运行器与能力端口由宿主给。 */
export function createCodeSurfaceSession(input: {
  checker: CodeProgramCheckerApi
  runner: CodeRunnerApi
  capabilities: CodeCapabilityPort
  events?: CodeSurfaceEventSink
}): CodeSurfaceSessionApi {
  return new CodeSurfaceSession(input.checker, input.runner, input.capabilities, input.events)
}
