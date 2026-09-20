import type { ContextContent, ContextRecord, ContextRef, ContextRuntime, ContextState, ContextStorage, ModelView } from '@velaros-ai/context'
import { ContextLimits } from '@velaros-ai/context'
import type { ModelImage } from '@velaros-ai/kernel'

import { type ProgramLeaseState, type ScriptControlIdentity,ScriptLeaseLimits, type ScriptProgramVersion } from '../contract/runtime.js'
import type { PreparedScript,ProgramContextApi } from '../interface/internal.js'
import type { ScriptSubmissionReceipt } from '../interface/provides.js'
import { programContentChange,programContentText } from '../utils/program-context.js'

/** 程序选择与可见租约使用原有会话审计记录，正文始终按引用召回。 */
export class ProgramContext implements ProgramContextApi {
  public constructor(private readonly sessionId:string, private readonly context:ContextRuntime, private readonly storage:ContextStorage) {}

  public async state():Promise<ProgramLeaseState> {
    return this.readState(await this.storage.load(this.sessionId))
  }

  private async readState(snapshot:ContextState|null):Promise<ProgramLeaseState> {
    const record=snapshot?.records.findLast(item=>item.kind==='audit'&&item.title==='script:lease-state')
    if(!record)return {completedTurns:0,leases:[]}
    const body=await this.storage.get(this.sessionId,record.objectId)
    if(body===null)throw new Error('程序租约记录缺失')
    return JSON.parse(body) as ProgramLeaseState
  }

  private async update(change:(state:ProgramLeaseState)=>ProgramLeaseState, additions:readonly ContextRecord[]=[], signal?:AbortSignal):Promise<void> {
    for(let attempt=0;attempt<64;attempt++){
      signal?.throwIfAborted()
      const snapshot=await this.storage.load(this.sessionId)??{version:0,records:[],workingSet:{revision:0,cursor:0,items:[]}}
      if(additions.some(item=>snapshot.records.some(old=>old.ref.id===item.ref.id)))throw Object.assign(new Error('控制调用已经提交'),{code:'SCRIPT_REPLAY'})
      const available=new Set([...snapshot.records,...additions].map(item=>item.ref.id))
      if(additions.some(item=>item.sources.some(ref=>ref.sessionId!==this.sessionId||!available.has(ref.id))))throw Object.assign(new Error('提交包含未知或跨会话来源'),{code:'SCRIPT_REF'})
      const state=change(await this.readState(snapshot))
      const record=await this.record('script:lease-state',JSON.stringify(state))
      const records=[...snapshot.records,...[...additions,record].map((item,index)=>({...item,sequence:snapshot.records.length+index+1}))]
      signal?.throwIfAborted()
      if(await this.storage.compareAndSwap(this.sessionId,snapshot.version,{...snapshot,version:snapshot.version+1,records}))return
    }
    throw Object.assign(new Error('上下文持续发生并发变化，请重新读取当前版本'),{code:'SCRIPT_BUSY'})
  }

  private async record(title:string,body:string,id:string=crypto.randomUUID(),sources:readonly ContextRef[]=[]):Promise<ContextRecord> {
    if(body.length>ContextLimits.objectChars)throw Object.assign(new Error('程序记录超过上下文对象限制'),{code:'TOO_LARGE'})
    const objectId=await this.storage.put(this.sessionId,body)
    return {ref:{sessionId:this.sessionId,id},sequence:0,kind:'audit',title,objectId,chars:body.length,sources,createdAt:new Date().toISOString()}
  }

  public async version(ref:string):Promise<ScriptProgramVersion|undefined> {
    const record=(await this.storage.load(this.sessionId))?.records.findLast(item=>item.kind==='audit'&&item.title===`script:version:${ref}`)
    if(!record)return undefined
    const body=await this.storage.get(this.sessionId,record.objectId)
    if(body===null)throw new Error('程序版本记录缺失')
    return JSON.parse(body) as ScriptProgramVersion
  }

  public async receipt(control:ScriptControlIdentity):Promise<ScriptSubmissionReceipt|undefined> {
    const record=(await this.storage.load(this.sessionId))?.records.findLast(item=>item.kind==='audit'&&item.title===`script:control:${control.id}`)
    if(!record)return undefined
    const body=await this.storage.get(this.sessionId,record.objectId)
    if(body===null)throw new Error('控制提交回执缺失')
    const saved=JSON.parse(body) as {fingerprint:string;receipt:ScriptSubmissionReceipt}
    if(saved.fingerprint!==control.fingerprint)throw Object.assign(new Error('同一调用身份不能用于另一份输入'),{code:'SCRIPT_CALL_CONFLICT'})
    return saved.receipt
  }

  public async publish(prepared:readonly PreparedScript[],control:ScriptControlIdentity,input:ScriptSubmissionReceipt,activate:boolean,visible:boolean,signal:AbortSignal):Promise<{receipt:ScriptSubmissionReceipt;claimed:boolean}> {
    const receipt=JSON.parse(JSON.stringify(input)) as ScriptSubmissionReceipt
    const prior=await this.receipt(control)
    if(prior)return {receipt:prior,claimed:false}
    const additions:ContextRecord[]=[]
    for(const {program,version} of prepared)if(program&&version){
      additions.push(await this.record(`script:${version.sourceRef}`,JSON.stringify(program),version.sourceRef))
      additions.push(await this.record(`script:version:${version.sourceRef}`,JSON.stringify(version),undefined,[{sessionId:this.sessionId,id:version.sourceRef}]))
    }
    const refs=[...new Set([receipt.observe,receipt.execute].flatMap(item=>item?[('draftRef' in item?item.draftRef:undefined)??item.sourceRef??item.parentRef].filter((ref):ref is string=>Boolean(ref)):[]))].map(id=>({sessionId:this.sessionId,id}))
    const output=visible?await this.record(`script:${control.id}:result`,JSON.stringify(receipt),undefined,refs):undefined
    if(output)additions.push(output)
    additions.push(await this.record(`script:control:${control.id}`,JSON.stringify({fingerprint:control.fingerprint,receipt}),control.id,refs))
    try{
      await this.update(state=>{
        if(activate&&(state.observation??null)!==control.expectedObservation)throw Object.assign(new Error('观察版本已经变化，请基于 currentRef 继续编辑'),{code:'SCRIPT_CONFLICT',currentRef:state.observation??null})
        return {...state,...(activate?{observation:receipt.observe!.sourceRef}:{}),...(output&&refs[0]?{leases:[...state.leases,{ref:output.ref.id,sourceRef:refs[0].id,executionId:control.id,expiresAfter:state.completedTurns+ScriptLeaseLimits.defaultTurns}]}:{})}
      },additions,signal)
    }catch(error){if((error as {code?:string}).code==='SCRIPT_REPLAY')return {receipt:(await this.receipt(control))!,claimed:false};throw error}
    return {receipt,claimed:true}
  }

  public async finish(control:ScriptControlIdentity,input:ScriptSubmissionReceipt):Promise<ScriptSubmissionReceipt> {
    const receipt=JSON.parse(JSON.stringify(input)) as ScriptSubmissionReceipt
    const prior=await this.receipt(control)
    if(!prior)throw new Error('脚本提交尚未占位')
    if(prior.status!=='prepared')return prior
    const record=await this.record(`script:control:${control.id}`,JSON.stringify({fingerprint:control.fingerprint,receipt}),`${control.id}:completed`)
    try{await this.update(state=>state,[record])}catch(error){if((error as {code?:string}).code==='SCRIPT_REPLAY')return (await this.receipt(control))!;throw error}
    return receipt
  }

  public async add(ref:ContextRef,source:ContextRef,executionId:string,turns:number):Promise<void> {
    if(!Number.isSafeInteger(turns)||turns<1||turns>ScriptLeaseLimits.maxTurns)throw new Error('结果租约超出范围')
    await this.update(state=>({...state,leases:[...state.leases.filter(item=>item.expiresAfter>state.completedTurns&&item.ref!==ref.id),{ref:ref.id,sourceRef:source.id,executionId,expiresAfter:state.completedTurns+turns}]}))
  }

  public async readProgram(ref:string,offset=0,limit:number=ScriptLeaseLimits.resultChars):Promise<ContextContent> {
    const result=await this.context.read({sessionId:this.sessionId,id:ref},{offset,limit})
    if(result.record.kind!=='audit'||!/^script:[0-9a-f-]{36}$/u.test(result.record.title))throw Object.assign(new Error('引用不是当前会话保存的脚本版本'),{code:'SCRIPT_REF'})
    return result
  }

  public async read(ref:string, offset=0, limit:number=ScriptLeaseLimits.resultChars):Promise<ContextContent> {
    const result=await this.context.read({sessionId:this.sessionId,id:ref},{offset,limit})
    if (result.record.kind!=='audit'||!/^script:[0-9a-f-]{36}:result$/u.test(result.record.title)) throw Object.assign(new Error('引用不是当前会话的执行结果'),{code:'RESULT_REF'})
    return result
  }

  public async retain(ref:string, turns:number, signal?:AbortSignal):Promise<unknown> {
    signal?.throwIfAborted()
    const content=await this.read(ref)
    const source=content.record.sources[0]
    if (!source) throw new Error('执行结果缺少源码引用')
    await this.add(content.record.ref,source,content.record.title.slice(7,-7),turns)
    return {ref,remainingTurns:turns,executed:false}
  }

  public async project(view:ModelView, observation:ContextRef|undefined, observationImages:readonly ModelImage[], signal:AbortSignal, maxChars=1_000_000):Promise<{body:string;images:readonly ModelImage[]}> {
    const state=await this.state()
    const frameId=crypto.randomUUID()
    const visible=state.leases.filter(item=>item.expiresAfter>state.completedTurns)
    const excerptChars=Math.max(1,Math.min(ScriptLeaseLimits.resultChars,Math.floor(maxChars/(visible.length+4)/2)))
    const images:ModelImage[]=[...observationImages]
    const results=[]
    for (const lease of visible) {
      signal.throwIfAborted()
      const result=await this.read(lease.ref,0,excerptChars)
      const source=await this.context.read({sessionId:this.sessionId,id:lease.sourceRef},{limit:60_000})
      const sourceText=programContentText(source,true)
      results.push({ref:lease.ref,sourceRef:lease.sourceRef,source:sourceText.slice(0,excerptChars),sourceTruncated:sourceText.length>excerptChars||source.text.length<source.totalChars,remainingTurns:lease.expiresAfter-state.completedTurns,observedAt:result.record.createdAt,text:result.text,totalChars:result.totalChars,truncated:result.text.length<result.totalChars})
      // 图像按自己的完整性限制读取，不把截取的 JSON 当完整结果解析。
      const full=await this.storage.get(this.sessionId,result.record.objectId)
      const saved=JSON.parse(full!) as {attachments?:ContextRef[]}
      for (const ref of saved.attachments??[]) {
        const record=await this.context.read(ref,{limit:1})
        const image=await this.storage.get(this.sessionId,record.record.objectId)
        if(image===null)throw new Error('结果图像缺失')
        images.push(JSON.parse(image) as ModelImage)
      }
    }
    const source=state.observation?await this.context.read({sessionId:this.sessionId,id:state.observation},{limit:60_000}):undefined
    const current=observation?await this.context.read(observation,{limit:60_000}):undefined
    const previous=state.previousObservation?await this.context.read({sessionId:this.sessionId,id:state.previousObservation},{limit:60_000}):undefined
    const oldSource=previous?.record.sources[0]?await this.context.read(previous.record.sources[0],{limit:60_000}):undefined
    const sourceText=programContentText(source,true); const resultText=programContentText(current)
    const safety=current?JSON.parse((await this.storage.get(this.sessionId,current.record.objectId))!).observationFeedback??[]:[]
    const body=JSON.stringify({
      id:view.id,scope:view.scope,goals:view.goals,capsule:view.capsule,
      mandatory:view.mandatory.filter(item=>item.effect==='unknown'||item.outcome==='unknown'||visible.some(lease=>lease.executionId===item.executionId)),
      evidence:view.evidence,gaps:view.gaps,readSet:view.readSet,
      progress:{step:view.progress.step,repeatedSteps:view.progress.repeatedSteps,stalled:view.progress.stalled,script:programContentChange(oldSource,source,true),observation:programContentChange(previous,current),evidence:view.progress.evidence},
      programFrame:{id:frameId,completedTurns:state.completedTurns},
      observation:{sourceRef:state.observation??null,source:sourceText.slice(0,excerptChars),sourceTotalChars:sourceText.length,sourceTruncated:sourceText.length>excerptChars||Boolean(source&&source.text.length<source.totalChars),resultRef:observation?.id??null,resultSourceRef:current?.record.sources[0]?.id??null,observedAt:current?.record.createdAt,text:resultText.slice(0,excerptChars),totalChars:resultText.length,truncated:resultText.length>excerptChars||Boolean(current&&current.text.length<current.totalChars),safety},
      results,
    })
    await this.update(current=>({...current,pendingFrame:frameId,pendingObservation:observation?.id}),[],signal)
    return {body,images}
  }

  public async consume(frameId:string,signal:AbortSignal):Promise<void> {
    await this.update(state=>{
      if(!state.pendingFrame)return state
      if(state.pendingFrame!==frameId)throw new Error('租约回合身份已经失效')
      const completedTurns=state.completedTurns+1
      return {...state,pendingFrame:undefined,previousObservation:state.pendingObservation,pendingObservation:undefined,completedTurns,leases:state.leases.filter(item=>item.expiresAfter>completedTurns)}
    },[],signal)
  }
}
