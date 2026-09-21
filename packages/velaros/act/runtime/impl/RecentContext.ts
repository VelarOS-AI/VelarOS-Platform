import type { ContextRuntime, ContextStorage } from "@velaros-ai/context";
import {Log} from '@velaros-ai/core'
import {isUndefined,toNullable} from '@velaros-ai/core'
import type { ModelHistoryMessage, ModelImage } from "@velaros-ai/kernel";

import type { HistoryCheckpoint, HistoryListRequest, HistoryPage } from "../../system/types/history.js";
import { ActRuntimeTuning } from "../utils/tuning.js";

/** 增量历史投影和有界区间整理。 */
export interface RecentContextApi {
  /** 在当前授权代次内按序号分页，返回可召回的原文引用。 */
  list(input:HistoryListRequest,signal:AbortSignal):Promise<HistoryPage>
  /** 与主运行时共用程序帧，额外生成真实有序历史。 */
  project(frame:{body:string;images:readonly ModelImage[];prompt:string},maxChars:number,signal:AbortSignal,limit?:number):Promise<{body:string;images:readonly ModelImage[];prompt:string;history:readonly ModelHistoryMessage[]}>
  /** 在已有存储登记旧历史摘要。 */
  checkpoint(input:HistoryCheckpoint,signal:AbortSignal):Promise<unknown>
}

/** 近期分区只投影已落盘响应和回执，整理不会重放脚本。 */
export class RecentContext implements RecentContextApi {
  public constructor(private readonly id:string,private readonly context:ContextRuntime,private readonly storage:ContextStorage) {}

  public async list(input:HistoryListRequest,signal:AbortSignal):Promise<HistoryPage> {
    signal.throwIfAborted()
    const {after=0,limit=32}=input
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>64||(!isUndefined(input.through)&&(!Number.isSafeInteger(input.through)||input.through<0)))throw new Error('历史目录范围无效')
    const state=await this.storage.load(this.id)
    signal.throwIfAborted()
    const resetAfter=Math.max(state?.records.findLast(record=>record.title==='search:history-reset')?.sequence??0,state?.task?.startedSequence??0)
    const through=Math.min(input.through??Infinity,state?.records.at(-1)?.sequence??0)
    const records=(state?.records??[]).filter(record=>record.sequence>Math.max(after,resetAfter)&&record.sequence<=through&&(record.kind==='assistant'||/^script:[0-9a-f-]{36}:result$/u.test(record.title)))
    const page=records.slice(0,limit)
    return {items:page.map(record=>({ref:record.ref,sequence:record.sequence,kind:record.kind==='assistant'?'assistant':'result',totalChars:record.chars})),resetAfter,through,nextAfter:records.length>limit?page.at(-1)!.sequence:null}
  }

  public async checkpoint(input:HistoryCheckpoint,signal:AbortSignal):Promise<unknown> {
    signal.throwIfAborted()
    const state=await this.storage.load(this.id)
    if(!state)throw new Error('近期记录尚未建立')
    const reset=Math.max(state.records.findLast(record=>record.title==='search:history-reset')?.sequence??0,state?.task?.startedSequence??0)
    const records=state.records.filter(record=>record.sequence>reset)
    const old=records.findLast(record=>record.title==='search:history-checkpoint')
    const previous=old?JSON.parse((await this.storage.get(this.id,old.objectId))!):{through:0}
    if(input.baseThrough!==previous.through||!Number.isSafeInteger(input.through)||input.through<=previous.through)throw Object.assign(new Error('历史检查点版本不匹配'),{code:'CONTEXT_CONFLICT'})
    const responses=records.filter(record=>record.kind==='assistant')
    const tail=responses.at(-2)?.sequence??0
    if(input.through>=tail||!records.some(record=>record.sequence===input.through&&/^script:[0-9a-f-]{36}:result$/u.test(record.title)))throw new Error('检查点必须结束于已完成结果，且保留最近两个响应')
    if(!input.summary.trim()||JSON.stringify(input).length>12000)throw new Error('检查点摘要无效或超限')
    for(const ref of input.evidence){
      if(ref.sessionId!==this.id||!records.some(record=>record.ref.id===ref.id))throw new Error('旧材料需要在当前授权范围内重新获取')
      await this.context.read(ref,{limit:1})
    }
    const body=JSON.stringify(input); const objectId=await this.storage.put(this.id,body)
    const record={ref:{sessionId:this.id,id:crypto.randomUUID()},kind:'checkpoint' as const,title:'search:history-checkpoint',objectId,chars:body.length,sources:input.evidence,sequence:state.records.length+1,createdAt:new Date().toISOString()}
    signal.throwIfAborted()
    if(!await this.storage.compareAndSwap(this.id,state.version,{...state,version:state.version+1,records:[...state.records,record]}))throw Object.assign(new Error('整理期间历史已变化，请刷新后重试'),{code:'CONTEXT_CONFLICT'})
    return {ref:record.ref,through:input.through,representation:'model-summary',executed:false}
  }

  public async project(frame:{body:string;images:readonly ModelImage[];prompt:string},maxChars:number,signal:AbortSignal,limit:number=ActRuntimeTuning.historyPage) {
    const state=await this.storage.load(this.id)
    const reset=Math.max(state?.records.findLast(record=>record.title==='search:history-reset')?.sequence??0,state?.task?.startedSequence??0)
    const latest=state?.records.findLast(record=>record.title==='search:history-checkpoint'&&record.sequence>reset)
    const checkpoint=latest?JSON.parse((await this.storage.get(this.id,latest.objectId))!) as HistoryCheckpoint:undefined
    const material=JSON.parse(frame.body)
    const history:ModelHistoryMessage[]=[]
    if(checkpoint){
      const full={origin:'model-checkpoint',ref:latest!.ref,...checkpoint}
      const content=JSON.stringify(full)
      history.push({role:'user',content:content.length<=Math.floor(maxChars/4)?content:JSON.stringify({origin:'model-checkpoint',ref:latest!.ref,through:checkpoint.through,representation:'reference',bodyIncluded:false,totalChars:latest!.chars,unresolved:checkpoint.unresolved.length,negativeAttempts:checkpoint.negativeAttempts.length,read:{module:'velaros:system',export:'memory',operation:'read',input:{ref:latest!.ref}}})})
    }
    const candidates=(state?.records??[]).filter(record=>record.sequence>Math.max(reset,checkpoint?.through??0)&&(record.kind==='assistant'||/^script:[0-9a-f-]{36}:result$/u.test(record.title)))
    const selected=[]
    for(const record of candidates){
      signal.throwIfAborted()
      if(record.kind!=='assistant'){const raw=await this.storage.get(this.id,record.objectId);if(raw){try{if(JSON.parse(raw).mode==='observe')continue}catch{Log.tag('ActRuntime').debug('RecentContext 已进入异常处理或降级分支');/* 历史文本可以不是 JSON。 */}}}
      selected.push(record)
    }
    const budget=Math.max(0,maxChars); const capacity=Math.min(limit,Math.max(0,Math.floor(budget/512))); const tail=capacity?selected.slice(-capacity):[]
    if(limit&&selected.length>tail.length)history.push({role:'user',content:JSON.stringify({origin:'runtime-history-index',omittedRecords:selected.length-tail.length,reason:'capacity',from:selected[0]!.sequence,through:selected[selected.length-tail.length-1]!.sequence,recall:{module:'velaros:system',export:'memory',operation:'list',input:{kind:'history',after:selected[0]!.sequence-1,through:selected[selected.length-tail.length-1]!.sequence,limit:ActRuntimeTuning.historyDefaultPage}}})})
    const perItem=Math.max(1,Math.floor(budget/Math.max(1,tail.length)))
    for(const record of tail){
      signal.throwIfAborted()
      const current=material.results.find((result:{ref:string})=>result.ref===record.ref.id)
      const assistant=record.kind==='assistant'
      const content=assistant?await this.context.read(record.ref,{limit:Math.min(perItem,60000)}):undefined
      const text=assistant?content!.text:current?.text??''
      const value=assistant&&content!.totalChars>perItem||current?.structuredOutput&&text.length>perItem?'':text.length<=perItem?text:text.slice(0,perItem)
      history.push({role:assistant?'assistant':'user',content:JSON.stringify({origin:assistant?'assistant-script':'runtime-execution',sequence:record.sequence,ref:record.ref,representation:value.length===record.chars?'full':value?'excerpt':'reference',bodyIncluded:Boolean(value),totalChars:record.chars,text:value,reason:value?'history-budget':'lease-expired-or-released'})})
    }
    // 可见结果正文已在对应历史位置，尾部只保留当前状态与引用，不发送第二份正文。
    if(reset){material.goals=material.goals.filter((goal:{record:{sequence:number}})=>goal.record.sequence>reset);material.results=material.results.filter((item:{ref:string})=>(state?.records.find(record=>record.ref.id===item.ref)?.sequence??0)>reset)}
    const body=JSON.stringify({...material,results:material.results.map((item:Record<string,unknown>)=>{if(!history.some(message=>{const value=JSON.parse(message.content as string);return value.origin==='runtime-execution'&&value.ref.id===item.ref&&value.bodyIncluded}))return item;const {text:_text,...rest}=item;return {...rest,bodyInHistory:true}}),historyState:{baseThrough:checkpoint?.through??0,retainedFrom:toNullable(tail[0]?.sequence),latestSequence:tail.at(-1)?.sequence??0,checkpointRef:toNullable(latest?.ref),records:tail.length}})
    return {body,images:state?.records.some(record=>record.title==='search:history-reset'&&record.sequence>(state.task?.startedSequence??0))?[]:frame.images,history,prompt:''}
  }
}
