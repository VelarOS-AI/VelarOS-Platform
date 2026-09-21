import {Log} from '@velaros-ai/core'
import type { ModelTurnDelta } from "@velaros-ai/kernel";

import type { ModelBudgetPort } from "../types/model-budget.js";

/** 只读模型准备可立即取消；迟到结果不会进入后续发布流程。 */
export async function awaitModelPreparation<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
  let cancel!:()=>void
  const aborted=new Promise<never>((_resolve,reject)=>{
    cancel=()=>reject(signal.reason??new Error('模型准备已取消'))
    signal.addEventListener('abort',cancel,{once:true})
    if(signal.aborted)cancel()
  })
  try{return await Promise.race([pending,aborted])}
  finally{signal.removeEventListener('abort',cancel)}
}

/** 预留完成后再次检查取消，只归还确认预留但尚未派发的模型调用。 */
export async function* reservedModelStream(parent:ModelBudgetPort,tokens:number,signal:AbortSignal,dispatch:()=>AsyncIterable<ModelTurnDelta>,accounting?:Set<Promise<void>>):AsyncIterable<ModelTurnDelta> {
  signal.throwIfAborted()
  let resolve!:()=>void
  let reject!:(reason:unknown)=>void
  const settled=new Promise<void>((accept,fail)=>{resolve=accept;reject=fail})
  accounting?.add(settled)
  void settled.catch(()=>{Log.tag('ActRuntime').debug('model-budget 已进入异常处理或降级分支');})
  let reserved=false
  try{
    await parent.reserveModel('context',tokens);reserved=true
    signal.throwIfAborted()
  }catch(error){
    if(reserved)try{await parent.releaseModel('context',tokens)}catch(release){
      const failure=Object.assign(new AggregateError([error,release],'模型调用未派发，但预算归还失败'),{code:'MODEL_RESERVATION_RELEASE'})
      reject(failure);throw failure
    }
    resolve();throw error
  }
  resolve()
  // 检查到实际开始迭代之间没有 await，避免返还 Promise 后再出现取消窗口。
  yield* dispatch()
}
