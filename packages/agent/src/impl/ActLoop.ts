import type { ContextCompletionResult } from '@velaros-ai/context'
import { isNull } from '@velaros-ai/core'
import { Log } from '@velaros-ai/core'
import { isFalse, isUndefined } from '@velaros-ai/core'
import { isEmpty, isObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'
import { modelRequestEncoder, type ModelTurnDelta } from '@velaros-ai/kernel'
import {
  type CompiledModelRequest,
  createProviderRequestCompiler,
  modelProviderRetry,
} from '@velaros-ai/model'

import type { ActLoopOptions } from '../contract/requires.js'
import type { ActComposedFrame, ActDecodedTurn, ActInput, ActRunEvent } from '../types/act.js'
import { framedRequest, requestChars } from '../utils/frame-prompt.js'
import { boundedModelOperation, boundedModelStream } from '../utils/model-stream.js'
import { AgentTuning, ContextPlanTuning } from '../utils/tuning.js'

import { ContextPlanner } from './ContextPlanner.js'

/** 唯一模型回合推进器，由运行服务持有。 */
export interface ActLoopApi {
  /** 推进一次输入，暂停或终止时返回。 */
  submit(input: string | ActInput, signal?: AbortSignal): AsyncIterable<ActRunEvent>
  /** 取消当前运行。 */
  cancel(): void
}

export class ActLoop implements ActLoopApi {
  private controller?: AbortController
  private completionFeedback?: ContextCompletionResult
  private readonly policy
  private readonly compiler = createProviderRequestCompiler()
  private readonly planner
  private cache?: { readonly readTokens: number; readonly writeTokens: number }
  private stallBase?: number

  public constructor(private readonly options: ActLoopOptions) {
    this.policy = {
      foldTurns: ContextPlanTuning.foldTurns,
      boundaryTurns: ContextPlanTuning.boundaryTurns,
      minTurns: ContextPlanTuning.minTurns,
      windowTokens: ContextPlanTuning.windowTokens,
      recoveryAttempts: ContextPlanTuning.recoveryAttempts,
      ...options.frames.policy,
    }
    const { foldTurns, boundaryTurns, minTurns, windowTokens, recoveryAttempts } = this.policy
    if (
      ![foldTurns, boundaryTurns, minTurns, windowTokens, recoveryAttempts].every((value) =>
        Number.isSafeInteger(value)
      ) ||
      !(
        foldTurns >= 1 &&
        foldTurns < minTurns &&
        minTurns <= boundaryTurns &&
        boundaryTurns <= 64
      ) ||
      windowTokens < 1024 ||
      recoveryAttempts < 1 ||
      recoveryAttempts > 4
    )
      throw new AppError('VALIDATION', '上下文容量策略无效')
    this.planner = new ContextPlanner({ foldTurns, minTurns })
    for (const value of Object.values(options.limits))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new AppError('VALIDATION', '运行预算必须是正整数')
    for (const value of Object.values(options.model.limits))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new AppError('VALIDATION', '模型必须声明有效窗口限制')
  }

  public cancel(): void {
    this.controller?.abort()
  }

  public async *submit(input: string | ActInput, signal?: AbortSignal): AsyncIterable<ActRunEvent> {
    if (this.controller) throw new AppError('CONFLICT', '这个会话已有活动运行')
    const controller = new AbortController()
    this.controller = controller
    const cancel = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    const timers = new TimerScope({ name: 'ActLoop' })
    // 主线续跑：墙钟上限第一次到点只标记，下一轮边界封段续跑；再过一个周期仍没走到轮边界，
    // 说明这一轮卡住了（估算、工具或交互不返回），照旧取消。其余运行到点即取消
    let renewDue = false
    let clock: ReturnType<TimerScope['after']>
    const armClock = () =>
      timers.after(this.options.limits.timeoutMs, () => {
        if (!this.options.frames.renew || renewDue) cancel()
        else {
          renewDue = true
          clock = armClock()
        }
      })
    clock = armClock()
    const runId = this.options.control?.runId ?? crypto.randomUUID()
    this.completionFeedback = undefined
    let completionAttempts = 0
    let terminal: Optional<
      'completed' | 'cancelled' | 'failed' | 'context-blocked' | 'needs-reconcile'
    >
    let heartbeat: Optional<ReturnType<TimerScope['every']>>
    let renewal: Optional<Promise<void>>
    let ownsView = false
    let yielded = false
    try {
      controller.signal.throwIfAborted()
      const inputValue = isString(input) ? { text: input } : input
      if (
        !inputValue ||
        !isObject(inputValue) ||
        (!isUndefined(inputValue.text) && !isString(inputValue.text)) ||
        (!inputValue.text && !inputValue.images?.length && !inputValue.files?.length)
      )
        throw new AppError('VALIDATION', '输入需要文字、文件引用或图片')
      if (!isUndefined(inputValue.task) && !['continue', 'new'].includes(inputValue.task))
        throw new AppError('VALIDATION', '任务模式无效')
      const images =
        inputValue.images?.map((image) => ({ ...image, origin: 'user' as const })) ?? []
      modelRequestEncoder.messages({
        instructions: '',
        materials: [],
        images,
        response: { type: 'text' },
        mode: 'work',
        outputTokens: 1,
      })
      const user = await this.options.context.ingest(
        {
          text: inputValue.text ?? (inputValue.images?.length ? '[用户图片输入]' : ''),
          files: inputValue.files,
        },
        controller.signal
      )
      for (const image of images)
        await this.options.context.append(
          { kind: 'audit', title: 'user:image', body: JSON.stringify(image), sources: [user.ref] },
          controller.signal
        )
      await this.options.view.begin(user.ref, controller.signal, inputValue.task ?? 'continue')
      ownsView = true
      yield { type: 'input', runId, ref: user.ref, inputId: inputValue.inputId, source: 'submit' }
      let inputApplied = false
      heartbeat = timers.every(
        Math.max(1, Math.floor(this.options.view.limits.leaseMs / 3)),
        () => {
          if (renewal || controller.signal.aborted) return
          renewal = this.options.view
            .renew(controller.signal)
            .catch((error) => controller.abort(error))
            .finally(() => {
              renewal = undefined
            })
        }
      )
      let sinceRenewal = 0
      this.stallBase = undefined
      turns: for (
        let turn = 0;
        this.options.frames.renew || turn < this.options.limits.turns;
        turn++
      ) {
        controller.signal.throwIfAborted()
        if (this.options.frames.renew && (renewDue || sinceRenewal >= this.options.limits.turns)) {
          const cause = renewDue ? ('clock' as const) : ('turns' as const)
          renewDue = false
          sinceRenewal = 0
          await this.options.frames.renew(this.capacity().budget, controller.signal)
          clock.cancel()
          clock = armClock()
          yield { type: 'renewed', runId, cause }
        }
        sinceRenewal++
        await this.options.control?.beforeTurn(controller.signal)
        const preparationStarted = performance.now()
        await this.options.frames.prepare(controller.signal)
        const observationMs = performance.now() - preparationStarted
        const projectionStarted = performance.now()
        const decoder = this.options.protocol.open()
        let frame: Nullable<ActComposedFrame> = null
        for (let refresh = 0; refresh < 3; refresh++)
          try {
            frame = await boundedModelOperation(
              this.frame(controller.signal, decoder.instructions),
              controller.signal
            )
            break
          } catch (error) {
            if (!controller.signal.aborted && this.options.control?.pending()) continue turns
            if ((error as { code?: string }).code !== 'STALE_VIEW' || refresh === 2) throw error
          }
        if (!frame) {
          terminal = 'context-blocked'
          yield { type: 'state', runId, status: 'context_blocked' }
          return
        }
        // 暂停而不是结束：任务保留，用户的下一条输入继续同一个任务
        if (frame.repeatedSteps >= ContextPlanTuning.stallPause) {
          yield {
            type: 'stalled',
            runId,
            repeatedSteps: frame.repeatedSteps,
            message: `连续 ${frame.repeatedSteps} 步没有进展（程序、输出、证据和计划都没变），已暂停。回复任意内容即可让它换个办法继续。`,
          }
          yielded = true
          yield { type: 'state', runId, status: 'waiting' }
          return
        }
        let compiled: CompiledModelRequest = frame
        const contextMs = performance.now() - projectionStarted
        let decoded: Optional<ActDecodedTurn>
        let acceptedTurnId = ''
        for (let repair = 0; repair <= Math.max(2, this.policy.recoveryAttempts); repair++) {
          decoder.reset()
          // 每小时用量到上限：等窗口释放后继续；用户总上限到了：暂停等用户，不算失败
          for (;;)
            try {
              await this.options.view.reserveModel(
                'main',
                compiled.estimate.tokens + compiled.request.outputTokens
              )
              break
            } catch (error) {
              const code = (error as { code?: string }).code
              if (code === 'MODEL_BUDGET') {
                yield {
                  type: 'error',
                  runId,
                  message: '任务的模型用量已到上限，已暂停；调高上限后发送任意内容即可继续。',
                }
                yielded = true
                yield { type: 'state', runId, status: 'waiting' }
                return
              }
              if (code !== 'MODEL_RATE') throw error
              const retryAfterMs =
                (error as { retryAfterMs?: number }).retryAfterMs ?? AgentTuning.rateRetryMs
              yield { type: 'throttled', runId, retryAfterMs }
              await modelProviderRetry.wait(retryAfterMs, controller.signal)
            }
          const audit = await this.options.context.append(
            {
              kind: 'audit',
              title: 'model-request',
              body: JSON.stringify({
                runId,
                turn,
                repair,
                preparation: repair === 0 ? { observationMs, contextMs } : undefined,
                model: this.options.model.id,
                estimate: compiled.estimate,
                providerRequest: compiled.providerRequest,
                request: compiled.request,
              }),
            },
            controller.signal
          )
          await this.options.control?.applied?.(audit.ref.id, controller.signal)
          if (!inputApplied) {
            yield {
              type: 'input-applied',
              runId,
              ref: user.ref,
              inputId: inputValue.inputId,
              turnId: audit.ref.id,
            }
            inputApplied = true
          }
          yield { type: 'turn', runId, turnId: audit.ref.id }
          yield { type: 'state', runId, status: 'thinking' }
          let finish: Optional<Extract<ModelTurnDelta, { type: 'finish' }>>
          let measured = false
          let received = ''
          let responseRef: Optional<{ sessionId: string; id: string }>
          let usage: Optional<{ inputTokens: number; outputTokens: number }>
          const attemptController = new AbortController()
          const deadline = this.options.frames.deadline?.()
          const attemptSignal = AbortSignal.any([
            controller.signal,
            attemptController.signal,
            ...(this.options.control ? [this.options.control.turnSignal()] : []),
            ...(deadline ? [AbortSignal.timeout(Math.max(1, deadline - Date.now()))] : []),
          ])
          const modelStarted = performance.now()
          let firstTextMs: Nullable<number> = null
          let modelMs: Nullable<number> = null
          try {
            for await (const delta of boundedModelStream(
              this.options.model,
              compiled.request,
              attemptSignal
            )) {
              controller.signal.throwIfAborted()
              if (finish) throw new AppError('PROTOCOL', '模型在结束响应后继续发送内容')
              if (delta.type === 'error')
                throw AppError.withFields(
                  delta.code === 'context-limit' ? 'CONTEXT_BUDGET' : 'MODEL_PROVIDER',
                  delta.message,
                  { retryAfterMs: delta.retryAfterMs }
                )
              if (delta.type === 'usage') {
                if (measured) throw new AppError('PROTOCOL', '模型重复返回用量')
                measured = true
                usage = { inputTokens: delta.inputTokens, outputTokens: delta.outputTokens }
                this.planner.measure(compiled.measured, delta.inputTokens)
                if (!isUndefined(delta.cacheReadTokens) || !isUndefined(delta.cacheWriteTokens))
                  this.cache = {
                    readTokens: delta.cacheReadTokens ?? 0,
                    writeTokens: delta.cacheWriteTokens ?? 0,
                  }
                await this.options.view.recordUsage(delta.inputTokens, delta.outputTokens)
                yield {
                  type: 'usage',
                  runId,
                  inputTokens: delta.inputTokens,
                  outputTokens: delta.outputTokens,
                }
              }
              if (delta.type === 'reasoning' && !isEmpty(delta.text))
                yield { type: 'reasoning', runId, text: delta.text }
              if (delta.type === 'text') {
                if (isNull(firstTextMs) && !isEmpty(delta.text))
                  firstTextMs = performance.now() - modelStarted
                received += delta.text
                for (const preview of decoder.push(delta.text)) yield { ...preview, runId }
              }
              if (delta.type === 'finish') finish = delta
            }
            modelMs = performance.now() - modelStarted
            if (!finish || finish.reason !== 'stop' || !received)
              throw new AppError('PROTOCOL', '模型响应未完整结束，程序没有执行')
            decoded = decoder.finish()
            for (const preview of decoded.events) yield { ...preview, runId }
            const accepted = await this.options.context.append(
              { kind: 'assistant', body: received, sources: [audit.ref] },
              controller.signal
            )
            responseRef = accepted.ref
            await this.options.context.append(
              {
                kind: 'audit',
                title: 'model-response',
                body: JSON.stringify({
                  runId,
                  turnId: audit.ref.id,
                  status: 'accepted',
                  timing: { modelMs, firstTextMs },
                  finish,
                  usage,
                  rawRef: responseRef,
                  decoded: {
                    message: decoded.message,
                    done: decoded.done,
                    completion: decoded.completion,
                    submission: decoded.submission,
                  },
                }),
                sources: [audit.ref, responseRef],
              },
              controller.signal
            )
            acceptedTurnId = `${audit.ref.id}:${accepted.ref.id}`
            yield {
              type: 'accepted',
              runId,
              turnId: audit.ref.id,
              text: decoded.message,
              ref: accepted.ref,
            }
            break
          } catch (error) {
            modelMs ??= performance.now() - modelStarted
            // 即使接收被取消，也保存已经收到的原始字节；这些内容不授权执行。
            if (!responseRef)
              responseRef = (
                await this.options.context.append({
                  kind: 'audit',
                  title: 'model-response-raw',
                  body: received,
                  sources: [audit.ref],
                })
              ).ref
            await this.options.context.append({
              kind: 'audit',
              title: 'model-response',
              body: JSON.stringify({
                runId,
                turnId: audit.ref.id,
                status: 'rejected',
                timing: { modelMs, firstTextMs },
                finish,
                usage,
                rawRef: responseRef,
                error: {
                  message: error instanceof Error ? error.message : String(error),
                  code: (error as { code?: string }).code,
                },
              }),
              sources: [audit.ref, responseRef],
            })
            yield {
              type: 'rejected',
              runId,
              turnId: audit.ref.id,
              message: error instanceof Error ? error.message : String(error),
            }
            if (!controller.signal.aborted && this.options.control?.pending()) continue turns
            const retryDelay = (error as { retryAfterMs?: number }).retryAfterMs
            if (
              !attemptSignal.aborted &&
              (error as { code?: string }).code === 'MODEL_PROVIDER' &&
              Number.isFinite(retryDelay) &&
              retryDelay! >= 0 &&
              repair < this.policy.recoveryAttempts
            ) {
              // 此响应尚未被接受，没有任何脚本被派发；每次重新请求继续计入预算和追踪。
              await this.options.context.append(
                {
                  kind: 'event',
                  title: 'model-retry',
                  body: JSON.stringify({
                    turnId: audit.ref.id,
                    attempt: repair + 1,
                    executed: false,
                    delayMs: Math.min(30000, retryDelay! * 2 ** repair),
                  }),
                },
                controller.signal
              )
              await modelProviderRetry.wait(
                Math.min(30000, retryDelay! * 2 ** repair),
                attemptSignal
              )
              continue
            }
            if (
              !controller.signal.aborted &&
              (error as { code?: string }).code === 'CONTEXT_BUDGET' &&
              repair < this.policy.recoveryAttempts
            ) {
              // 实际超窗说明校准偏小：回到原始估算、封段后重组，再不行就用恢复窗口
              this.planner.rejected()
              const repaired = await this.frame(controller.signal, decoder.instructions, {
                provider: true,
                recovery: repair > 0,
              })
              if (!repaired) throw error
              frame = repaired
              compiled = repaired
              continue
            }
            if (
              controller.signal.aborted ||
              (error as { code?: string }).code !== 'SCRIPT_PROTOCOL' ||
              repair === 2
            )
              throw error
            const message = error instanceof Error ? error.message : String(error)
            await this.options.context.append(
              {
                kind: 'event',
                title: 'protocol-rejected',
                body: JSON.stringify({ frame: audit.ref.id, executed: false, message }),
              },
              controller.signal
            )
            yield { type: 'error', runId, message: `协议未通过，正在修复：${message}` }
            compiled = await boundedModelOperation(
              this.compiler.compileModelTurn(
                {
                  ...frame.request,
                  compiledPrompt: `${frame.request.compiledPrompt}\n本帧上次响应未通过校验，任何程序都没有执行。请重新输出完整响应并修复：${message.slice(0, 4000)}`,
                },
                this.options.model,
                this.options.limits.safetyTokens
              ),
              controller.signal
            )
            if (!compiled.okToSend)
              throw new AppError('CONTEXT_BUDGET', '协议修复请求超过上下文预算')
          } finally {
            attemptController.abort()
          }
        }
        if (this.options.control?.pending()) continue
        if (!decoded) throw new AppError('PROTOCOL', '没有可接受的完整响应')
        await this.options.frames.acknowledge(compiled.request, controller.signal)
        this.planner.accept(compiled.estimate.tokens, frame.segment)
        if (!isUndefined(decoded.submission)) {
          yield { type: 'state', runId, status: 'executing' }
          const success = await this.options.execution.invoke(
            decoded.submission,
            controller.signal,
            acceptedTurnId
          )
          if (isFalse(success) || !decoded.done) continue
          await this.options.frames.prepare(controller.signal)
          await this.options.view.build(
            {
              maxChars: this.options.limits.projectionChars,
              visibleExecutionIds: await this.options.frames.visibleExecutions(),
            },
            controller.signal
          )
        }
        if (compiled.request.mode === 'maintenance') continue
        if (this.options.execution.pending()) {
          yield { type: 'state', runId, status: 'waiting' }
          await this.options.execution.wait(controller.signal)
          continue
        }
        if (!decoded.done) {
          yielded = true
          yield { type: 'state', runId, status: 'waiting' }
          return
        }
        if (
          this.options.control?.pending() ||
          (await this.options.frames.needsRefresh(compiled.request))
        )
          continue
        const completionSignal = AbortSignal.any([
          controller.signal,
          ...(this.options.control ? [this.options.control.turnSignal()] : []),
        ])
        let completion: ContextCompletionResult
        try {
          completion =
            (await this.options.frames.completion?.(
              compiled.request,
              completionSignal,
              decoded.completion
            )) ??
            (await this.options.view.complete(this.options.completionVerifier, completionSignal))
        } catch (error) {
          if (
            !controller.signal.aborted &&
            this.options.control?.pending() &&
            (completionSignal.aborted || (error as { code?: string }).code === 'STALE_VIEW')
          )
            continue turns
          throw error
        }
        yield { type: 'verification', runId, ...completion }
        if (!completion.completed) {
          await this.options.context.append(
            { kind: 'event', title: 'completion-blocked', body: JSON.stringify(completion) },
            controller.signal
          )
          this.completionFeedback = completion
          const recovery = completion.recovery ?? 'repair'
          if (
            (recovery === 'repair' || recovery === 'refresh') &&
            completionAttempts++ < this.policy.recoveryAttempts
          )
            continue
          if (recovery === 'input') {
            yielded = true
            yield { type: 'state', runId, status: 'waiting' }
            return
          }
          terminal =
            recovery === 'reconcile'
              ? 'needs-reconcile'
              : recovery === 'capacity'
                ? 'context-blocked'
                : 'failed'
          yield {
            type: 'state',
            runId,
            status:
              terminal === 'needs-reconcile'
                ? 'needs_reconcile'
                : terminal === 'context-blocked'
                  ? 'context_blocked'
                  : 'failed',
          }
          return
        }
        terminal = 'completed'
        yield { type: 'state', runId, status: 'completed' }
        return
      }
      throw new AppError('LIMIT', '运行达到回合上限，已保存当前上下文')
    } catch (error) {
      Log.tag('ActRuntime').debug('ActLoop 已进入异常处理或降级分支')
      terminal = controller.signal.aborted
        ? 'cancelled'
        : (error as { code?: string }).code === 'CONTEXT_BUDGET'
          ? 'context-blocked'
          : 'failed'
      yield {
        type: 'error',
        runId,
        message: error instanceof Error ? error.message : String(error),
      }
      yield {
        type: 'state',
        runId,
        status: terminal === 'context-blocked' ? 'context_blocked' : terminal,
      }
    } finally {
      heartbeat?.cancel()
      controller.abort()
      const failures: unknown[] = []
      try {
        try {
          await renewal
        } catch (error) {
          Log.tag('ActRuntime').debug('ActLoop 已进入异常处理或降级分支')
          failures.push(error)
        }
        try {
          await this.options.execution.stop()
        } catch (error) {
          Log.tag('ActRuntime').debug('ActLoop 已进入异常处理或降级分支')
          failures.push(error)
        }
        try {
          await this.options.frames.end?.(!isEmpty(failures) ? 'failed' : terminal)
        } catch (error) {
          Log.tag('ActRuntime').debug('ActLoop 已进入异常处理或降级分支')
          failures.push(error)
        }
        try {
          if (ownsView)
            await this.options.view.end(
              !isEmpty(failures) ? 'failed' : (terminal ?? (yielded ? undefined : 'cancelled'))
            )
        } catch (error) {
          Log.tag('ActRuntime').debug('ActLoop 已进入异常处理或降级分支')
          failures.push(error)
        }
      } finally {
        timers.dispose()
        signal?.removeEventListener('abort', cancel)
        this.controller = undefined
      }
      // 主错误已通过事件送达；提前 return 也必须向宿主暴露收尾失败。
      if (!isEmpty(failures)) {
        // eslint-disable-next-line no-unsafe-finally -- 主错误已作为事件送达，收尾错误必须独立报告
        throw new AggregateError(failures, '运行收尾失败，必须检查持久状态和操作回执')
      }
    }
  }

  private async frame(
    signal: AbortSignal,
    protocolInstructions: string,
    repair: { provider: boolean; recovery: boolean } = { provider: false, recovery: false },
    attempt = 0
  ): Promise<Nullable<ActComposedFrame>> {
    const { model, limits, frames, view } = this.options
    const maintenanceSignal = AbortSignal.any([
      signal,
      ...(this.options.control ? [this.options.control.turnSignal()] : []),
    ])
    const { outputTokens, window, budget } = this.capacity()
    // 显式整理请求在请求边界处理：Runtime 先封段，再运行整理支线
    if (attempt === 0)
      await frames.maintain?.({ reason: 'boundary', targetChars: budget }, maintenanceSignal)
    const evidence = await view.build(
      { maxChars: limits.projectionChars, visibleExecutionIds: await frames.visibleExecutions() },
      signal
    )
    const recovery = this.completionFeedback
      ? `\n上次完成检查尚未通过：${JSON.stringify(this.completionFeedback)}。先处理原因；修复或补充证据，不要自动重放存在未知效果的脚本。`
      : ''
    // 本次运行里连续没有进展的步数：从运行开始时的计数起算，用户新的输入之后重新给机会
    const repeated = evidence.progress.repeatedSteps
    if (isUndefined(this.stallBase) || repeated < this.stallBase) this.stallBase = repeated
    const repeatedSteps = repeated - this.stallBase
    const reflection =
      repeatedSteps >= ContextPlanTuning.stallReflect
        ? `\n反思轮：本次运行已连续 ${repeatedSteps} 步没有进展（程序、输出、证据和计划都没变，也没有写效果）。这一轮不要再跑同样的程序：先用 memory.plan 写下换什么办法，把试过没用的做法记进笔记，再继续。`
        : ''
    const compose = async (maxChars: number) => {
      const projected = await frames.project(evidence, signal, maxChars)
      const phase = frames.phase?.() ?? { phase: 'work' as const, instructions: '' }
      const request = framedRequest(
        {
          history: projected.history,
          instructions: this.options.instructions,
          images: projected.images,
          compiledPrompt: projected.prompt,
          materials: [
            {
              ref: evidence.id,
              origin: 'runtime-view',
              text: projected.body,
              totalChars: projected.body.length,
            },
          ],
          response: { type: 'text' },
          mode: phase.phase === 'maintenance' ? 'maintenance' : 'work',
          outputTokens,
        },
        `${protocolInstructions}\n${phase.instructions}${recovery}${reflection}`
      )
      const compiled = await this.compiler.compileModelTurn(
        request,
        model,
        limits.safetyTokens,
        this.planner.calibration()
      )
      this.planner.density(requestChars(request), compiled.estimate.tokens)
      return { segment: projected.segment, phase, request, compiled }
    }
    const fits = (current: Awaited<ReturnType<typeof compose>>) =>
      current.compiled.okToSend && current.compiled.estimate.tokens <= window
    // 整理支线的目标：给结构性超载留出 minTurns 轮的增长
    const target = Math.max(
      512,
      this.planner.chars(
        Math.max(1, window - this.policy.minTurns * this.planner.growth(window)),
        limits.projectionChars
      )
    )
    let folded = false
    if (repair.provider) {
      folded = await this.fold('provider', budget, signal)
      // 供应商说放不下、又没有可封的历史：交给整理支线收紧展示
      if (
        !folded &&
        attempt === 0 &&
        (await frames.maintain?.({ reason: 'provider', targetChars: target }, maintenanceSignal))
      )
        return this.frame(
          signal,
          protocolInstructions,
          { provider: false, recovery: repair.recovery },
          attempt + 1
        )
    }
    let current = await compose(repair.recovery ? Math.min(budget, limits.recoveryChars) : budget)
    let runway = this.planner.runway(current.compiled.estimate.tokens, window)
    // 放不下或剩余轮数不足就封段；剩余不多时遇到章节边界也封段。抖动说明工作集本身装不下，再封也没用
    if (!folded && !repair.provider && !this.planner.thrashing()) {
      const reason = !fits(current)
        ? ('overflow' as const)
        : runway < this.policy.foldTurns
          ? ('runway' as const)
          : runway < this.policy.boundaryTurns && (await frames.boundary?.(signal))
            ? ('boundary' as const)
            : undefined
      if (reason && (await this.fold(reason, budget, signal))) {
        folded = true
        current = await compose(budget)
        runway = this.planner.runway(current.compiled.estimate.tokens, window)
      }
    }
    // 结构性超载：放不下，或封不了段时剩余不足 foldTurns 轮、封段后剩余仍不足 minTurns 轮，
    // 或本段缺页持续偏高（笔记和结果本身挤不下）。
    // 主线交给整理支线一次；放不下时叶子工具直接进入交付阶段
    const short = runway < (folded ? this.policy.minTurns : this.policy.foldTurns)
    const faults = current.segment?.faults ?? 0
    const faulting =
      faults >= ContextPlanTuning.faultCount &&
      faults * ContextPlanTuning.faultTurns >= (current.segment?.turns ?? 0)
    if ((!fits(current) || short || faulting) && current.phase.phase !== 'finalizing') {
      // 同一段只整理一次：整理过仍不够，就不再每轮重复，等下次封段
      const segment = current.segment?.id
      if (attempt > 0 && segment) this.planner.exhaust(segment)
      if (attempt === 0 && !(segment && this.planner.exhausted(segment)) && frames.maintain) {
        if (await frames.maintain({ reason: 'pressure', targetChars: target }, maintenanceSignal))
          return this.frame(signal, protocolInstructions, repair, attempt + 1)
        if (segment) this.planner.exhaust(segment)
      }
      if (!fits(current)) {
        frames.pressure?.()
        current = await compose(budget)
      }
    }
    // 仍放不下只剩恢复窗口：基础目标、当前图片和必要运行状态必须装得下
    if (!fits(current)) current = await compose(Math.min(budget, limits.recoveryChars))
    if (!current.compiled.okToSend) return null
    runway = this.planner.runway(current.compiled.estimate.tokens, window)
    frames.setPhase(current.phase.phase)
    const tighten =
      '按 memoryStatus.footprint 找占用最大的分区，收紧 observe 的 view，释放不再需要的 task 租约，合并或移出笔记，或把独立的子目标交给子 agent。'
    const overload = faulting
      ? `本段已经 ${faults} 次读回上一帧因容量不够只给了引用的材料，工作集本身装不下：${tighten}`
      : (folded ||
            this.planner.thrashing() ||
            Boolean(current.segment && this.planner.exhausted(current.segment.id))) &&
          runway < this.policy.minTurns
        ? `工作集本身快装不下了：${tighten}`
        : undefined
    const status = (tokens: number) => {
      const turns = this.planner.runway(tokens, window)
      return {
        mode: frames.mode,
        phase: current.phase.phase,
        frameId: evidence.id,
        pressure:
          turns < this.policy.foldTurns
            ? ('critical' as const)
            : turns < this.policy.boundaryTurns
              ? ('warning' as const)
              : ('normal' as const),
        inputTokens: tokens,
        precision: current.compiled.estimate.precision,
        basis: current.compiled.estimate.basis,
        inputLimit: window,
        outputReserve: outputTokens,
        safetyReserve: limits.safetyTokens,
        remainingTokens: Math.max(0, window - tokens),
        advice:
          '原文按引用归档；工作笔记是模型解释，引用不代表已读正文。上下文按剩余轮数自动封段，封进卷的历史仍可按引用召回。',
        runway: {
          turns: Math.max(0, Math.floor(turns)),
          growthPerTurn: this.planner.growth(window),
        },
        segment: current.segment
          ? {
              index: current.segment.index,
              turns: current.segment.turns,
              volumes: current.segment.volumes,
            }
          : undefined,
        cache: this.cache,
        overload,
        stall:
          repeatedSteps >= ContextPlanTuning.stallNotice
            ? {
                repeatedSteps,
                advice:
                  '连续几步没有进展：先换办法，别重复同样的程序；试过没用的做法记进笔记或计划。',
              }
            : undefined,
      }
    }
    let compiled = current.compiled
    let tokens = compiled.estimate.tokens
    for (let count = 0; count < 3; count++) {
      compiled = await this.compiler.compileModelTurn(
        { ...current.request, contextStatus: status(tokens) },
        model,
        limits.safetyTokens,
        this.planner.calibration()
      )
      if (compiled.estimate.tokens === tokens) break
      tokens = compiled.estimate.tokens
    }
    if (!compiled.okToSend) return null
    if (!(await view.validate(evidence, signal)))
      throw new AppError('STALE_VIEW', '发送前证据版本发生变化')
    return {
      projection: {
        revision: evidence.scope.revision,
        cursor: 0,
        records: [],
        chars: current.request.materials[0]!.text.length,
      },
      segment: current.segment,
      repeatedSteps,
      ...compiled,
    }
  }

  /** 本帧的输出预留、工作窗口与投影字符预算。 */
  private capacity() {
    const { model, limits } = this.options
    const outputTokens = Math.min(limits.outputTokens, model.limits.outputTokens)
    const window = Math.min(
      model.limits.inputTokens,
      model.limits.contextTokens - outputTokens - limits.safetyTokens,
      this.policy.windowTokens
    )
    return { outputTokens, window, budget: this.planner.chars(window, limits.projectionChars) }
  }

  /** 让 Runtime 封段；因容量封段时记进规划器，用来判断抖动。 */
  private async fold(
    reason: 'runway' | 'boundary' | 'overflow' | 'provider' | 'renew',
    maxChars: number,
    signal: AbortSignal
  ): Promise<boolean> {
    const folded = !!(await this.options.frames.fold?.(reason, maxChars, signal))
    if (folded) this.planner.folded()
    return folded
  }
}

/** 核心循环只依赖上下文、模型与统一执行口。 */
