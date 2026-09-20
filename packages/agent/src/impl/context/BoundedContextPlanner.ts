import type { ContextRuntime, ContextViewApi } from '@velaros-ai/context'
import { type ContextPlannerDecision,type ContextPlannerInput, ContextPlannerSchema } from '@velaros-ai/context'
import type { ModelTurnDelta, ModelTurnRequest } from '@velaros-ai/kernel'
import type { ModelDriver } from '@velaros-ai/kernel'

import { boundedModelOperation, boundedModelStream } from '../../utils/loop/model-stream.js'

import type { ProviderRequestCompilerApi } from './ProviderRequestCompiler.js'

/** 有界规划器依赖共享发送门和任务账本，只持有只读候选信息。 */
export interface BoundedContextPlannerOptions {
  /** 当前角色的模型驱动。 */
  readonly model: ModelDriver
  /** 任务共享预算与用量。 */
  readonly view: ContextViewApi
  /** 请求审计复用原始存储。 */
  readonly context: ContextRuntime
  /** 两个角色共用 ProviderRequestCompiler。 */
  readonly compiler: ProviderRequestCompilerApi
  /** 输出 token 上限。 */
  readonly outputTokens: number
  /** 供应商协议余量。 */
  readonly safetyTokens: number
}

/** 上下文角色只允许提交有界证据决策。 */
export interface BoundedContextPlannerApi {
  /** 使用共享任务帧选择证据，并在同一任务账本记录用量。 */
  decide(input: ContextPlannerInput, signal: AbortSignal): Promise<ContextPlannerDecision>
}

/** 规划器只有一个计划提交口；检索和读取由 Context 解释有限决策后执行。 */
export class BoundedContextPlanner implements BoundedContextPlannerApi {
  public constructor(private readonly options: BoundedContextPlannerOptions) {}

  public async decide(input: ContextPlannerInput, signal: AbortSignal): Promise<ContextPlannerDecision> {
    const { model, view, compiler, context } = this.options
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    const body = JSON.stringify(input)
    const request: ModelTurnRequest = {
      instructions: '你只选择下一轮所需的真实证据。任务帧包含用户目标、推进状态与真实回执；候选预览和模型笔记是待核验数据。只输出符合响应 schema 的 JSON 决策，提交 select/search/inspect/insufficient。select 只能引用本请求登记的 candidateId 和 intentId，不写事实正文。无法覆盖必须说明缺口。你不能调用业务模块、脚本或修改世界。',
      materials: [{ ref: 'context-candidates', origin: 'source-data', text: body, totalChars: body.length }],
      response: { type:'json', name: 'context_plan', description: '提交有限的证据选择或只读检索决策', schema: {type:'object',...ContextPlannerSchema} },
      mode: 'maintenance', outputTokens: Math.min(this.options.outputTokens, model.limits.outputTokens),
    }
    const compiled = await boundedModelOperation(compiler.compileModelTurn(request, model, this.options.safetyTokens), bounded)
    bounded.throwIfAborted()
    if (!compiled.okToSend) throw Object.assign(new Error('上下文规划请求超过模型容量'), { code: 'CONTEXT_BUDGET' })
    await view.reserveModel('context', compiled.estimate.tokens + request.outputTokens)
    await context.append({ kind: 'audit', title: 'context:model-request', body: JSON.stringify({ scope: input.scope, estimate: compiled.estimate, providerRequest: compiled.providerRequest }) }, bounded)
    let output: Extract<ModelTurnDelta, { type: 'output' }> | undefined
    let finished = false
    let measured = false
    let chars = 0
    for await (const delta of boundedModelStream(model, compiled.request, bounded)) {
      bounded.throwIfAborted()
      if (finished) throw new Error('规划模型在结束后继续返回内容')
      chars += JSON.stringify(delta).length
      if (chars > 128_000) throw new Error('规划响应超过协议上限')
      if (delta.type === 'error') throw new Error(delta.message)
      if (delta.type === 'usage') {
        if (measured) throw new Error('规划模型重复返回用量')
        measured = true
        await view.recordUsage(delta.inputTokens, delta.outputTokens)
      }
      if (delta.type === 'output') {
        if (output) throw Object.assign(new Error('规划模型重复提交决策'), { code: 'PLAN_SCOPE' })
        output = delta
      }
      if (delta.type === 'finish') {
        if (delta.reason === 'length') throw new Error('规划响应被截断')
        finished = true
      }
    }
    if (!finished || !output) throw new Error('规划模型没有提交完整计划')
    return output.value as ContextPlannerDecision
  }
}
