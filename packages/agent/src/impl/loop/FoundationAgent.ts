import type { ContextProjection } from '@velaros-ai/context'
import type { ModelTurnDelta, ModelTurnRequest } from '@velaros-ai/kernel'

import type { FoundationAgentOptions } from '../../contract/requires.js'
import type { CompiledFoundationRequest, FoundationRunEvent } from '../../types/foundation.js'
import { boundedModelOperation, boundedModelStream } from '../../utils/loop/model-stream.js'
import { ProviderRequestCompiler } from '../context/ProviderRequestCompiler.js'

/** 只负责模型回合、预算与执行调度的会话循环。 */
export interface FoundationAgentApi {
  /** 追加用户输入并推进一次运行；单会话只允许一条活动运行。 */
  submit(text: string, signal?: AbortSignal): AsyncIterable<FoundationRunEvent>
  /** 立即取消活动运行。 */
  cancel(): void
}

class FoundationAgent implements FoundationAgentApi {
  private controller?: AbortController
  private readonly compiler = new ProviderRequestCompiler()

  public constructor(private readonly options: FoundationAgentOptions) {
    for (const value of Object.values(options.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('运行预算必须是正整数')
    for (const value of Object.values(options.model.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('模型必须声明有效窗口限制')
  }

  public cancel(): void { this.controller?.abort() }

  public async *submit(text: string, signal?: AbortSignal): AsyncIterable<FoundationRunEvent> {
    if (this.controller) throw new Error('这个会话已有活动运行')
    const controller = new AbortController()
    this.controller = controller
    const cancel = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    const timer = setTimeout(cancel, this.options.limits.timeoutMs)
    const runId = crypto.randomUUID()
    let terminal: 'completed' | 'cancelled' | 'failed' | 'context-blocked' | undefined
    let ownsView = false
    try {
      controller.signal.throwIfAborted()
      const user = await this.options.context.append({ kind: 'user', body: text }, controller.signal)
      if (this.options.view) { await this.options.view.begin(user.ref, controller.signal); ownsView = true }
      for (let turn = 0; turn < this.options.limits.turns; turn++) {
        controller.signal.throwIfAborted()
        await this.options.action.prepare(controller.signal)
        const frame = await boundedModelOperation(this.frame(controller.signal), controller.signal)
        if (!frame) {
          await this.options.context.append({kind:'event',title:'context_blocked',body:JSON.stringify({runId})})
          terminal = 'context-blocked'
          yield {type:'state',runId,status:'context_blocked'}
          return
        }
        if (this.options.view) await this.options.view.reserveModel('main', frame.estimate.tokens + frame.request.outputTokens)
        const audit = await this.options.context.append({kind:'audit',title:'model-request',body:JSON.stringify({runId,turn,model:this.options.model.id,revision:frame.projection.revision,cursor:frame.projection.cursor,estimate:frame.estimate,providerRequest:frame.providerRequest,request:frame.request})},controller.signal)
        yield {type:'state',runId,status:'thinking'}
        let output: Extract<ModelTurnDelta,{type:'output'}> | undefined
        let finish: Extract<ModelTurnDelta,{type:'finish'}> | undefined
        let overflow = false
        let measured = false
        let responseChars = 0
        for await (const delta of boundedModelStream(this.options.model,frame.request,controller.signal)) {
          controller.signal.throwIfAborted()
          responseChars += JSON.stringify(delta).length
          if (responseChars > 512_000) throw new Error('模型响应超过协议上限')
          if (finish) throw new Error('模型在结束响应后继续发送内容')
          if (delta.type === 'error') {
            if (delta.code === 'context-limit') {overflow = true;break}
            throw new Error(delta.message)
          }
          if (delta.type === 'usage') {
            if (measured) throw new Error('模型重复返回用量')
            measured = true
            await this.options.view?.recordUsage(delta.inputTokens, delta.outputTokens)
            yield {type:'usage',runId,inputTokens:delta.inputTokens,outputTokens:delta.outputTokens}
          }
          if (delta.type === 'output') {
            if(output)throw new Error('模型每轮只能提交一份完整响应')
            output=delta
          }
          if (delta.type === 'finish') finish=delta
        }
        if (overflow) {
          terminal='context-blocked';yield {type:'state',runId,status:'context_blocked'};return
        }
        if (!finish || finish.reason!=='stop' || !output) throw new Error('模型响应未完整结束，程序没有执行')
        const decoded=this.options.action.decode(output.value)
        const accepted=await this.options.context.append({kind:'assistant',body:JSON.stringify({output:output.value,finish:finish.reason}),sources:[audit.ref]},controller.signal)
        await this.options.action.acknowledge(frame.request,controller.signal)
        if(decoded.message)yield {type:'text',runId,text:decoded.message}
        if (decoded.submission!==undefined) {
          yield {type:'state',runId,status:'executing'}
          await this.options.action.invoke(decoded.submission,controller.signal,`${audit.ref.id}:${accepted.ref.id}`)
          continue
        }
        if (this.options.view) {
          const completion = await this.options.view.complete(this.options.completionVerifier, controller.signal)
          yield { type: 'verification', runId, ...completion }
          if (!completion.completed) {
            await this.options.context.append({kind:'event',title:'completion-blocked',body:JSON.stringify(completion)},controller.signal)
            terminal = 'context-blocked'; yield {type:'state',runId,status:'context_blocked'}; return
          }
        }
        terminal = 'completed'
        yield {type:'state',runId,status:'completed'}
        return
      }
      throw new Error('运行达到回合上限，已保存当前上下文')
    } catch (error) {
      terminal = controller.signal.aborted ? 'cancelled' : (error as {code?:string}).code === 'CONTEXT_BUDGET' ? 'context-blocked' : 'failed'
      yield {type:'error',runId,message:error instanceof Error?error.message:String(error)}
      yield {type:'state',runId,status:terminal === 'context-blocked' ? 'context_blocked' : terminal}
    } finally {
      if (ownsView) await this.options.view?.end(terminal ?? 'cancelled')
      controller.abort()
      clearTimeout(timer)
      signal?.removeEventListener('abort',cancel)
      this.controller=undefined
    }
  }

  private async frame(signal:AbortSignal):Promise<({projection:ContextProjection}&CompiledFoundationRequest)|null> {
    const {model,limits,action,view}=this.options
    const evidence=await view.build({maxChars:limits.projectionChars,visibleExecutionIds:await action.visibleExecutions()},signal)
    const projected=await action.project(evidence,signal,limits.projectionChars)
    let body=projected.body
    let request:ModelTurnRequest={instructions:this.options.instructions,images:projected.images,
      materials:[{ref:evidence.id,origin:'runtime-view',text:body,totalChars:body.length}],
      response:action.response,mode:'work',outputTokens:Math.min(limits.outputTokens,model.limits.outputTokens)}
    let compiled=await this.compiler.compileModelTurn(request,model,limits.safetyTokens)
    if(!compiled.okToSend){
      const smaller=await action.project(evidence,signal,limits.recoveryChars)
      body=smaller.body
      request={...request,images:smaller.images,materials:[{ref:evidence.id,origin:'runtime-view',text:body,totalChars:body.length}]}
      compiled=await this.compiler.compileModelTurn(request,model,limits.safetyTokens)
    }
    if(!compiled.okToSend)return null
    if(!await view.validate(evidence,signal))throw Object.assign(new Error('发送前证据版本发生变化'),{code:'STALE_VIEW'})
    return {projection:{revision:evidence.scope.revision,cursor:0,records:[],chars:body.length},...compiled}
  }

}

/** 核心循环只依赖上下文、模型与统一执行口。 */
export function createFoundationAgent(options:FoundationAgentOptions):FoundationAgentApi {return new FoundationAgent(options)}
