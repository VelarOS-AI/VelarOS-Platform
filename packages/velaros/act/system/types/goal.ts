/** 目标跨执行保留；removed 是宿主删除后的墓碑。 */
export type GoalStatus='active'|'paused'|'complete'|'blocked'|'cancelled'|'removed'
/** 当前会话的目标快照，版本同时覆盖目标替换与状态变化。 */
export interface GoalState {
 /** 生命周期身份；新目标使用新身份。 */
 readonly id:string
 /** CAS 版本，删除后也不归零。 */
 readonly revision:number
 /** 用户要完成的事项。 */
 readonly objective:string
 /** 与单轮执行结算独立的状态。 */
 readonly status:GoalStatus
 /** 完成依据、阻碍或最近进度。 */
 readonly reason:string
 /** 生命周期建立时间。 */
 readonly createdAt:number
 /** 最近更新的时间。 */
 readonly updatedAt:number
}
/** 模型和宿主共用的版本化更新；模型不能删除目标。 */
export interface GoalUpdate {
 /** 必须先读取的当前版本；不存在时为零。 */
 readonly baseRevision:number
 /** 新建或替换终态目标时提供，活动目标不能被覆盖。 */
 readonly objective?:string
 /** 明确的目标状态；结束回复不会自动修改它。 */
 readonly status?:Exclude<GoalStatus,'removed'>
 /** 更新依据，完成或受阻时必须提供。 */
 readonly reason?:string
}
/** 宿主专属生命周期控制。 */
export interface GoalControl {
 /** 用户操作所针对的目标版本。 */
 readonly baseRevision:number
 /** 删除只产生墓碑，保留审计历史。 */
 readonly action:'resume'|'pause'|'complete'|'block'|'cancel'|'remove'
}
