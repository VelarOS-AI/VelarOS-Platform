import {isArray,isNumber,isPlainObject,isString,optionalWhen,toNullable} from '@velaros-ai/core'
import type {InvocationRecord} from '@velaros-ai/kernel'

import type {ActInvocationSummary,ActRequestSummary} from '../types/trace.js'

/** 从权威回执生成有界展示，不解析被裁剪的 JSON，也不推断未结算效果。 */
export function summarizeInvocation(record:InvocationRecord,maxChars:number):ActInvocationSummary {
 const input=JSON.stringify(record.prepared.input)??''
 const output=record.receipt?JSON.stringify(record.receipt.error??record.receipt.value)??'':''
 const inputLimit=Math.min(2000,Math.floor(maxChars/2))
 const inputText=input.slice(0,inputLimit)
 const outputText=output.slice(0,Math.min(6000,maxChars-inputText.length))
 return {moduleId:record.prepared.binding.moduleId,operation:record.prepared.operation,status:record.receipt?.outcome??'pending',effect:record.receipt?.effect??'unknown',input:inputText,output:outputText,inputTruncated:inputText.length<input.length,outputTruncated:outputText.length<output.length}
}

/** 从完整封存请求提取展示，正文计入调用方预算；二进制不进入宿主展示缓存。 */
export function summarizeModelRequest(audit:unknown,maxChars:number):Nullable<ActRequestSummary> {
 if(!isPlainObject(audit)||!isPlainObject(audit.providerRequest))return null
 const request=audit.providerRequest
 if(request.schemaVersion!==2||!isString(request.model)||!isString(request.system)||!isArray(request.messages)||!isNumber(request.outputTokens)||!Number.isSafeInteger(request.outputTokens)||request.outputTokens<1||!isPlainObject(request.requestFingerprint)||!isString(request.requestFingerprint.id))return null
 let mediaOmitted=false
 const messages=JSON.stringify(request.messages,(_key,value)=>{
  if(isPlainObject(value)&&(value.type==='image'||value.$velarosType==='bytes')){
   mediaOmitted=true
   return {type:'media-omitted',mediaType:optionalWhen(isString,value.mediaType)}
  }
  return value
 },2)
 const system=request.system.slice(0,Math.min(8000,Math.floor(maxChars/4)))
 const text=messages.slice(0,Math.min(24000,maxChars-system.length))
 const value=audit.estimate
 const estimate:{tokens:number;precision:'exact'|'estimate';basis:Nullable<string>}|undefined=isPlainObject(value)&&isNumber(value.tokens)&&Number.isSafeInteger(value.tokens)&&value.tokens>=0&&(value.precision==='exact'||value.precision==='estimate')?{tokens:value.tokens,precision:value.precision,basis:isString(value.basis)?value.basis:null}:undefined
 return {model:request.model,fingerprint:request.requestFingerprint.id,inputTokens:toNullable(estimate?.tokens),precision:toNullable(estimate?.precision),basis:isString(estimate?.basis)?estimate.basis:null,outputTokens:request.outputTokens,system,messages:text,systemTruncated:system.length<request.system.length,messagesTruncated:text.length<messages.length,mediaOmitted}
}
