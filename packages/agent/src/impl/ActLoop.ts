import type { ContextCompletionResult } from '@velaros-ai/context'
import { isNull } from '@velaros-ai/core'
import { Log } from '@velaros-ai/core'
import { isFalse, isUndefined } from '@velaros-ai/core'
import { isEmpty, isObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'
import {
  type ModelHistoryMessage,
  modelRequestEncoder,
  type ModelToolCall,
  type ModelTurnDelta,
  type ModelTurnRequest,
} from '@velaros-ai/kernel'
import {
  type CompiledModelRequest,
  createProviderRequestCompiler,
  modelProviderRetry,
} from '@velaros-ai/model'

import type { ActLoopOptions, ActRunServiceOptions, ActTurnDecoder } from '../contract/requires.js'
import type { ActComposedFrame, ActDecodedTurn, ActInput, ActRunEvent } from '../types/act.js'
import { sessionCacheKey } from '../utils/cache-key.js'
import { framedRequest, requestChars } from '../utils/frame-prompt.js'
import { boundedModelOperation, boundedModelStream } from '../utils/model-stream.js'
import { AgentTuning, ContextPlanTuning } from '../utils/tuning.js'

import { ContextPlanner } from './ContextPlanner.js'

/** 唯一模型回合推进器，由运行服务持有。 */
export interface ActLoopApi {
  /** 推进一次输入，暂停或终止时返回。 */
  submit(input: string | ActInput, signal?: AbortSignal): AsyncIterable<ActRunEvent>
  /** 使用当前运行的校准、窗口与输出预留，核对候选上下文，不调用模型。 */
  validateContext(request: ModelTurnRequest, signal: AbortSignal): Promise<void>
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
  /**
   * 上一次被接受请求的实际出线。下一帧的逻辑历史以它的逻辑历史开头时只在其后追加，
   * 请求成为上一请求的完整延续，只认完整延续的供应商缓存也能复用整段前缀。
   */
  private transcript?: {
    readonly logical: readonly ModelHistoryMessage[]
    readonly sent: readonly ModelHistoryMessage[]
    readonly positions: readonly number[]
    readonly body: string
  }

  public constructor(
    private readonly options: ActLoopOptions & Pick<ActRunServiceOptions, 'sessionId'>
  ) {
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

  public async validateContext(request: ModelTurnRequest, signal: AbortSignal): Promise<void> {
    const validationSignal = this.controller
      ? AbortSignal.any([signal, this.controller.signal])
      : signal
    validationSignal.throwIfAborted()
    const compiled = await boundedModelOperation(
      this.compiler.compileModelTurn(
        request,
        this.options.model,
        this.options.limits.safetyTokens,
        this.planner.calibration()
      ),
      validationSignal
    )
    if (!compiled.okToSend || compiled.estimate.tokens > this.capacity().window)
      throw new AppError('CONTEXT_BUDGET', '候选上下文超过当前运行的模型输入窗口')
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
    let terminal: Optional<'completed' | 'cancelled' | 'failed' | 'context-blocked'>
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
              this.frame(controller.signal, decoder),
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
        let acceptedCalls: readonly ModelToolCall[] = []
        let acceptedInputTokens: Optional<number>
        let acceptedText = ''
        let acceptedResponseRef: Optional<{ sessionId: string; id: string }>
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
          const calls: ModelToolCall[] = []
          const rawResponse = (): string =>
            !isEmpty(calls) ? JSON.stringify({ text: received, calls }) : received
          let continuation: Optional<Extract<ModelTurnDelta, { type: 'continuation' }>['value']>
          let responseRef: Optional<{ sessionId: string; id: string }>
          let usage: Optional<Omit<Extract<ModelTurnDelta, { type: 'usage' }>, 'type'>>
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
              if (delta.type !== 'usage') controller.signal.throwIfAborted()
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
                this.planner.measure(compiled.measured, delta.inputTokens)
                if (!isUndefined(delta.cacheReadTokens) || !isUndefined(delta.cacheWriteTokens))
                  this.cache = {
                    readTokens: delta.cacheReadTokens ?? 0,
                    writeTokens: delta.cacheWriteTokens ?? 0,
                  }
                // 供应商报告了前缀缓存的读写才带上，宿主据此按缓存价算钱
                const cache: { cacheReadTokens?: number; cacheWriteTokens?: number } = {}
                if (!isUndefined(delta.cacheReadTokens))
                  cache.cacheReadTokens = delta.cacheReadTokens
                if (!isUndefined(delta.cacheWriteTokens))
                  cache.cacheWriteTokens = delta.cacheWriteTokens
                usage = {
                  inputTokens: delta.inputTokens,
                  outputTokens: delta.outputTokens,
                  ...cache,
                }
                await this.options.view.recordUsage(delta.inputTokens, delta.outputTokens)
                yield {
                  type: 'usage',
                  runId,
                  inputTokens: delta.inputTokens,
                  outputTokens: delta.outputTokens,
                  ...cache,
                }
              }
              if (delta.type === 'reasoning' && !isEmpty(delta.text))
                yield { type: 'reasoning', runId, text: delta.text }
              if (delta.type === 'continuation') {
                if (continuation) throw new AppError('PROTOCOL', '模型重复返回延续状态')
                continuation = delta.value
              }
              if (delta.type === 'text') {
                if (isNull(firstTextMs) && !isEmpty(delta.text))
                  firstTextMs = performance.now() - modelStarted
                received += delta.text
                for (const preview of decoder.push(delta.text)) yield { ...preview, runId }
              }
              if (delta.type === 'tool-call') {
                calls.push(delta.value)
                if (!decoder.acceptTool) throw new AppError('PROTOCOL', '当前协议没有声明原生工具')
                if (isNull(firstTextMs)) firstTextMs = performance.now() - modelStarted
                for (const preview of decoder.acceptTool(delta.value)) yield { ...preview, runId }
              }
              if (delta.type === 'finish') finish = delta
            }
            modelMs = performance.now() - modelStarted
            if (!finish || finish.reason !== 'stop' || (!received && isEmpty(calls)))
              throw new AppError('PROTOCOL', '模型响应未完整结束，程序没有执行')
            decoded = decoder.finish()
            for (const preview of decoded.events) yield { ...preview, runId }
            // 先保存完整状态，再让已接受响应引用它；中断或协议拒绝都不能使状态进入历史。
            const continuationRecord = continuation
              ? await this.options.context.append(
                  {
                    kind: 'audit',
                    title: 'model-continuation',
                    body: JSON.stringify(continuation),
                    sources: [audit.ref],
                  },
                  controller.signal
                )
              : undefined
            const accepted = await this.options.context.append(
              {
                kind: 'assistant',
                body: rawResponse(),
                sources: [audit.ref, ...(continuationRecord ? [continuationRecord.ref] : [])],
              },
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
            acceptedCalls = calls
            acceptedInputTokens = usage?.inputTokens
            acceptedText = received
            acceptedResponseRef = accepted.ref
            // 已接受请求的实际出线成为下一帧的前缀；含图片的帧不保留，避免历史图片越积越多。
            const sent = modelRequestEncoder.messages(compiled.request)
            const previous = this.transcript
            const positions =
              frame.retained && previous
                ? [
                    ...previous.positions,
                    ...frame.logical
                      .slice(previous.logical.length)
                      .map((_, index) => previous.sent.length + index),
                  ]
                : frame.logical.map((_, index) => index)
            this.transcript =
              this.options.frames.delta &&
              !sent.some(
                (message) =>
                  message.role === 'user' &&
                  !isString(message.content) &&
                  message.content.some((part) => part.type === 'image')
              )
                ? { logical: frame.logical, sent, positions, body: frame.body }
                : undefined
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
                  body: rawResponse(),
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
              // 实际超窗说明校准偏小：回到原始估算、封段后重组，再不行就用恢复窗口；保留的旧帧一并放弃
              this.planner.rejected()
              this.transcript = undefined
              const repaired = await this.frame(controller.signal, decoder, {
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
                this.options.limits.safetyTokens,
                this.planner.calibration()
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
        this.planner.accept(
          compiled.estimate.tokens,
          frame.segment,
          frame.retained,
          acceptedInputTokens
        )
        let done = decoded.done
        if (!isUndefined(decoded.submission)) {
          yield { type: 'state', runId, status: 'executing' }
          const success = await this.options.execution.invoke(
            decoded.submission,
            controller.signal,
            acceptedTurnId,
            acceptedCalls
          )
          if (!isEmpty(acceptedCalls)) {
            if (!isObject(success) || !('results' in success))
              throw new AppError('INVARIANT', '原生工具执行缺少对应回执')
            const exchange = modelRequestEncoder.toolExchange({
              text: acceptedText,
              calls: acceptedCalls,
              results: success.results,
            })
            await this.options.context.append(
              {
                kind: 'audit',
                title: 'model-tool-exchange',
                body: JSON.stringify(exchange),
                sources: [acceptedResponseRef!],
              },
              controller.signal
            )
          }
          if (isFalse(success) || (isObject(success) && !success.succeeded)) continue
          if (!done && !isEmpty(acceptedCalls) && this.options.frames.deliveryReady?.()) {
            await this.options.context.append(
              {
                kind: 'audit',
                title: 'execution-completion',
                body: JSON.stringify({ turnId: acceptedTurnId, reason: 'validated-delivery' }),
                sources: [acceptedResponseRef!],
              },
              controller.signal
            )
            done = true
          }
          if (!done) continue
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
        if (!done) {
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
          terminal = recovery === 'capacity' ? 'context-blocked' : 'failed'
          yield {
            type: 'state',
            runId,
            status: terminal === 'context-blocked' ? 'context_blocked' : 'failed',
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
    decoder: ActTurnDecoder,
    repair: { provider: boolean; recovery: boolean } = { provider: false, recovery: false },
    attempt = 0
  ): Promise<Nullable<ActComposedFrame>> {
    const { model, limits, frames, view } = this.options
    const protocolInstructions = decoder.instructions
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
    const completionStatus = this.completionFeedback
      ? {
          completed: this.completionFeedback.completed,
          verified: this.completionFeedback.verified,
          reason: this.completionFeedback.reason,
          recovery: this.completionFeedback.recovery,
          reportAvailable: Boolean(this.completionFeedback.report),
        }
      : undefined
    const recovery = completionStatus
      ? `\n上次完成检查尚未通过：${JSON.stringify(completionStatus)}。先处理原因；修复或补充证据，不要自动重放存在未知效果的脚本。`
      : ''
    // 本次运行里连续没有进展的步数：从运行开始时的计数起算，用户新的输入之后重新给机会
    const repeated = evidence.progress.repeatedSteps
    if (isUndefined(this.stallBase) || repeated < this.stallBase) this.stallBase = repeated
    const repeatedSteps = repeated - this.stallBase
    const reflection =
      repeatedSteps >= ContextPlanTuning.stallReflect
        ? `\n反思轮：本次运行已连续 ${repeatedSteps} 步没有进展（程序、输出、证据和计划都没变，也没有写效果）。这一轮不要再跑同样的程序：先用 memory.plan 写下换什么办法，把试过没用的做法记进笔记，再继续。`
        : ''
    // 同一会话每帧同一个缓存键：认它的供应商把这个会话的请求路由到同一处前缀缓存
    const cacheKey = await sessionCacheKey(this.options.sessionId)
    // 本次组帧只在第一次投影时决定是否沿用上次出线；放弃后同一次组帧里的重组不再沿用
    let retain = Boolean(frames.delta)
    const compose = async (maxChars: number) => {
      const projected = await frames.project(evidence, signal, maxChars)
      const phase = frames.phase?.() ?? { phase: 'work' as const, instructions: '' }
      const logical = projected.history ?? []
      const retained = retain ? this.retained(logical) : undefined
      const history = retained ? retained.history : projected.history
      const reconciled = await frames.reconcile?.(
        projected.body,
        history ?? [],
        retained?.body,
        signal
      )
      const body = reconciled?.body ?? projected.body
      const request = framedRequest(
        {
          history,
          instructions: this.options.instructions,
          images: projected.images,
          compiledPrompt:
            reconciled?.prompt ??
            (retained ? frames.delta!(body, retained.body) : projected.prompt),
          materials: [
            {
              ref: evidence.id,
              origin: 'runtime-view',
              text: body,
              totalChars: body.length,
            },
          ],
          response: decoder.response ?? { type: 'text' },
          mode: phase.phase === 'maintenance' ? 'maintenance' : 'work',
          outputTokens,
          cacheKey,
        },
        `${protocolInstructions}\n${phase.instructions}${recovery}${reflection}`
      )
      const compiled = await this.compiler.compileModelTurn(
        request,
        model,
        limits.safetyTokens,
        this.planner.calibration()
      )
      return {
        segment: projected.segment,
        phase,
        request,
        compiled,
        logical,
        body,
        retained: Boolean(retained),
      }
    }
    const fits = (current: Awaited<ReturnType<typeof compose>>) =>
      current.compiled.okToSend && current.compiled.estimate.tokens <= window
    // 恢复预算是兜底。先验证最小投影，再有界试算能容纳的较大正文，避免直接截掉仍可交付的材料。
    // 试算不调用模型、不确认送达；最终重建选中的投影，所有状态仍按它核对。
    const recoverProjection = async () => {
      let lower = Math.min(budget, limits.recoveryChars)
      let upper = budget
      let best = await compose(lower)
      if (!fits(best) || repair.recovery || upper <= lower) return best
      const desired = Math.max(
        best.compiled.estimate.tokens,
        window - this.policy.minTurns * this.planner.growth(window, best.retained)
      )
      let last = lower
      for (
        let count = 0;
        count < ContextPlanTuning.projectionAttempts && upper - lower > 1;
        count++
      ) {
        signal.throwIfAborted()
        last = Math.floor((lower + upper) / 2)
        const candidate = await compose(last)
        if (fits(candidate) && candidate.compiled.estimate.tokens <= desired) {
          lower = last
          best = candidate
        } else upper = last
      }
      signal.throwIfAborted()
      return last === lower ? best : compose(lower)
    }
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
          decoder,
          { provider: false, recovery: repair.recovery },
          attempt + 1
        )
    }
    const first = repair.recovery ? Math.min(budget, limits.recoveryChars) : budget
    let current = await compose(first)
    let runway = this.planner.runway(current.compiled.estimate.tokens, window, current.retained)
    retain = current.retained
    // 已接受的前缀能完整发送就继续沿用；预测增长只作预警，不提前改写已交付事实。
    // 真实放不下时先重建逻辑历史与完整帧，再考虑退卡和封段。
    if (current.retained && !fits(current)) {
      retain = false
      this.transcript = undefined
      current = await compose(first)
      runway = this.planner.runway(current.compiled.estimate.tokens, window, current.retained)
    }
    // 无可延续前缀时仍按剩余轮数规划；已保留的完整请求仅在实际超窗时回收。
    if (
      !repair.provider &&
      (!fits(current) || (!current.retained && runway < this.policy.foldTurns)) &&
      (await frames.retire?.(signal))
    ) {
      retain = false
      this.transcript = undefined
      current = await compose(first)
      runway = this.planner.runway(current.compiled.estimate.tokens, window, current.retained)
    }
    // 抖动只抑制预测性的提前封段；实际超窗仍尝试回收已可封存的历史，每次组帧最多成功封一次。
    if (
      !folded &&
      !repair.provider &&
      (!fits(current) || (!current.retained && !this.planner.thrashing()))
    ) {
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
        runway = this.planner.runway(current.compiled.estimate.tokens, window, current.retained)
      }
    }
    if (!fits(current) && current.phase.phase !== 'finalizing') {
      current = await recoverProjection()
      runway = this.planner.runway(current.compiled.estimate.tokens, window, current.retained)
    }
    // 本地重组后仍放不下才调用额外整理模型。预测余量和重复缺页留作当前帧提示，
    // 不把尚可执行的主线变成另一条付费工作流；显式整理仍在请求边界处理。
    const faults = current.segment?.faults ?? 0
    const faulting =
      faults >= ContextPlanTuning.faultCount &&
      faults * ContextPlanTuning.faultTurns >= (current.segment?.turns ?? 0)
    if (!fits(current) && current.phase.phase !== 'finalizing') {
      // 同一段只整理一次：整理过仍不够，就不再每轮重复，等下次封段
      const segment = current.segment?.id
      if (attempt > 0 && segment) this.planner.exhaust(segment)
      if (attempt === 0 && !(segment && this.planner.exhausted(segment)) && frames.maintain) {
        if (await frames.maintain({ reason: 'pressure', targetChars: target }, maintenanceSignal))
          return this.frame(signal, decoder, repair, attempt + 1)
        if (segment) this.planner.exhaust(segment)
      }
      if (!fits(current)) {
        current = await compose(Math.min(budget, limits.recoveryChars))
        if (!fits(current)) {
          frames.pressure?.()
          current = await compose(budget)
        }
      }
    }
    // 仍放不下只剩恢复窗口：基础目标、当前图片和必要运行状态必须装得下
    if (!fits(current)) current = await compose(Math.min(budget, limits.recoveryChars))
    if (!fits(current)) return null
    runway = this.planner.runway(current.compiled.estimate.tokens, window, current.retained)
    const tighten =
      '缩小当前工作集，把已确认的结论保留为简短笔记，按需读取大段原文，避免反复展示整份材料。'
    const overload = faulting
      ? `本段已经 ${faults} 次读回上一帧因容量不够只给了引用的材料，工作集本身装不下：${tighten}`
      : (folded ||
            this.planner.thrashing() ||
            Boolean(current.segment && this.planner.exhausted(current.segment.id))) &&
          runway < this.policy.minTurns
        ? `工作集本身快装不下了：${tighten}`
        : undefined
    const status = (tokens: number) => {
      const turns = this.planner.runway(tokens, window, current.retained)
      return {
        mode: frames.mode,
        phase: current.phase.phase,
        frameId: evidence.id,
        ...(frames.fold ? { automaticHistory: true as const } : {}),
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
          '原文按引用归档；工作笔记是模型解释，引用不代表已读正文。输入段容量与输出额度分开计量，封存的历史可按引用召回。',
        runway: {
          turns: Math.max(0, Math.floor(turns)),
          growthPerTurn: this.planner.growth(window, current.retained),
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
    const finalize = async () => {
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
      return compiled
    }
    let compiled = await finalize()
    // 状态说明也是实际请求的一部分；追加后越界仍先收紧投影，再判断容量受阻。
    if (!compiled.okToSend || compiled.estimate.tokens > window) {
      retain = false
      this.transcript = undefined
      current = await compose(Math.min(budget, limits.recoveryChars))
      compiled = await finalize()
    }
    if (!compiled.okToSend || compiled.estimate.tokens > window) return null
    // 只从选中的完整请求学习字符密度，本地探测不挤占后续帧的样本。
    this.planner.density(requestChars(compiled.request), compiled.estimate.tokens)
    frames.setPhase(current.phase.phase)
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
      logical: current.logical,
      body: current.body,
      retained: current.retained,
      ...compiled,
    }
  }

  /**
   * 新投影以上次接受请求的逻辑历史开头时，沿用那次的实际出线（含它的最后一条消息）再追加新条目；
   * 历史被改写（封段、超窗重组等）就返回 undefined，本帧完整重发并重新开始保留。
   * 断点跟随逻辑条目的实际位置，另保留上次请求末尾；相同内容和插入帧不共享标记。
   */
  private retained(
    logical: readonly ModelHistoryMessage[]
  ): Optional<{ history: readonly ModelHistoryMessage[]; body: string }> {
    const transcript = this.transcript
    if (!transcript || logical.length < transcript.logical.length) return undefined
    const identity = ({ cacheBreakpoint: _mark, ...message }: ModelHistoryMessage) =>
      JSON.stringify(message)
    for (const [index, message] of transcript.logical.entries())
      if (identity(message) !== identity(logical[index]!)) return undefined
    // 帧里也有首次交付的事实正文；只在完整请求放不下时重建，避免预测突增提前打断前缀。
    // 逻辑条目在已发送前缀中的位置不会变；不能按内容匹配，否则重复结果会串标。
    const marked = new Set(
      transcript.positions.filter((_, index) => logical[index]?.cacheBreakpoint)
    )
    const last = transcript.sent.length - 1
    const sent = transcript.sent.map(({ cacheBreakpoint: _mark, ...message }, index) =>
      index === last || marked.has(index) ? { ...message, cacheBreakpoint: true } : message
    )
    return {
      history: [...sent, ...logical.slice(transcript.logical.length)],
      body: transcript.body,
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
