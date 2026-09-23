import type { ContextCompletionResult, ContextProjection } from '@velaros-ai/context'
import { isNull } from '@velaros-ai/core'
import { Log } from '@velaros-ai/core'
import { isFalse, isUndefined } from '@velaros-ai/core'
import { isEmpty, isObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'
import { modelRequestEncoder, type ModelTurnDelta, type ModelTurnRequest } from '@velaros-ai/kernel'
import {
  type CompiledModelRequest,
  createProviderRequestCompiler,
  modelProviderRetry,
} from '@velaros-ai/model'

import type { ActLoopOptions } from '../contract/requires.js'
import type { ActDecodedTurn, ActInput, ActRunEvent } from '../types/act.js'
import { framedRequest } from '../utils/frame-prompt.js'
import { boundedModelOperation, boundedModelStream } from '../utils/model-stream.js'

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

  public constructor(private readonly options: ActLoopOptions) {
    this.policy = {
      warningRatio: 0.75,
      maintenanceRatio: 0.8,
      maxMaintenanceTurns: 3,
      recoveryAttempts: 2,
      ...options.frames.policy,
    }
    if (
      !(
        this.policy.warningRatio > 0 &&
        this.policy.warningRatio < this.policy.maintenanceRatio &&
        this.policy.maintenanceRatio < 1
      ) ||
      !Number.isSafeInteger(this.policy.maxMaintenanceTurns) ||
      this.policy.maxMaintenanceTurns < 1 ||
      this.policy.maxMaintenanceTurns > 16 ||
      !Number.isSafeInteger(this.policy.recoveryAttempts) ||
      this.policy.recoveryAttempts < 1 ||
      this.policy.recoveryAttempts > 4
    )
      throw new AppError('VALIDATION', '上下文容量策略无效')
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
    timers.after(this.options.limits.timeoutMs, cancel)
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
      turns: for (let turn = 0; turn < this.options.limits.turns; turn++) {
        controller.signal.throwIfAborted()
        await this.options.control?.beforeTurn(controller.signal)
        const preparationStarted = performance.now()
        await this.options.frames.prepare(controller.signal)
        const observationMs = performance.now() - preparationStarted
        const projectionStarted = performance.now()
        const decoder = this.options.protocol.open()
        let frame: Awaited<ReturnType<ActLoop['frame']>> = null
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
        let compiled: CompiledModelRequest = frame
        const contextMs = performance.now() - projectionStarted
        let decoded: Optional<ActDecodedTurn>
        let acceptedTurnId = ''
        for (let repair = 0; repair <= Math.max(2, this.policy.recoveryAttempts); repair++) {
          decoder.reset()
          await this.options.view.reserveModel(
            'main',
            compiled.estimate.tokens + compiled.request.outputTokens
          )
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
                await this.options.view.recordUsage(delta.inputTokens, delta.outputTokens)
                yield {
                  type: 'usage',
                  runId,
                  inputTokens: delta.inputTokens,
                  outputTokens: delta.outputTokens,
                }
              }
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
              const repaired = await this.frame(
                controller.signal,
                decoder.instructions,
                Math.max(512, Math.floor(this.options.limits.recoveryChars / (repair + 1))),
                'provider'
              )
              if (!repaired) throw error
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
            (await this.options.frames.completion?.(compiled.request, completionSignal)) ??
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
    targetChars?: number,
    reason: 'boundary' | 'pressure' | 'provider' = 'boundary',
    attempt = 0
  ): Promise<Nullable<{ projection: ContextProjection } & CompiledModelRequest>> {
    const { model, limits, frames, view } = this.options
    const maintenanceSignal = AbortSignal.any([
      signal,
      ...(this.options.control ? [this.options.control.turnSignal()] : []),
    ])
    if (attempt === 0)
      await frames.maintain?.(
        { reason, targetChars: targetChars ?? limits.projectionChars },
        maintenanceSignal
      )
    const evidence = await view.build(
      { maxChars: limits.projectionChars, visibleExecutionIds: await frames.visibleExecutions() },
      signal
    )
    let projected = await frames.project(evidence, signal, targetChars ?? limits.projectionChars)
    let body = projected.body
    let phase = frames.phase?.() ?? { phase: 'work' as const, instructions: '' }
    const recovery = this.completionFeedback
      ? `\n上次完成检查尚未通过：${JSON.stringify(this.completionFeedback)}。先处理原因；修复或补充证据，不要自动重放存在未知效果的脚本。`
      : ''
    let request: ModelTurnRequest = framedRequest(
      {
        history: projected.history,
        instructions: this.options.instructions,
        images: projected.images,
        compiledPrompt: projected.prompt,
        materials: [
          { ref: evidence.id, origin: 'runtime-view', text: body, totalChars: body.length },
        ],
        response: { type: 'text' },
        mode: phase.phase === 'maintenance' ? 'maintenance' : 'work',
        outputTokens: Math.min(limits.outputTokens, model.limits.outputTokens),
      },
      `${protocolInstructions}\n${phase.instructions}${recovery}`
    )
    let compiled = await this.compiler.compileModelTurn(request, model, limits.safetyTokens)
    let inputLimit = Math.min(
      model.limits.inputTokens,
      model.limits.contextTokens - request.outputTokens - limits.safetyTokens
    )
    const pressure =
      !compiled.okToSend || compiled.estimate.tokens > inputLimit * this.policy.maintenanceRatio
    if (pressure && phase.phase !== 'finalizing') {
      const smallerTarget = Math.max(
        512,
        Math.min(
          targetChars ?? limits.projectionChars,
          Math.floor((body.length * inputLimit * 0.6) / Math.max(1, compiled.estimate.tokens))
        )
      )
      if (
        attempt < this.policy.maxMaintenanceTurns &&
        (await frames.maintain?.(
          { reason: 'pressure', targetChars: smallerTarget },
          maintenanceSignal
        ))
      )
        return this.frame(signal, protocolInstructions, smallerTarget, 'pressure', attempt + 1)
      frames.pressure?.()
      phase = frames.phase?.() ?? phase
    }
    if (pressure || reason === 'provider') {
      // 阶段切换可能缩小模型工具的有效窗口；重投影只能缩小本次材料预算。
      inputLimit = Math.min(
        model.limits.inputTokens,
        model.limits.contextTokens - request.outputTokens - limits.safetyTokens
      )
      projected = await frames.project(
        evidence,
        signal,
        Math.min(targetChars ?? limits.projectionChars, limits.recoveryChars)
      )
      body = projected.body
      request = framedRequest(
        {
          ...request,
          compiledPrompt: projected.prompt,
          images: projected.images,
          history: projected.history,
          materials: [
            { ref: evidence.id, origin: 'runtime-view', text: body, totalChars: body.length },
          ],
        },
        `${protocolInstructions}\n${phase.instructions}${recovery}`
      )
      compiled = await this.compiler.compileModelTurn(request, model, limits.safetyTokens)
    }
    if (!compiled.okToSend) return null
    frames.setPhase(phase.phase)
    const status = {
      mode: frames.mode,
      phase: phase.phase,
      frameId: evidence.id,
      pressure:
        compiled.estimate.tokens / inputLimit > 0.9
          ? ('critical' as const)
          : compiled.estimate.tokens / inputLimit > this.policy.warningRatio
            ? ('warning' as const)
            : ('normal' as const),
      inputTokens: compiled.estimate.tokens,
      precision: compiled.estimate.precision,
      basis: compiled.estimate.basis,
      inputLimit,
      outputReserve: request.outputTokens,
      safetyReserve: limits.safetyTokens,
      remainingTokens: Math.max(0, inputLimit - compiled.estimate.tokens),
      advice:
        '原文按引用归档。工作笔记是模型解释；引用不代表已读正文。容量调整由轮边界的上下文服务处理。',
    }
    for (let count = 0; count < 3; count++) {
      compiled = await this.compiler.compileModelTurn(
        { ...request, contextStatus: status },
        model,
        limits.safetyTokens
      )
      if (compiled.estimate.tokens === status.inputTokens) break
      status.inputTokens = compiled.estimate.tokens
      status.pressure =
        status.inputTokens / inputLimit > 0.9
          ? 'critical'
          : status.inputTokens / inputLimit > this.policy.warningRatio
            ? 'warning'
            : 'normal'
      status.remainingTokens = Math.max(0, inputLimit - status.inputTokens)
    }
    if (!compiled.okToSend) return null
    if (!(await view.validate(evidence, signal)))
      throw new AppError('STALE_VIEW', '发送前证据版本发生变化')
    return {
      projection: { revision: evidence.scope.revision, cursor: 0, records: [], chars: body.length },
      ...compiled,
    }
  }
}

/** 核心循环只依赖上下文、模型与统一执行口。 */
