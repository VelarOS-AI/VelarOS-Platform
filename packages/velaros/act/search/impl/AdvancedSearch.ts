import type { ContextRef, ContextStorage, ContextViewApi, EvidenceAccessApi } from "@velaros-ai/context";
import { createContextRuntime } from "@velaros-ai/context";
import {Log} from '@velaros-ai/core'
import {toNullable} from '@velaros-ai/core'
import { isEmpty, isString } from '@velaros-ai/core'
import type { OperationContext, OperationDescriptor, PreparedInvocation } from "@velaros-ai/kernel";
import type { VelarosSession } from "@velaros-ai/velaros";

import type { ModelToolRuntimeApi, ModelToolRuntimeScope } from "../../runtime/impl/ModelToolRuntime.js";
import { ActRuntimeTuning } from "../../runtime/utils/tuning.js";
import { systemModules } from '../../system/impl/SystemModules.js';
import { EvidenceModuleId, SearchLimits } from "../contract/constants.js";
import type { VelarosSearchOptions } from "../contract/requires.js";
import type { SearchProfile, SearchProfileInfo, SearchReadInput, SearchReadResult, SearchRequest, SearchResult, SearchState } from "../types.js";
import { checkSearchRequest } from "../utils/requests.js";
import { SearchTuning } from "../utils/tuning.js";

import type { SearchActivationApi } from "./SearchActivation.js";
import { SearchActivation } from "./SearchActivation.js";

/** 搜索编排复用同一会话、存储和执行器。 */
export interface AdvancedSearchApi {
  /** 等待指定父执行的搜索完成清理，错误仍走各自 Kernel 回执。 */
  settleExecution(sessionId:string,executionId:string):Promise<void>
  /** 主模型新建或恢复搜索，实际模式由 Kernel 检查。 */
  run(input:SearchRequest,call:OperationContext):Promise<SearchResult>
  /** 快照召回或重新读取已选目标，不调用模型。 */
  read(input:SearchReadInput,call:OperationContext):Promise<SearchReadResult>
  /** 搜索作用域和上下文阶段的统一能力门。 */
  authorize(invocation:PreparedInvocation,descriptor:OperationDescriptor,signal:AbortSignal):Promise<void>
  /** 按当前调用身份取得搜索活动。 */
  activation(sessionId:string):SearchActivationApi
  /** 模块发现与实际调用共享作用域。 */
  allows(sessionId:string,module:string):boolean
  /** 返回实际档位资源上限。 */
  profileInfo():readonly SearchProfileInfo[]
}

/** 搜索的装配依赖，避免创建第二套运行时。 */
export interface AdvancedSearchDependencies {
  /** 搜索与全部模型支线共用的活动权、调用队列和祖先总账。 */
  readonly tools:ModelToolRuntimeApi
  /** 同一可靠存储。 */
  readonly storage:ContextStorage
  /** 唯一真实来源访问器。 */
  readonly evidence:EvidenceAccessApi
  /** 搜索宿主配置。 */
  readonly options:VelarosSearchOptions
  /** 已知的父运行绝对截止时间。 */
  parentDeadline(id:string):Optional<number>
  /** 当前主任务视图和预算。 */
  view(id:string):ContextViewApi
  /** 使用同一个 RuntimeSession 类建立内部会话。 */
  open(id:string,activation:SearchActivationApi,profile:SearchProfile):Promise<VelarosSession>
  /** 内部会话结束后解除活动注册。 */
  close(id:string):Promise<void>
}

/** 高级搜索只装配共享会话；所有执行仍走同一 Kernel 和 ScriptAct。 */
export class AdvancedSearch implements AdvancedSearchApi {
  private readonly active=new Map<string,SearchActivationApi>()
  private readonly pending=new Map<Promise<SearchResult>,{sessionId:string;executionId:string}>()

  public constructor(private readonly dependencies:AdvancedSearchDependencies){
    const {options}=dependencies
    if(!Object.hasOwn(options.profiles,options.defaultProfile)||isEmpty(Object.keys(options.profiles)))throw new Error('搜索默认档位未登记')
    for(const profile of Object.values(options.profiles)){
      const required=[profile.modelCalls,profile.modelTokens,profile.finalizationTokens,profile.timeoutMs,profile.callTimeoutMs,profile.finalizationMs,profile.outputTokens,profile.projectionChars,profile.sourceQueries,profile.candidates,profile.reads,profile.readBytes]
      if([...required,...Object.values(profile)].some(value=>!Number.isSafeInteger(value)||value<1)||profile.modelCalls<2||profile.timeoutMs<=profile.finalizationMs+(profile.publicationMs??SearchTuning.publicationMs)||profile.finalizationTokens>=profile.modelTokens||profile.finalizationTokens<=profile.outputTokens)throw new Error('搜索预算必须有限且预留收尾容量')
    }
  }

  public allows(sessionId:string,module:string){return !this.active.has(sessionId)?module!=='velaros:evidence':(module==='velaros:evidence'||systemModules.owns(module))}

  public profileInfo():readonly SearchProfileInfo[]{return Object.entries(this.dependencies.options.profiles).map(([name,limits])=>({name,default:name===this.dependencies.options.defaultProfile,limits:structuredClone(limits)}))}

  public activation(id:string){const value=this.active.get(id);if(!value)throw Object.assign(new Error('当前不是活动搜索作用域'),{code:'SEARCH_SCOPE'});return value}

  public async authorize(invocation:PreparedInvocation,descriptor:OperationDescriptor,signal:AbortSignal):Promise<void>{
    signal.throwIfAborted()
    if(!this.active.has(invocation.sessionId))return
    const activation=this.activation(invocation.sessionId)
    const module=invocation.binding.moduleId
    const input=invocation.input as Nullable<{ref?:string|ContextRef;evidence?:ContextRef[];sources?:ContextRef[]}>
    const refs=[...(input?.ref?[isString(input.ref)?{sessionId:invocation.sessionId,id:input.ref}:input.ref]:[]),...(input?.evidence??[]),...(input?.sources??[])]
    for(const ref of refs)await activation.authorizeReference(ref,signal)
    if(!this.allows(invocation.sessionId,module))throw Object.assign(new Error('搜索作用域没有此能力'),{code:'SEARCH_CAPABILITY_DENIED'})
    // 收尾阶段只挡新的检索与读取；交付结论（report）正是收尾时要做的
    if(module===EvidenceModuleId&&invocation.operation!=='report'&&!activation.canExplore())throw Object.assign(new Error('收尾阶段禁止新的来源读取'),{code:'SEARCH_FINALIZING'})
    if(descriptor.effects==='write'&&!systemModules.owns(module))throw Object.assign(new Error('搜索作用域只允许读取外部来源'),{code:'SEARCH_CAPABILITY_DENIED'})
  }

  private async load(id:string):Promise<Optional<SearchState>>{
    const snapshot=await this.dependencies.storage.load(id); const record=snapshot?.records.findLast(item=>item.title==='search:state')
    if(!record)return undefined
    return JSON.parse((await this.dependencies.storage.get(id,record.objectId))!) as SearchState
  }

  private async saveState(state:SearchState,activation:string,signal?:AbortSignal):Promise<void>{
    const body=JSON.stringify(state); const objectId=await this.dependencies.storage.put(state.sessionId,body)
    for(let attempt=0;attempt<32;attempt++){
      signal?.throwIfAborted()
      const snapshot=await this.dependencies.storage.load(state.sessionId)
      const latest=snapshot?.records.findLast(record=>record.title==='search:state')
      if(!snapshot||!latest||JSON.parse((await this.dependencies.storage.get(state.sessionId,latest.objectId))!).activation!==activation)throw Object.assign(new Error('搜索激活已被新的状态替代'),{code:'SEARCH_STALE'})
      const record={ref:{sessionId:state.sessionId,id:crypto.randomUUID()},sequence:snapshot.records.length+1,kind:'audit' as const,title:'search:state',objectId,chars:body.length,sources:[],createdAt:new Date().toISOString()}
      if(await this.dependencies.storage.compareAndSwap(state.sessionId,snapshot.version,{...snapshot,version:snapshot.version+1,records:[...snapshot.records,record]}))return
    }
    throw Object.assign(new Error('搜索状态持续发生并发变化'),{code:'SEARCH_BUSY'})
  }

  private async savedReport(ref:ContextRef,call:OperationContext):Promise<{report:SearchResult;state:SearchState}>{
    if(ref.sessionId!==call.invocation.sessionId)throw Object.assign(new Error('搜索报告不在当前会话'),{code:'SCOPE_MISMATCH'})
    const context=createContextRuntime({sessionId:ref.sessionId,storage:this.dependencies.storage})
    const first=await this.dependencies.view(ref.sessionId).readArtifact(ref,{limit:ActRuntimeTuning.readChars})
    let text=first.text
    while(text.length<first.totalChars)text+=(await context.read(ref,{offset:text.length,limit:ActRuntimeTuning.readChars})).text
    const report=JSON.parse(text) as SearchResult
    const state=await this.load(`search:${ref.sessionId}:${report.searchId}`)
    if(!state||state.parentSessionId!==ref.sessionId)throw Object.assign(new Error('搜索检查点不存在'),{code:'CHECKPOINT_EXPIRED'})
    // 报告必须是本搜索发布的记录，不接受模型自行拼接的任意 artifact。
    const provenance=(await this.dependencies.storage.load(state.sessionId))?.records.some(record=>record.title===`search:published:${ref.id}`)
    if(!provenance)throw Object.assign(new Error('引用不是 Runtime 发布的搜索报告'),{code:'SEARCH_REF'})
    return {report,state}
  }

  public async run(input:SearchRequest,call:OperationContext):Promise<SearchResult>{
    const pending=this.perform(input,call)
    this.pending.set(pending,{sessionId:call.invocation.sessionId,executionId:call.invocation.executionId})
    try{return await pending}finally{this.pending.delete(pending)}
  }

  public async settleExecution(sessionId:string,executionId:string):Promise<void>{
    // 错误仍由原调用写入 Kernel 回执；这里保证父执行释放租约前已完成子搜索清理。
    await Promise.allSettled([...this.pending].filter(([,owner])=>owner.sessionId===sessionId&&owner.executionId===executionId).map(([pending])=>pending))
  }

  private async perform(input:SearchRequest,call:OperationContext):Promise<SearchResult>{
    call.signal.throwIfAborted()
    const previous=input.resume?await this.savedReport(input.resume,call):undefined
    if(previous&&previous.state.report?.id!==input.resume!.id)throw Object.assign(new Error(`搜索检查点已更新：${previous.state.report?.id}`),{code:'CHECKPOINT_STALE'})
    if(!previous&&!input.query?.trim())throw new Error('新搜索需要 query')
    checkSearchRequest(input)
    const profileName=input.profile??previous?.state.profile??this.dependencies.options.defaultProfile
    const profile=this.dependencies.options.profiles[profileName]
    if(!profile)throw Object.assign(new Error('搜索档位当前不可用'),{code:'SEARCH_PROFILE'})
    const sources=input.sources??previous?.state.sources??this.dependencies.evidence.sources().map(source=>source.id)
    if(sources.some(id=>!this.dependencies.evidence.sources().some(source=>source.id===id)))throw Object.assign(new Error('搜索来源当前不可用'),{code:'DENIED'})
    const parent=this.dependencies.view(call.invocation.sessionId); const task=await parent.inspect()
    if(!task)throw new Error('搜索需要父任务')
    const searchId=previous?.state.id??crypto.randomUUID(); const sessionId=`search:${call.invocation.sessionId}:${searchId}`
    const context=createContextRuntime({sessionId,storage:this.dependencies.storage})
    const activationId=call.invocation.id; const deadline=Math.min(Date.now()+profile.timeoutMs,this.dependencies.parentDeadline(call.invocation.sessionId)??Infinity)
    const preflightSignal=AbortSignal.any([call.signal,AbortSignal.timeout(Math.max(1,Math.min(profile.callTimeoutMs,deadline-Date.now())))])
    // 续查时只带仍可授权的原始材料；范围变化时旧自由历史不发送。
    let evidence=previous?.state.evidence??[]
    const accessible=[]
    for(const item of evidence){try{if(item.target.kind==='resource'&&sources.includes(item.target.sourceId)){await this.dependencies.evidence.authorize({sessionId:call.invocation.sessionId,revision:task.revision},item.target,preflightSignal);if(await this.dependencies.evidence.validate({sessionId:call.invocation.sessionId,revision:task.revision},item.stamp,preflightSignal)!=='changed')accessible.push(item)}}catch{Log.tag('ActRuntime').debug('AdvancedSearch 已进入异常处理或降级分支');preflightSignal.throwIfAborted()}}
    const narrowed=accessible.length!==evidence.length||Boolean(previous?.state.sources.some(source=>!sources.includes(source)))
    evidence=accessible
    const state:SearchState={id:searchId,parentSessionId:call.invocation.sessionId,sessionId,query:previous?.state.query??input.query!,profile:profileName,sources,evidence,candidates:narrowed?[]:previous?.state.candidates??[],queries:previous?.state.queries??[],report:previous?.state.report,activation:activationId,expiresAt:deadline}
    // 跨连接 CAS 占位，崩溃的活动在期限前不重放。
    const snapshot=await this.dependencies.storage.load(sessionId)??{version:0,records:[],workingSet:{revision:0,cursor:0,items:[]}}
    const current=await this.load(sessionId)
    if(this.active.has(sessionId)||current?.activation&&(current.expiresAt??0)>Date.now())throw Object.assign(new Error('同一搜索已有活动续查'),{code:'SEARCH_BUSY'})
    if(previous&&current?.report?.id!==input.resume!.id)throw Object.assign(new Error('搜索检查点已经变化'),{code:'CHECKPOINT_STALE'})
    const objectId=await this.dependencies.storage.put(sessionId,JSON.stringify(state))
    const claim={ref:{sessionId,id:crypto.randomUUID()},sequence:snapshot.records.length+1,kind:'audit' as const,title:'search:state',objectId,chars:JSON.stringify(state).length,sources:[],createdAt:new Date().toISOString()}
    if(!await this.dependencies.storage.compareAndSwap(sessionId,snapshot.version,{...snapshot,version:snapshot.version+1,records:[...snapshot.records,claim]}))throw Object.assign(new Error('并发搜索占位失败'),{code:'SEARCH_BUSY'})
    let reserved=false; let activity:Optional<ModelToolRuntimeScope>; let activation:Optional<SearchActivation>; let failed=false; let primary:unknown; let output:Optional<SearchResult>
    try{
      activity=await this.dependencies.tools.begin(sessionId,call.invocation.sessionId,'search',Math.max(1,deadline-Date.now()),call.signal)
      await activity.budget.reserveModel('context',profile.finalizationTokens);reserved=true
      call.signal.throwIfAborted()
      if(Date.now()>=deadline)throw Object.assign(new Error('搜索启动时已达到期限'),{code:'SEARCH_LIMIT'})
      const publishReserve=Math.min(profile.publicationMs??SearchTuning.publicationMs,Math.max(1,Math.floor((deadline-Date.now())/4)))
      const modelDeadline=deadline-publishReserve
      const signal=AbortSignal.any([activity.signal,AbortSignal.timeout(Math.max(1,modelDeadline-Date.now()))])
      let saveTail=Promise.resolve()
      activation=new SearchActivation(state,{profile:{...profile},model:this.dependencies.options.model,evidence:this.dependencies.evidence,context,storage:this.dependencies.storage,parent:activity.budget,scope:{sessionId:call.invocation.sessionId,revision:task.revision},deadline:modelDeadline,save:value=>{saveTail=saveTail.then(()=>this.saveState(value,activationId));return saveTail}})
      this.active.set(sessionId,activation)
      const session=await this.dependencies.open(sessionId,activation,profile)
      if(narrowed)await context.append({kind:'audit',title:'search:history-reset',body:JSON.stringify({reason:'authorization-changed',atSequence:(await this.dependencies.storage.load(sessionId))!.records.length})})
      let reason='partial'
      let diagnostic=''
      try{
        for await(const event of session.submit(JSON.stringify({query:state.query,continuation:toNullable(input.query),context:toNullable(input.context),anchors:input.anchors??[],priorEvidence:evidence.map(item=>({id:item.id,target:item.target,stamp:item.stamp})),instructions:'按授权来源查询，返回证据、缺口和结论。'}),signal)){
          if(event.type==='error'){diagnostic=event.message;await context.append({kind:'event',title:'search:diagnostic',body:diagnostic.slice(0,4000)})}
          if(event.type==='state'&&['completed','failed','context_blocked','cancelled','waiting'].includes(event.status))reason=event.status
        }
      }catch(error){Log.tag('ActRuntime').debug('AdvancedSearch 已进入异常处理或降级分支');reason=(error as {code?:string}).code??'model-error'}
      call.signal.throwIfAborted()
      if(reason==='cancelled')reason='time-limit'
      else if(reason==='context_blocked')reason='context-limit'
      else if(reason==='failed')reason=/回合上限|硬上限/.test(diagnostic)?'model-limit':/预算|收尾预算/.test(diagnostic)?'token-limit':'model-error'
      const publishSignal=AbortSignal.any([call.signal,AbortSignal.timeout(Math.max(1,deadline-Date.now()))])
      const result=await activation.finish(reason,publishSignal)
      const ref=await parent.putArtifact(JSON.stringify(result),[],call.signal,call.invocation.executionId)
      await context.append({kind:'audit',title:`search:published:${ref.id}`,body:JSON.stringify({ref}),sources:[]},call.signal)
      await this.saveState({...activation.snapshot(),report:ref},activationId,call.signal)
      output={...result,ref,delivery:await this.dependencies.tools.deliver(call.invocation.sessionId,sessionId,'search',ref,result.status,result.evidence.map(item=>item.ref),result.continuation==='available'?{operation:'search',input:{resume:ref}}:undefined)}
    }catch(error){Log.tag('ActRuntime').debug('AdvancedSearch 已进入异常处理或降级分支');failed=true;primary=error}
    const failures:unknown[]=[]
    try{
      if(activation)await activation.close()
      else if(reserved)await activity!.budget.releaseModel('context',profile.finalizationTokens)
    }catch(error){Log.tag('ActRuntime').debug('AdvancedSearch 已进入异常处理或降级分支');failures.push(error)}
    if(activation&&this.active.get(sessionId)===activation){
      try{await this.dependencies.close(sessionId)}catch(error){Log.tag('ActRuntime').debug('AdvancedSearch 已进入异常处理或降级分支');failures.push(error)}
      finally{if(this.active.get(sessionId)===activation)this.active.delete(sessionId)}
    }
    try{
      const latest=await this.load(sessionId)
      if(latest?.activation===activationId)await this.saveState({...latest,activation:undefined,expiresAt:undefined},activationId)
    }catch(error){Log.tag('ActRuntime').debug('AdvancedSearch 已进入异常处理或降级分支');failures.push(error)}
    try{await activity?.close()}catch(error){Log.tag('ActRuntime').debug('AdvancedSearch 已进入异常处理或降级分支');failures.push(error)}
    if(!isEmpty(failures)){
      const errors=[...(failed?[primary]:[]),...failures]
      throw Object.assign(new AggregateError(errors,`搜索收尾失败；已尝试预算、会话和执行权清理：${errors.map(error=>error instanceof Error?error.message:String(error)).join('；')}`),{code:'SEARCH_CLEANUP'})
    }
    if(failed)throw primary
    return output!
  }

  public async read(input:SearchReadInput,call:OperationContext):Promise<SearchReadResult>{
    const {report}=await this.savedReport(input.ref,call)
    const scope={sessionId:call.invocation.sessionId,revision:(await this.dependencies.view(call.invocation.sessionId).inspect())!.revision}
    for(const evidence of report.evidence)await this.dependencies.evidence.authorize(scope,evidence.target,call.signal)
    const selected=input.evidenceId?report.evidence.filter(evidence=>evidence.id===input.evidenceId):report.evidence
    if(input.evidenceId&&!selected.length)throw Object.assign(new Error('证据不属于该报告'),{code:'SEARCH_REF'})
    if(input.mode!=='current'){
      if(input.evidenceId){const evidence=selected[0]!;const context=createContextRuntime({sessionId:evidence.ref.sessionId,storage:this.dependencies.storage});return {...await context.read(evidence.ref,{offset:input.offset,limit:input.limit}),stamp:evidence.stamp,mode:'snapshot'}}
      return {...await this.dependencies.view(call.invocation.sessionId).readArtifact(input.ref,{offset:input.offset,limit:input.limit}),mode:'snapshot'}
    }
    const items:Array<Extract<SearchReadResult,{mode:'current'}>['items'][number]>=[]
    // 证据按条分页，越界按边界钳制：负偏移从头开始，页大小落在 1 到上限之间
    const offset=Math.max(0,Math.trunc(input.offset??0)); const limit=Math.min(Math.max(1,Math.trunc(input.limit??SearchTuning.refreshItems)),SearchLimits.refreshItems)
    for(const evidence of selected.slice(offset,offset+limit)){
      try{
        const validity=await this.dependencies.evidence.validate(scope,evidence.stamp,call.signal)
        if(validity!=='current'&&evidence.target.kind==='resource'&&evidence.target.selector?.kind==='lines'){items.push({id:evidence.id,ok:false,status:'STALE_SELECTOR'});continue}
        const value=await this.dependencies.evidence.read(scope,evidence.target,'excerpt',{kind:'after-step'},8000,call.signal)
        items.push({id:evidence.id,target:evidence.target,...value,ok:true,status:'current'})
      }catch(error){call.signal.throwIfAborted();items.push({id:evidence.id,ok:false,status:(error as {code?:string}).code??'SOURCE_UNAVAILABLE'})}
    }
    return {ref:input.ref,mode:'current',items,total:selected.length,modelCalled:false}
  }
}
