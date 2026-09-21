import type { ActEvent } from "@velaros-ai/agent";

import type { ActPresentation } from "../types/presentation.js";

/** 浏览器安全的事件投影接口，可从游标零重建。 */
export interface ActEventProjectorApi {
 /** 处理单条持久事件；重复事件幂等。 */
 apply(event:ActEvent):ActPresentation
 /** 当前不可变展示快照。 */
 snapshot():ActPresentation
}

/** 展示从事实事件派生，完整接受之前只产生可丢弃预览。 */
class ActEventProjector implements ActEventProjectorApi {
 private sessionId?:string
 private state:ActPresentation={cursor:0,runs:{}}
 public apply(record:ActEvent):ActPresentation {
  if(this.sessionId&&this.sessionId!==record.sessionId)throw new Error('事件投影不能混用会话')
  this.sessionId=record.sessionId
  if(record.sequence<=this.state.cursor)return this.snapshot()
  const event=record.event; const prior=this.state.runs[record.runId]??{status:'idle',preview:'',messages:[],errors:[]}
  let run={...prior}
  if(event.type==='turn')run={...run,turnId:event.turnId,preview:''}
  if(event.type==='text')run={...run,preview:run.preview+event.text}
  if(event.type==='accepted')run={...run,preview:'',messages:[...run.messages,{turnId:event.turnId,text:event.text,ref:event.ref}]}
  if(event.type==='rejected')run={...run,preview:'',errors:[...run.errors,event.message]}
  if(event.type==='error')run={...run,errors:[...run.errors,event.message]}
  if(event.type==='state')run={...run,status:event.status}
  this.state={cursor:record.sequence,runs:{...this.state.runs,[record.runId]:run}}
  return this.snapshot()
 }
 public snapshot():ActPresentation{return structuredClone(this.state)}
}
/** 创建单会话事件投影；原始日志仍由 ActRunService 拥有。 */
export function createActEventProjector():ActEventProjectorApi{return new ActEventProjector()}
