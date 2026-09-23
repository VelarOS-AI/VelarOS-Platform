import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createRuntime} from '../../../dist/act/runtime/index.js'

import {done,turn} from './support/model-turn.mjs'

async function fixture(t,model){
 const dataDir=await mkdtemp(join(tmpdir(),'session-goal-'))
 const options={dataDir,agents:false,search:false,memory:false,context:{maintenance:false}}
 const runtime=await createRuntime({...options,model})
 t.after(async()=>{await runtime.close();await rm(dataDir,{recursive:true,force:true})})
 const session=await runtime.openSession('goal')
 await session.context.ingest({text:'用户明确要求推进目标'})
 return {runtime,session,options}
}

test('INV-48 goal CAS, pause, removal tombstones and restart share the same immutable session store',async t=>{
 const {runtime,session,options}=await fixture(t)
 assert.equal(await session.getGoal(),null)
 const first=await session.updateGoal({baseRevision:0,objective:'完成目标'})
 assert.equal(first.status,'active')
 await assert.rejects(session.updateGoal({baseRevision:0,status:'paused'}),{code:'GOAL_CONFLICT'})
 const race=await Promise.allSettled([session.updateGoal({baseRevision:1,status:'paused'}),session.updateGoal({baseRevision:1,status:'blocked',reason:'外部服务不可用'})])
 assert.equal(race.filter(r=>r.status==='fulfilled').length,1)
 assert.equal(race.find(r=>r.status==='rejected').reason.code,'GOAL_CONFLICT')
 let current=await session.getGoal()
 current=await session.controlGoal({baseRevision:current.revision,action:'pause'})
 current=await session.updateGoal({baseRevision:current.revision,reason:'补充进度'})
 assert.equal(current.status,'paused')
 await assert.rejects(session.updateGoal({baseRevision:current.revision,objective:'覆盖暂停目标'}),{code:'GOAL_INPUT'})
 await runtime.close()
 const reopened=await createRuntime(options)
 try{
  const next=await reopened.openSession('goal')
  assert.deepEqual(await next.getGoal(),current)
  const removed=await next.controlGoal({baseRevision:current.revision,action:'remove'})
  assert.equal(removed.status,'removed')
  await assert.rejects(next.controlGoal({baseRevision:current.revision,action:'resume'}),{code:'GOAL_CONFLICT'})
  const fresh=await next.updateGoal({baseRevision:removed.revision,objective:'新的目标'})
  assert.notEqual(fresh.id,first.id);assert.equal(fresh.revision,removed.revision+1)
  await assert.rejects(next.updateGoal({baseRevision:fresh.revision,status:'complete'}),{code:'GOAL_INPUT'})
 }finally{await reopened.close()}
 await assert.rejects(session.getGoal())
})

test('active goal prevents premature done; model operation explicitly completes the same goal',async t=>{
 const frames=[]
 const model={id:'goal-test',limits:{contextTokens:100000,inputTokens:90000,outputTokens:4096},estimate:async()=>({tokens:1000,precision:'exact'}),async *stream(request){
  frames.push(request)
  if(frames.length===2){yield turn(request,{execute:{source:`import {goal} from 'velaros:system';const current=await goal.get();if(!current)throw new Error('missing');await goal.update({baseRevision:current.revision,status:'complete',reason:'已执行测试并确认结果'});`}});yield {type:'finish',reason:'stop'}}
  else yield* done(request)
 }}
 const {session}=await fixture(t,model)
 await session.updateGoal({baseRevision:0,objective:'需要明确验收的目标'})
 const events=[];for await(const event of session.submit('继续'))events.push(event)
 assert.equal(frames.length,3,JSON.stringify(events))
 assert.equal((await session.getGoal()).status,'complete')
 const projected=JSON.parse(frames[0].materials.find(m=>m.origin==='runtime-view').text)
 assert.equal(projected.partitions.runtime.goal.objective,'需要明确验收的目标')
 assert(!events.some(e=>e.type==='error'),JSON.stringify(events))
})

test('paused goals survive normal submissions and cancellation never completes an active goal',async t=>{
 let entered;const ready=new Promise(resolve=>entered=resolve)
 const model={id:'goal-stop-test',limits:{contextTokens:100000,inputTokens:90000,outputTokens:4096},estimate:async()=>({tokens:1000,precision:'exact'}),async *stream(request,signal){
  const goal=JSON.parse(request.materials.find(m=>m.origin==='runtime-view').text).partitions.runtime.goal
  if(goal.status==='paused')yield* done(request)
  else {entered();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));signal.throwIfAborted()}
 }}
 const {session}=await fixture(t,model)
 await session.updateGoal({baseRevision:0,objective:'暂停后保留'})
 await session.controlGoal({baseRevision:1,action:'pause'})
 await Array.fromAsync(session.submit('普通问题'))
 assert.equal((await session.getGoal()).status,'paused')
 await session.controlGoal({baseRevision:2,action:'resume'})
 const running=Array.fromAsync(session.submit('继续'))
 await ready;session.cancel();await running
 assert.equal((await session.getGoal()).status,'active')
 await assert.rejects(session.execute({source:`import {goal} from 'velaros:system';await goal.update({baseRevision:3,status:'removed'});`}),/代码检查失败/)
})
