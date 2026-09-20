import { jsonSchema, Output, streamText } from 'ai'

import { modelRequestEncoder } from '@velaros-ai/kernel'

import type { AiSdkDriverOptions, ModelDriver } from '../../contract/requires.js'
import type { ModelDriverLimits, ModelInputEstimate, ModelTurnDelta, ModelTurnRequest } from '../../types/driver.js'

class AiSdkModelDriver implements ModelDriver {
  public readonly id:string
  public readonly limits:ModelDriverLimits

  public constructor(private readonly options:AiSdkDriverOptions) {
    this.id=options.id
    this.limits=Object.freeze({...options.limits})
  }

  public async estimate(request:ModelTurnRequest):Promise<ModelInputEstimate> {
    const encoded=JSON.stringify({system:request.instructions,messages:modelRequestEncoder.messages(request),responseFormat:modelRequestEncoder.response(request)})
    return {tokens:new TextEncoder().encode(encoded).byteLength,precision:'estimate',basis:'实际发送的文本、图像与响应契约按 UTF-8 字节保守估算；协议误差使用 Agent 的独立余量，非精确 token 计数'}
  }

  public async *stream(request:ModelTurnRequest,signal:AbortSignal):AsyncIterable<ModelTurnDelta> {
    try {
      const format=modelRequestEncoder.response(request)
      const result=streamText({
        model:this.options.model,
        system:request.instructions,
        messages:modelRequestEncoder.messages(request),
        maxOutputTokens:request.outputTokens,
        maxRetries:0,
        // 完整 JSON Schema 允许可选字段和动态 input；本地校验是接收门。
        providerOptions:{openai:{strictJsonSchema:false}},
        abortSignal:signal,
        output:Output.object({name:format.name,description:format.description,schema:jsonSchema(format.schema,{validate:async value=>{
          try {return {success:true,value:modelRequestEncoder.output(format,value)}}
          catch(error){return {success:false,error:error instanceof Error?error:new Error(String(error))}}
        }})}),
      })
      let finish:Extract<ModelTurnDelta,{type:'finish'}>|undefined
      let chars=0
      for await(const part of result.fullStream){
        signal.throwIfAborted()
        if(finish)throw new Error('供应商在结束响应后继续发送内容')
        if(part.type==='text-delta'){
          chars+=part.text.length
          if(chars>512_000)throw new Error('模型响应超过协议上限')
        }
        if(part.type==='tool-call'||part.type==='tool-input-start')throw new Error('供应商返回了本请求未声明的工具调用')
        if(part.type==='error')throw part.error
        if(part.type==='abort')throw new Error('供应商响应已中止')
        if(part.type==='finish'){
          if(part.totalUsage.inputTokens!==undefined&&part.totalUsage.outputTokens!==undefined)yield {type:'usage',inputTokens:part.totalUsage.inputTokens,outputTokens:part.totalUsage.outputTokens}
          if(!['stop','length'].includes(part.finishReason))throw new Error(`供应商响应未成功结束：${part.finishReason}`)
          finish={type:'finish',reason:part.finishReason==='length'?'length':'stop'}
        }
      }
      signal.throwIfAborted()
      if(!finish)throw new Error('供应商没有返回完整结束标记')
      if(finish.reason==='stop'){
        const value=await result.output
        signal.throwIfAborted()
        yield {type:'output',value}
      }
      yield finish
    } catch(error) {
      signal.throwIfAborted()
      const message=error instanceof Error?error.message:String(error)
      yield {type:'error',code:/context.{0,30}(?:length|window|limit)|maximum.{0,20}tokens|too many tokens/iu.test(message)?'context-limit':'provider',message}
    }
  }
}

/** 把已有供应商模型接到结构化回合协议；部分响应始终不进入执行链。 */
export function createAiSdkModelDriver(options:AiSdkDriverOptions):ModelDriver {return new AiSdkModelDriver(options)}
