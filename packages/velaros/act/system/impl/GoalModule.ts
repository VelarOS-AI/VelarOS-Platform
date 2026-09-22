import {readFileSync} from 'node:fs'
import type {OperationModuleDefinition} from '@velaros-ai/kernel'
import {GoalModuleId,SystemContract} from '../contract/constants.js'
import type {GoalHost} from '../contract/requires.js'
import type {GoalUpdate} from '../types/goal.js'
import {objectSchema} from '../utils/schemas.js'

/** 目标能力定义，宿主删除口不进入模型合同。 */
export interface GoalModuleApi {
 /** 根据调用身份解析会话，模型不能指定其他会话。 */
 create(host:GoalHost):OperationModuleDefinition
}
class GoalModule implements GoalModuleApi {
 public create(host:GoalHost):OperationModuleDefinition{
  const goal=objectSchema({id:{type:'string'},revision:{type:'integer'},objective:{type:'string'},status:{enum:['active','paused','complete','blocked','cancelled','removed']},reason:{type:'string'},createdAt:{type:'number'},updatedAt:{type:'number'}})
  return {binding:{moduleId:GoalModuleId,instanceId:`standard:${GoalModuleId}`,generation:SystemContract.generation,schemaRevision:SystemContract.schemaRevision},summary:'跨运行的会话目标生命周期',template:readFileSync(new URL('../goal-template.js',import.meta.url),'utf8').trim(),operations:{
   get:{summary:'读取当前会话目标和 CAS 版本；删除后返回墓碑',input:objectSchema({}),output:{anyOf:[goal,{type:'null'}]},effects:'none',run:(_input,call)=>host.programs(call.invocation.sessionId).goal.get(call.signal)},
   update:{summary:'显式建立、暂停、恢复或结束目标；先读取版本，完成或受阻需要实际依据；停止回复不会完成目标',input:objectSchema({baseRevision:{type:'integer',minimum:0},objective:{type:'string',minLength:1,maxLength:8000},status:{enum:['active','paused','complete','blocked','cancelled']},reason:{type:'string',maxLength:4000}},['baseRevision']),output:goal,effects:'write',allowedModes:['execute'],run:async(input,call)=>{
    try{return await host.programs(call.invocation.sessionId).goal.update(input as GoalUpdate,call.signal)}catch(error){if(['GOAL_INPUT','GOAL_CONFLICT','GOAL_BUSY'].includes((error as {code?:string}).code??''))call.recordEffect('none');throw error}
   }}
  }}
 }
}
/** 目标操作共享 Runtime 会话账本。 */
export const goalModule:GoalModuleApi=new GoalModule()
