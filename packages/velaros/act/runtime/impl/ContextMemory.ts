import type { ContextContent, ContextRecord, ContextRef, ContextRuntime, ContextStorage, ContextViewApi, ModelView } from "@velaros-ai/context";
import {isFalse,isNull,isUndefined,toNullable} from '@velaros-ai/core'
import { isArray, isBoolean, isString } from '@velaros-ai/core'
import type { ModelHistoryMessage, ModelImage, OperationReadStamp } from "@velaros-ai/kernel";
import type { WorkspaceEntry, WorkspaceUpdate } from "@velaros-ai/velaros/act/system";

import type { ContextProjectionPolicy } from '../../system/types/maintenance.js'
import type {MemoryPage,MemoryQuery} from '../../system/types/memory.js'
import type {ScriptRetention} from '../../system/types/results.js'
import type { ContextMemoryPolicy, WorkspaceNote } from "../types/memory.js";
import { memoryHistory,memoryPolicy, memoryPrompt, memoryReference,noteEntry } from "../utils/context-memory.js";
import { ActRuntimeTuning } from "../utils/tuning.js";

import type { ProgramContextApi } from "./ProgramContext.js";
import type { RecentContextApi } from "./RecentContext.js";

/** 工作区和五分区帧的唯一组装端口。 */
export interface ContextMemoryApi {
  /** 当前任务的原文目录；只读取元数据。 */
  catalog(input:MemoryQuery,signal:AbortSignal):Promise<MemoryPage>
  /** 所有原文共用范围校验与既有读取器。 */
  readMaterial(ref:ContextRef|string,offset:Optional<number>,limit:Optional<number>,signal:AbortSignal):Promise<ContextContent>
  /** 调整笔记或执行结果驻留，原文不可变。 */
  retainMaterial(ref:ContextRef|string,turns:Nullable<ScriptRetention>,signal:AbortSignal):Promise<unknown>
  /** 按稳定键及版本前提追加不可变笔记版本。 */
  update(input:WorkspaceUpdate,signal:AbortSignal):Promise<WorkspaceEntry>
  /** 当前授权代次内的笔记目录，包含已移出内存的条目。 */
  list(input:{after?:string;limit?:number},signal:AbortSignal):Promise<{items:readonly WorkspaceEntry[];nextAfter:Nullable<string>}>
  /** 按原始引用召回笔记的归档内容。 */
  read(ref:ContextRef,offset:Optional<number>,limit:Optional<number>,signal:AbortSignal):Promise<ContextContent>
  /** 合并程序材料、工作区和近期记录，生成同一五分区快照。 */
  project(view:ModelView,observation:Optional<ContextRef>,images:readonly ModelImage[],signal:AbortSignal,maxChars:number):Promise<{body:string;images:readonly ModelImage[];prompt:string;history:readonly ModelHistoryMessage[]}>
  /** 只以实际接收成功的快照更新分区变化基线。 */
  acknowledge(frameId:string,signal:AbortSignal):Promise<void>
}

/** 同一可靠存储上的工作内存，分区只改变组装与驻留，不改变事实和权限。 */
export class ContextMemory implements ContextMemoryApi {
  private readonly policy:Required<ContextMemoryPolicy>

  public constructor(private readonly id:string,private readonly context:ContextRuntime,private readonly storage:ContextStorage,private readonly view:ContextViewApi,private readonly programs:ProgramContextApi,private readonly recent:RecentContextApi,policy?:ContextMemoryPolicy){this.policy=memoryPolicy(policy)}

  private async notes(signal:AbortSignal){
    const snapshot=await this.storage.load(this.id)
    signal.throwIfAborted()
    const reset=Math.max(snapshot?.records.findLast(record=>record.title==='search:history-reset')?.sequence??0,snapshot?.task?.startedSequence??0)
    const records=[...new Map((snapshot?.records??[]).filter(record=>record.sequence>reset&&record.title.startsWith('workspace:note:')).map(record=>[record.title,record])).values()]
    const notes=[]
    for(const record of records){
      signal.throwIfAborted()
      const body=await this.storage.get(this.id,record.objectId)
      if(isNull(body))throw new Error('工作笔记原文缺失')
      notes.push({record,note:JSON.parse(body) as WorkspaceNote})
    }
    return {snapshot,reset,notes}
  }

  public async update(input:WorkspaceUpdate,signal:AbortSignal):Promise<WorkspaceEntry>{
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/u.test(input.key)||!Number.isSafeInteger(input.baseRevision)||input.baseRevision<0)throw Object.assign(new Error('笔记键或版本无效'),{code:'MEMORY_INPUT'})
    if(!isUndefined(input.body)&&(!isString(input.body)||input.body.length>60000)||!isUndefined(input.title)&&(!isString(input.title)||input.title.length>200)||!isUndefined(input.resident)&&!isBoolean(input.resident)||!isUndefined(input.sources)&&(!isArray(input.sources)||input.sources.length>64))throw Object.assign(new Error('笔记内容超限或类型无效'),{code:'MEMORY_INPUT'})
    if(['body','title','sources','resident'].every(key=>!Object.hasOwn(input,key)))throw Object.assign(new Error('笔记更新为空'),{code:'MEMORY_INPUT'})
    for(let attempt=0;attempt<32;attempt++){
      const {snapshot,notes}=await this.notes(signal)
      if(!snapshot)throw new Error('会话尚未建立')
      const prior=notes.find(item=>item.note.key===input.key)
      if((prior?.note.revision??0)!==input.baseRevision)throw Object.assign(new Error('笔记版本已变化，请按当前 revision 修改'),{code:'WORKSPACE_CONFLICT',currentRevision:prior?.note.revision??0})
      if(!prior&&isUndefined(input.body))throw Object.assign(new Error('新笔记需要正文'),{code:'MEMORY_INPUT'})
      if(!prior&&notes.length>=256)throw Object.assign(new Error('工作区笔记目录已满，请复用已有键'),{code:'WORKSPACE_LIMIT'})
      const sources=input.sources??prior?.note.sources??[]
      if(sources.some(ref=>ref.sessionId!==this.id||!memoryReference(snapshot,ref)))throw Object.assign(new Error('笔记来源不在当前授权范围'),{code:'SCOPE_MISMATCH'})
      const task=await this.view.inspect()
      const stamps=sources.flatMap(ref=>task?.view?.evidence.find(item=>item.recovery.id===ref.id)?.readSet??task?.provenance?.find(item=>item.ref.id===ref.id)?.readSet??[])
      const note:WorkspaceNote={key:input.key,revision:input.baseRevision+1,title:input.title??prior?.note.title??input.key,body:input.body??prior!.note.body,sources,resident:input.resident??prior?.note.resident??true,stamps:isUndefined(input.sources)&&prior?prior.note.stamps:stamps,origin:'model-note'}
      const body=JSON.stringify(note);const objectId=await this.storage.put(this.id,body)
      const record:ContextRecord={ref:{sessionId:this.id,id:crypto.randomUUID()},sequence:snapshot.records.length+1,kind:'note',title:`workspace:note:${input.key}`,objectId,chars:body.length,sources,createdAt:new Date().toISOString()}
      signal.throwIfAborted()
      if(await this.storage.compareAndSwap(this.id,snapshot.version,{...snapshot,version:snapshot.version+1,records:[...snapshot.records,record]}))return noteEntry(note,record)
    }
    throw Object.assign(new Error('工作区持续发生并发变化'),{code:'WORKSPACE_BUSY'})
  }

  public async list(input:{after?:string;limit?:number},signal:AbortSignal){
    const limit=input.limit??ActRuntimeTuning.workspacePage
    if(!Number.isSafeInteger(limit)||limit<1||limit>64)throw new Error('笔记目录每页 1–64 条')
    const {notes}=await this.notes(signal)
    const items=notes.map(item=>noteEntry(item.note,item.record)).filter(item=>isUndefined(input.after)||item.key>input.after).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)
    const page=items.slice(0,limit)
    return {items:page,nextAfter:items.length>limit?page.at(-1)!.key:null}
  }

  public async read(ref:ContextRef,offset:Optional<number>,limit:Optional<number>,signal:AbortSignal):Promise<ContextContent>{
    const {snapshot,reset}=await this.notes(signal)
    if(ref.sessionId!==this.id||!snapshot?.records.some(record=>record.ref.id===ref.id&&record.sequence>reset&&record.title.startsWith('workspace:note:')))throw Object.assign(new Error('笔记引用不在当前授权范围'),{code:'SCOPE_MISMATCH'})
    return this.context.read(ref,{offset,limit})
  }

  public async catalog(input:MemoryQuery,signal:AbortSignal):Promise<MemoryPage>{
    const limit=input.limit??ActRuntimeTuning.workspacePage; const after=input.after??0
    if(!Number.isSafeInteger(limit)||limit<1||limit>64||!Number.isSafeInteger(after)||after<0||!isUndefined(input.through)&&(!Number.isSafeInteger(input.through)||input.through<0))throw new Error('材料目录分页无效')
    const {snapshot,reset,notes}=await this.notes(signal)
    const latest=new Map(notes.map(item=>[item.record.ref.id,item]))
    const items=[]
    for(const record of snapshot?.records??[]){
      if(record.sequence<=after||record.sequence>(input.through??Infinity)||!memoryReference(snapshot,record.ref))continue
      const kind=record.title.startsWith('workspace:note:')?'notes':(record.kind==='user'||record.sequence<=reset)?'inputs':(record.title===`script:${record.ref.id}`||record.title==='shared:script')?'programs':/^script:.*:result$/u.test(record.title)?'results':(record.kind==='note'||record.title==='model-tool:delivery')?'artifacts':record.kind==='assistant'?'history':null
      if(!kind||input.kind&&input.kind!=='all'&&kind!==input.kind&&!(input.kind==='history'&&kind==='results')||kind==='notes'&&!latest.has(record.ref.id)||input.query&&!`${record.title} ${latest.get(record.ref.id)?.note.title??''}`.toLowerCase().includes(input.query.toLowerCase()))continue
      const note=latest.get(record.ref.id)
      items.push({...record,...(note?noteEntry(note.note,record):{})})
    }
    const page=items.slice(0,limit)
    return {items:page,nextAfter:items.length>limit?page.at(-1)!.sequence:null}
  }

  public async readMaterial(value:ContextRef|string,offset:Optional<number>,limit:Optional<number>,signal:AbortSignal):Promise<ContextContent>{
    const ref=isString(value)?{sessionId:this.id,id:value}:value
    const {snapshot}=await this.notes(signal)
    const record=memoryReference(snapshot,ref)
    if(ref.sessionId!==this.id||!record)throw Object.assign(new Error('材料引用不在当前任务授权范围'),{code:'SCOPE_MISMATCH'})
    if(record.kind==='user')return this.context.readInput(ref,{offset,limit})
    if(record.title==='task:artifact')return this.view.readArtifact(ref,{offset,limit})
    return this.context.read(ref,{offset,limit})
  }

  public async retainMaterial(value:ContextRef|string,turns:Nullable<ScriptRetention>,signal:AbortSignal):Promise<unknown>{
    const ref=isString(value)?{sessionId:this.id,id:value}:value
    const {snapshot,notes}=await this.notes(signal)
    const record=memoryReference(snapshot,ref)
    if(ref.sessionId!==this.id||!record)throw Object.assign(new Error('材料引用不在当前任务授权范围'),{code:'SCOPE_MISMATCH'})
    const note=notes.find(item=>item.record.ref.id===ref.id)
    if(note)return note.note.resident===(!isNull(turns))?noteEntry(note.note,note.record):this.update({key:note.note.key,baseRevision:note.note.revision,resident:!isNull(turns)},signal)
    if(record.title.startsWith('workspace:note:'))throw Object.assign(new Error('笔记版本已变化，请使用当前引用调整驻留'),{code:'WORKSPACE_CONFLICT'})
    if(!/^script:.*:result$/u.test(record.title))throw Object.assign(new Error('只有当前笔记或执行结果具有可调整的驻留租约'),{code:'MEMORY_REFERENCE_KIND'})
    return isNull(turns)?this.programs.release(ref.id,signal):this.programs.retain(ref.id,turns,signal)
  }

  public async project(view:ModelView,observation:Optional<ContextRef>,images:readonly ModelImage[],signal:AbortSignal,requestedChars:number){
    const {snapshot,reset,notes}=await this.notes(signal)
    const policyRecord=snapshot?.records.findLast(record=>record.title==='context:projection-policy'&&record.sequence>reset)
    const attemptRecord=snapshot?.records.findLast(record=>record.title==='context-maintenance:outcome'&&record.sequence>reset)
    const outcome=attemptRecord?JSON.parse((await this.storage.get(this.id,attemptRecord.objectId))!):undefined
    const lastAttempt=outcome?{requestId:toNullable(outcome.requestId),status:outcome.status,error:outcome.error,focus:outcome.focus,changes:outcome.changes,unresolved:outcome.unresolved,preserved:outcome.preserved,report:outcome.report,ref:attemptRecord!.ref}:undefined
    const requestRecord=snapshot?.records.findLast(record=>record.title==='context-maintenance:request'&&record.sequence>reset)
    const request=requestRecord?JSON.parse((await this.storage.get(this.id,requestRecord.objectId))!):undefined
    const pending=request?.status==='scheduled'?{requestId:request.requestId,focus:request.focus,preserve:request.preserve,boundary:'next-model-request'}:undefined
    const projectionPolicy:Optional<ContextProjectionPolicy>=policyRecord?JSON.parse((await this.storage.get(this.id,policyRecord.objectId))!):undefined
    const policyActive=Boolean(projectionPolicy&&(isUndefined(projectionPolicy.expiresAfterTurn)||(await this.programs.state()).completedTurns<projectionPolicy.expiresAfterTurn))
    // 已验证的容量随任务保留；临时派生正文仍按轮过期，避免下一轮再次放大后重复整理。
    const maxChars=projectionPolicy?Math.min(requestedChars,projectionPolicy.maxChars):requestedChars
    const residents=notes.filter(item=>item.note.resident).sort((a,b)=>b.record.sequence-a.record.sequence)
    const workspaceBudget=Math.max(0,Math.floor(maxChars*this.policy.workspaceShare))
    const selected=residents.slice(0,Math.max(1,Math.min(64,Math.floor(workspaceBudget/1024))))
    let remaining=workspaceBudget
    const workspace=selected.map(({note,record})=>{
      const presentation=policyActive?projectionPolicy?.notes?.find(item=>item.ref.id===record.ref.id&&item.ref.sessionId===this.id):undefined
      const text=presentation?.summary??note.body
      const included=!isFalse(presentation?.resident)&&text.length<=remaining
      const body=included?text:''
      remaining-=body.length
      const changed=note.stamps.some(stamp=>view.readSet.some(current=>current.sourceId===stamp.sourceId&&current.resourceId===stamp.resourceId&&(current.contentHash!==stamp.contentHash||current.revision!==stamp.revision)))
      return {...noteEntry(note,record),origin:note.origin,sources:note.sources.slice(0,8),omittedSources:Math.max(0,note.sources.length-8),text:body,bodyIncluded:included,observedAt:record.createdAt,representation:included?(presentation?.summary?'summary':'full'):'reference',...(presentation?{presentationOrigin:'model-interpretation',presentationSource:record.ref}:{}),freshness:changed?'changed':'unverified',read:{module:'velaros:system',export:'memory',operation:'read',input:{ref:record.ref}}}
    })
    const recentBudget=this.policy.recentRecords?Math.floor(maxChars*this.policy.recentShare):0
    const frame=await this.programs.project(view,observation,images,signal,Math.max(1,maxChars-(workspaceBudget-remaining)-recentBudget))
    const projected=await this.recent.project(frame,recentBudget,signal,Math.min(this.policy.recentRecords,(policyActive?projectionPolicy?.recentRecords:undefined)??this.policy.recentRecords))
    const material=JSON.parse(projected.body)
    const history=projected.history
    const sentHistory=history.flatMap(message=>{if(!isString(message.content))return [];const item=JSON.parse(message.content);return item.origin==='runtime-execution'&&item.bodyIncluded?[item.ref.id]:[]})
    const resultRefs=[...sentHistory,...material.results.filter((item:{bodyIncluded:boolean;text?:string})=>item.bodyIncluded&&item.text).map((item:{ref:string})=>item.ref)]
    const deliveredRefs=new Set([...resultRefs,...(material.observation.bodyIncluded&&material.observation.resultRef?[material.observation.resultRef]:[])])
    const dependencies=(material.decision.materials as Array<{ref:string;reads:OperationReadStamp[];unverified:unknown[]}>).filter(item=>deliveredRefs.has(item.ref))
    const currentReads=dependencies.find(item=>item.ref===material.observation.resultRef)?.reads??[]
    const resourceKey=(stamp:OperationReadStamp)=>JSON.stringify([stamp.binding,stamp.resourceId])
    // 按持久结果顺序接纳更新的真实读取和写回版本，展示排序不参与；当前观察最后覆盖。
    const sequence=new Map(snapshot?.records.map(record=>[record.ref.id,record.sequence])??[])
    const historical=dependencies.filter(item=>item.ref!==material.observation.resultRef).sort((a,b)=>(sequence.get(a.ref)??0)-(sequence.get(b.ref)??0)).flatMap(item=>item.reads)
    const reads=new Map([...historical,...currentReads].map(stamp=>[resourceKey(stamp),stamp]))
    const superseded=[...historical,...currentReads].filter(stamp=>JSON.stringify(reads.get(resourceKey(stamp)))!==JSON.stringify(stamp))
    const decision={frameId:material.programFrame.id,missing:material.decision.missing,reads:[...reads.values()],unverified:dependencies.flatMap(item=>item.unverified),sources:dependencies.map(item=>item.ref),superseded}
    await this.programs.delivered(material.programFrame.id,resultRefs,signal)
    const entries=[
      ...workspace.map(item=>({key:`workspace:${item.key}`,ref:item.ref.id,bodyIncluded:item.bodyIncluded})),
      ...material.results.map((item:{ref:string})=>({key:`result:${item.ref}`,ref:item.ref,bodyIncluded:resultRefs.includes(item.ref)})),
      ...(material.observation.resultRef?[{key:'observation',ref:material.observation.resultRef,bodyIncluded:Boolean(material.observation.text)}]:[]),
    ]
    const last=snapshot?.records.findLast(record=>record.title==='context:delivered'&&record.sequence>reset)
    const previous=last?JSON.parse((await this.storage.get(this.id,last.objectId))!).entries as typeof entries:[]
    const changes={added:entries.filter(item=>!previous.some(old=>old.key===item.key)).map(item=>item.key),updated:entries.filter(item=>previous.some(old=>old.key===item.key&&old.ref!==item.ref)).map(item=>item.key),exited:previous.filter(old=>!entries.some(item=>item.key===old.key)).map(item=>item.key),referenceOnly:entries.filter(item=>!item.bodyIncluded).map(item=>item.key)}
    const partitions={
      task:{goals:material.goals},
      workspace:{capsule:snapshot?.records.some(record=>record.title==='search:history-reset'&&record.sequence>(snapshot.task?.startedSequence??0))?null:material.capsule,notes:workspace,omitted:residents.length-selected.length,recall:{module:'velaros:system',export:'memory',operation:'list',input:{kind:'notes'}}},
      observation:material.observation,
      recent:{results:material.results,history,historyState:material.historyState},
      runtime:{taskId:snapshot?.task?.id,decision,scope:material.scope,children:material.children,mandatory:material.mandatory,evidence:material.evidence,gaps:material.gaps,readSet:material.readSet,progress:material.progress,programFrame:material.programFrame,jobs:material.jobs,materialStatus:material.materialStatus},
    }
    const footprint=Object.fromEntries(Object.entries(partitions).map(([name,value])=>[name,JSON.stringify(value).length]))
    const body=JSON.stringify({schemaVersion:1,id:material.id,frameId:material.programFrame.id,partitions,memoryStatus:{unit:'utf16',footprint,changes,policy:this.policy,maintenance: projectionPolicy||lastAttempt||pending ? {origin:projectionPolicy?.origin,maxChars:projectionPolicy?.maxChars,recentRecords:projectionPolicy?.recentRecords,summary:projectionPolicy?.summary,unresolved:projectionPolicy?.unresolved,report:projectionPolicy?.report,active:policyActive,lastAttempt,pending} : undefined,advice:'按当前能力合同维护工作记忆；检查分区占用、材料变化与整理回执。引用不代表正文已读。'}})
    await this.context.append({kind:'audit',title:`context:frame:${material.programFrame.id}`,body:JSON.stringify({frameId:material.programFrame.id,entries}),sources:[]},signal)
    return {body,images:projected.images,history:memoryHistory(history,new Set(material.results.filter((item:{structuredOutput?:boolean})=>item.structuredOutput).map((item:{ref:string})=>item.ref))),prompt:memoryPrompt(body)}
  }

  public async acknowledge(frameId:string,signal:AbortSignal):Promise<void>{
    const snapshot=await this.storage.load(this.id)
    const frame=snapshot?.records.findLast(record=>record.title===`context:frame:${frameId}`)
    if(!frame)throw new Error('上下文帧尚未登记')
    const previous=snapshot?.records.findLast(record=>record.title==='context:delivered')
    if(previous&&JSON.parse((await this.storage.get(this.id,previous.objectId))!).frameId===frameId)return
    await this.context.append({kind:'audit',title:'context:delivered',body:(await this.storage.get(this.id,frame.objectId))!,sources:[frame.ref]},signal)
  }
}
