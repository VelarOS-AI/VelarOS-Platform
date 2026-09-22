import type {GoalControl,GoalState,GoalUpdate} from '../../system/types/goal.js'

/** 校验目标状态迁移和读取版本，再生成不共享可变数据的下一版。 */
export function goalChange(prior:Nullable<GoalState>,input:GoalUpdate|GoalControl,now:number,id:string):GoalState{
 if(!Number.isSafeInteger(input.baseRevision)||input.baseRevision<0)throw Object.assign(new Error('目标版本无效'),{code:'GOAL_INPUT'})
 if(input.baseRevision!==(prior?.revision??0))throw Object.assign(new Error('目标版本已变化，请重新读取'),{code:'GOAL_CONFLICT'})
 const controls={resume:'active',pause:'paused',complete:'complete',block:'blocked',cancel:'cancelled',remove:'removed'} as const
 const control='action' in input
 if(control&&!Object.hasOwn(controls,input.action))throw Object.assign(new Error('目标操作无效'),{code:'GOAL_INPUT'})
 const objective=control?undefined:typeof input.objective==='string'?input.objective.trim():undefined
 const reason=control?prior?.reason??'':input.reason??prior?.reason??''
 const status=control?controls[input.action]:input.status??(objective?'active':prior?.status??'active')
 if(!['active','paused','complete','blocked','cancelled',...(control?['removed']:[])].includes(status)||typeof reason!=='string'||reason.length>4000||!control&&input.objective!==undefined&&(typeof input.objective!=='string'||!objective||objective.length>8000))throw Object.assign(new Error('目标内容或状态无效'),{code:'GOAL_INPUT'})
 if(objective&&prior&&(prior.status==='active'||prior.status==='paused'))throw Object.assign(new Error('先结束当前目标，再建立新目标'),{code:'GOAL_INPUT'})
 const creating=!!objective
 if((!prior||prior.status==='removed')&&!creating)throw Object.assign(new Error('新目标需要内容和 active 状态'),{code:'GOAL_INPUT'})
 if(!creating&&prior&&['complete','cancelled'].includes(prior.status)&&status!=='removed')throw Object.assign(new Error('目标已结束，请明确建立新目标'),{code:'GOAL_INPUT'})
 if(!control&&(status==='complete'||status==='blocked')&&!input.reason?.trim())throw Object.assign(new Error('完成或受阻需要说明实际依据'),{code:'GOAL_INPUT'})
 return {id:creating?id:prior!.id,revision:input.baseRevision+1,objective:objective??prior!.objective,status,reason:creating?('reason' in input?input.reason??'':''):reason,createdAt:creating?now:prior!.createdAt,updatedAt:now}
}
