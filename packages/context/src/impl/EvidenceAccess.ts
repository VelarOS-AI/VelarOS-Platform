import {Log} from '@velaros-ai/core'
import { isBoolean, isString } from '@velaros-ai/core'

import type { ContextSourcePort } from '../contract/requires.js'
import type { ContextReadStamp, ContextSourceCard, ContextSourceHit,ContextSourceRead, ContextTarget, ContextTaskScope, ContextTime, ContextViewForm } from '../types/context.js'
import { contextFailure } from '../utils/state.js'
import { awaitContextOperation,contextHash } from '../utils/view.js'

/** 共用的真实来源访问器，不接收模型编造的正文。 */
export interface EvidenceAccessApi {
  /** 返回宿主装配源的真实目录。 */
  sources():readonly ContextSourceCard[]
  /** 检索并逐项授权返回候选。 */
  search(scope:ContextTaskScope,sourceId:string,query:string,limit:number,signal:AbortSignal):Promise<readonly ContextSourceHit[]>
  /** 校验指定来源的当前访问范围。 */
  authorize(scope:ContextTaskScope,target:ContextTarget,signal:AbortSignal):Promise<void>
  /** 真实读取、校验版本身份与内容指纹。 */
  read(scope:ContextTaskScope,target:ContextTarget,form:ContextViewForm,time:ContextTime,maxBytes:number,signal:AbortSignal):Promise<ContextSourceRead>
  /** 重验已保存证据的版本和权限。 */
  validate(scope:ContextTaskScope,stamp:ContextReadStamp,signal:AbortSignal):Promise<'current'|'changed'|'unknown'>
}

/** 精确视图与高级搜索共享授权、物化和真实性检查。 */
class EvidenceAccess implements EvidenceAccessApi {
  private readonly ports:ReadonlyMap<string,ContextSourcePort>
  public constructor(sources:readonly ContextSourcePort[]){this.ports=new Map(sources.map(source=>[source.id,source]));if(this.ports.size!==sources.length)throw contextFailure('SOURCE_ID','来源身份重复')}
  public sources(){return [...this.ports.values()].map(source=>({id:source.id,capabilities:source.capabilities}))}
  private source(id:string){const source=this.ports.get(id);if(!source)throw contextFailure('SOURCE_UNAVAILABLE','数据源未装配');return source}
  public async authorize(scope:ContextTaskScope,target:ContextTarget,signal:AbortSignal):Promise<void>{
    signal.throwIfAborted()
    if(target.kind!=='resource'||!await awaitContextOperation(this.source(target.sourceId).authorize(scope,target,signal),signal))throw contextFailure('DENIED','目标不在授权来源内')
  }
  public async search(scope:ContextTaskScope,sourceId:string,query:string,limit:number,signal:AbortSignal){
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw contextFailure('SOURCE_LIMIT','检索数量无效')
    const hits=await awaitContextOperation(this.source(sourceId).search(scope,query,limit,signal),signal)
    const allowed=[]
    for(const hit of hits.slice(0,limit)){
      if(hit.target.kind!=='resource'||hit.target.sourceId!==sourceId)throw contextFailure('SOURCE_CONTRACT','来源返回了其他来源的目标')
      try{await this.authorize(scope,hit.target,signal);allowed.push({...hit,preview:hit.preview.slice(0,2000)})}catch{Log.tag('ActRuntime').debug('EvidenceAccess 已进入异常处理或降级分支');signal.throwIfAborted()}
    }
    return allowed
  }
  public async read(scope:ContextTaskScope,target:ContextTarget,form:ContextViewForm,time:ContextTime,maxBytes:number,signal:AbortSignal):Promise<ContextSourceRead>{
    await this.authorize(scope,target,signal)
    if(target.kind!=='resource')throw contextFailure('SOURCE_CONTRACT','必须提供真实来源目标')
    const source=this.source(target.sourceId)
    if(time.kind==='snapshot'&&!source.capabilities.snapshot)throw contextFailure('UNSUPPORTED_TIME','来源不支持快照')
    const result=await awaitContextOperation(source.read(scope,target,form,time,maxBytes,signal),signal)
    if(!isString(result.text)||new TextEncoder().encode(result.text).byteLength>maxBytes||result.stamp.sourceId!==target.sourceId||result.stamp.resourceId!==target.resourceId||!result.mediaType.startsWith('text/'))throw contextFailure('SOURCE_CONTRACT','源返回超限、身份不一致或非文本内容')
    if(result.stamp.consistency==='revision-checkable'&&(!source.capabilities.revision||!result.stamp.revision)||result.stamp.consistency==='snapshot'&&(!source.capabilities.snapshot||!result.stamp.revision))throw contextFailure('SOURCE_CONTRACT','来源版本无效')
    if(!['full','excerpt','definition','metadata'].includes(result.form)||!['snapshot','revision-checkable','observed-only'].includes(result.stamp.consistency)||!isBoolean(result.complete)||result.stamp.contentHash!==await contextHash(result.text))throw contextFailure('SOURCE_CONTRACT','来源指纹或表示无效')
    await this.authorize(scope,target,signal)
    return result
  }
  public async validate(scope:ContextTaskScope,stamp:ContextReadStamp,signal:AbortSignal){
    await this.authorize(scope,{kind:'resource',sourceId:stamp.sourceId,resourceId:stamp.resourceId},signal)
    return awaitContextOperation(this.source(stamp.sourceId).validate(scope,stamp,signal),signal)
  }
}
/** 装配唯一的来源读取规则。 */
export function createEvidenceAccess(sources:readonly ContextSourcePort[]):EvidenceAccessApi{return new EvidenceAccess(sources)}
