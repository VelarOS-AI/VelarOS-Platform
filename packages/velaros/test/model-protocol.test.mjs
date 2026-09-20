import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'
import { createRuntime } from '../dist/src/index.js'
import { ProgramContext } from '../dist/src/impl/ProgramContext.js'
import { turn } from './support/model-turn.mjs'

const write={execute:{source:"import {write} from 'test:world';await write();"}}
const finish={type:'finish',reason:'stop'}
for(const [name,events] of [
  ['duplicate output',[turn(write),turn(write),finish]],
  ['output after finish',[finish,turn(write)]],
  ['no output',[finish]],
  ['no finish',[turn(write)]],
  ['truncated output',[turn(write),{type:'finish',reason:'length'}]],
  ['provider failure after output',[turn(write),{type:'error',code:'provider',message:'lost stream'}]],
  ['wrong response schema',[turn({execute:{source:123}}),finish]],
  ['missing explicit nulls',[{type:'output',value:{execute:write.execute}},finish]],
  ['unrecognized event',[{type:'call',id:'unexpected',name:'script',input:write},finish]],
  ['invalid finish reason',[turn(write),{type:'finish',reason:'tool-call'}]],
])test(`invalid ${name} cannot dispatch, accept a turn or consume a result lease`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'model-protocol-')),storage=localContextStorage({path:join(root,'state.sqlite')})
  let writes=0
  const model={id:'protocol',limits:{contextTokens:200000,inputTokens:180000,outputTokens:4000},estimate:async()=>({tokens:1000,precision:'exact',basis:'fixture'}),async *stream(){yield* events}}
  const runtime=createRuntime({storage,runner:nodeSubprocessCodeRunner,model,modules:[{binding:{moduleId:'test:world',instanceId:'one',generation:1,schemaRevision:'1'},summary:'write target',operations:{write:{summary:'count',input:{type:'null'},output:{type:'null'},effects:'write',run:()=>{writes++;return null}}}}]})
  t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true})})
  const session=await runtime.openSession('s');await session.context.append({kind:'user',body:'Keep the result and inspect.'})
  await session.execute({source:"import {output} from 'velaros';output('leased');"})
  const programs=new ProgramContext('s',session.context,storage),before=await programs.state(),recordsBefore=(await storage.load('s')).records
  const received=[];for await(const event of session.submit('Continue'))received.push(event)
  assert.equal(received.at(-1).status,'failed',JSON.stringify(received))
  assert.equal(writes,0);assert.equal(received.filter(x=>x.type==='text').length,0)
  const after=await programs.state();assert.equal(after.completedTurns,before.completedTurns);assert.deepEqual(after.leases,before.leases)
  const added=(await storage.load('s')).records.filter(x=>!recordsBefore.some(old=>old.ref.id===x.ref.id))
  assert(!added.some(x=>x.kind==='assistant'||x.title.startsWith('script:control:')))
})
