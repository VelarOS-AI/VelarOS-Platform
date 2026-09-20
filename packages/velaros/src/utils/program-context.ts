import { createHash } from 'node:crypto'

import type { ContextContent } from '@velaros-ai/context'
import { unifiedLineDiff } from '@velaros-ai/core/utils/textDiff'

import type { ScriptControlIdentity } from '../contract/runtime.js'
import type { ScriptSubmissionReceipt } from '../interface/provides.js'

/** 输出比较只取脚本结果，执行身份与调用日志留在原始审计记录。 */
export function programContentText(content:ContextContent|undefined, source=false):string {
  if(!content)return ''
  try {
    const data=JSON.parse(content.text)
    if(source&&typeof data.source==='string')return data.source
    if(!source)return JSON.stringify(data.result??data,null,2)
  } catch { /* 截取材料无法解析时保留原文与截断标记。 */ }
  return content.text
}

/** 差量仅说明变化，当前正文独立提供；缺少完整基线时不声称没有变化。 */
export function programContentChange(before:ContextContent|undefined,after:ContextContent|undefined,source=false):{changed:boolean;patch:string;truncated:boolean;purpose:'change-summary'} {
  const comparable=(content:ContextContent|undefined):string=>{
    const text=programContentText(content,source)
    if(source&&content)try {
      const {source:_source,...configuration}=JSON.parse(content.text)
      if(Object.keys(configuration).length)return `${text}\n// modules / input / blobs\n${JSON.stringify(configuration,null,2)}`
    }catch { /* 截断状态由下方完整性标记说明。 */ }
    return text
  }
  const a=comparable(before); const b=comparable(after)
  const incomplete=Boolean(before&&before.totalChars>before.text.length||after&&after.totalChars>after.text.length)
  const changed=incomplete?before?.record.objectId!==after?.record.objectId:a!==b
  const patch=changed?unifiedLineDiff(a,b,{from:before?.record.ref.id??'empty',to:after?.record.ref.id??'empty',editLimit:128,contextLines:2}):''
  return {changed,patch:patch.slice(0,1600),truncated:incomplete||patch.length>1600,purpose:'change-summary'}
}

/** 递归稳定键顺序，用于比较同一控制调用的输入；数组保留顺序。 */
export function stableProgramJson(value:unknown):string {
  return JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)
}

/** 宿主调用身份包含会话范围，模型调用 ID 只作为已接受响应身份的一部分。 */
export function scriptControlIdentity(sessionId:string,callId:string,operation:string,input:unknown,expectedObservation:string|null):ScriptControlIdentity {
  const hash=createHash('sha256').update(stableProgramJson([sessionId,callId])).digest('hex').slice(0,32)
  return {id:`${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20)}`,fingerprint:createHash('sha256').update(stableProgramJson({operation,input})).digest('hex'),expectedObservation}
}

/** 固定脚本提交的 JSON 参数，拒绝无法无损持久化的数据。 */
export function scriptInputCopy<T>(input:T):T {
  const seen=new Set<object>()
  const copy=(value:unknown):unknown=>{
    if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value
    if(typeof value!=='object'||seen.has(value)||!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Object.assign(new Error('脚本参数必须是无环 JSON 值'),{code:'INPUT_SCHEMA',effect:'none'})
    seen.add(value)
    const result=Array.isArray(value)?value.map(copy):Object.fromEntries(Object.entries(value).map(([key,item])=>[key,copy(item)]))
    seen.delete(value)
    return Object.freeze(result)
  }
  return copy(input) as T
}

/** 已占位但缺少完成回执的提交必须核对，任何恢复路径都不能授权重跑。 */
export function recoverScriptSubmission(receipt:ScriptSubmissionReceipt,control:ScriptControlIdentity):ScriptSubmissionReceipt {
  if(receipt.status==='prepared')throw Object.assign(new Error('原提交已占位但缺少最终回执，需要核对执行效果'),{code:'SCRIPT_UNRESOLVED',invocationId:control.id,effect:'unknown'})
  return receipt
}
