import type {ContextRecord,ContextStorage} from '@velaros-ai/context'
import type {GoalControl,GoalState,GoalUpdate} from '../../system/types/goal.js'
import {goalChange} from '../utils/goal.js'

/** 会话目标与模型、宿主共用同一原始存储。 */
export interface SessionGoalApi {
 /** 返回当前快照，包括删除墓碑。 */
 get(signal:AbortSignal):Promise<Nullable<GoalState>>
 /** CAS 更新，不能隐式覆盖另一目标。 */
 update(input:GoalUpdate,signal:AbortSignal):Promise<GoalState>
 /** 宿主专属删除及用户控制。 */
 control(input:GoalControl,signal:AbortSignal):Promise<GoalState>
}
/** 不依赖工作笔记驻留和单次任务边界的目标账本。 */
export class SessionGoal implements SessionGoalApi {
 public constructor(private readonly id:string,private readonly storage:ContextStorage){}
 private async snapshot(signal:AbortSignal){
  signal.throwIfAborted()
  const selected=this.storage.selectSnapshot?await this.storage.selectSnapshot(this.id,[{title:'session:goal',latest:true}]):undefined
  const state=this.storage.selectSnapshot?(selected?{...selected.metadata,records:selected.records}:null):await this.storage.load(this.id)
  const record=state?.records.findLast(item=>item.title==='session:goal')
  const body=record?await this.storage.get(this.id,record.objectId):null
  signal.throwIfAborted()
  if(record&&body===null)throw new Error('目标原文缺失')
  return {state,goal:body===null?null:JSON.parse(body) as GoalState}
 }
 public async get(signal:AbortSignal){return (await this.snapshot(signal)).goal}
 public update(input:GoalUpdate,signal:AbortSignal){return this.commit(input,signal)}
 public control(input:GoalControl,signal:AbortSignal){return this.commit(input,signal)}
 private async commit(input:GoalUpdate|GoalControl,signal:AbortSignal):Promise<GoalState>{
  for(let attempt=0;attempt<32;attempt++){
   const {state,goal}=await this.snapshot(signal)
   if(!state)throw Object.assign(new Error('先登记用户输入，再建立目标'),{code:'GOAL_INPUT'})
   const next=goalChange(goal,input,Date.now(),crypto.randomUUID())
   const body=JSON.stringify(next);const objectId=await this.storage.put(this.id,body)
   const record:ContextRecord={ref:{sessionId:this.id,id:crypto.randomUUID()},sequence:(state.records.at(-1)?.sequence??0)+1,kind:'audit',title:'session:goal',objectId,chars:body.length,sources:[],createdAt:new Date(next.updatedAt).toISOString()}
   signal.throwIfAborted()
   if(this.storage.selectSnapshot&&this.storage.compareAndSwapMetadata){
    const {records:_records,...metadata}=state
    if(await this.storage.compareAndSwapMetadata(this.id,state.version,{...metadata,version:state.version+1},[record]))return next
   }else{
    // 仅支持完整 CAS 的适配器必须携带完整历史，不能使用索引快照覆盖。
    const full=this.storage.selectSnapshot?await this.storage.load(this.id):state
    if(!full||full.version!==state.version)continue
    if(await this.storage.compareAndSwap(this.id,full.version,{...full,version:full.version+1,records:[...full.records,{...record,sequence:(full.records.at(-1)?.sequence??0)+1}]}))return next
   }
  }
  throw Object.assign(new Error('目标正在变化，请重新读取后重试'),{code:'GOAL_BUSY'})
 }
}
