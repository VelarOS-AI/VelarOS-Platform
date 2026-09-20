import { done, turn } from './support/model-turn.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'
import { createRuntime } from '../dist/src/index.js'

test('runtime exposes one script-context contract and preserves paged source retrieval',async()=>{
  const root=await mkdtemp(join(tmpdir(),'velaros-contract-')),runtime=createRuntime({storage:localContextStorage({path:join(root,'state.sqlite')}),runner:nodeSubprocessCodeRunner,modules:[]})
  try{
    const names=runtime.modules().items.map(item=>item.binding.moduleId)
    assert.deepEqual(names,['velaros:artifacts','velaros:execution','velaros:modules','velaros:programs','velaros:results'])
    assert.throws(()=>runtime.describe('velaros:script'),/未挂载模块/)
    const s=await runtime.openSession('s');assert.equal('run' in s,false);await s.context.append({kind:'user',body:'Read the saved script'})
    const source='// source to recall\n'+`import {output} from 'velaros';output(1);`,saved=await s.observe({source})
    const result=await s.execute({source:`import {programs,output} from 'velaros';output((await programs.read({ref:${JSON.stringify(saved.sourceRef)},offset:0,limit:60000})).text);`})
    assert.equal(result.result.failed,undefined);assert.match(JSON.stringify(result),/source to recall/)
  }finally{await runtime.close();await rm(root,{recursive:true,force:true})}
})

test('基础契约放不进窗口时明确阻塞；截断响应不执行程序', async () => {
  const root=await mkdtemp(join(tmpdir(),'velaros-blocked-'))
  let requests=0
  let effects=0
  const options={storage:localContextStorage({path:join(root,'blocked.sqlite')}),runner:nodeSubprocessCodeRunner,modules:[],
    model:{id:'tiny',limits:{contextTokens:100,inputTokens:100,outputTokens:10},estimate:async()=>({tokens:200,precision:'exact',basis:'测试'}),async *stream(){requests++;yield* done()}},
    limits:{turns:3,outputTokens:10,safetyTokens:10,projectionChars:1000,recoveryChars:1000,timeoutMs:10000},
  }
  const runtime=createRuntime(options)
  try{
    const session=await runtime.openSession('tiny')
    const events=[];for await(const event of session.submit('仍需保留的用户输入'))events.push(event)
    assert.equal(events.at(-1).status,'context_blocked')
    assert.equal(requests,0)
    assert.equal((await session.context.search({query:'仍需保留'})).items.length,1)
  }finally{await runtime.close()}
  const truncated=createRuntime({...options,limits:{...options.limits,projectionChars:30000,recoveryChars:6000},storage:localContextStorage({path:join(root,'truncated.sqlite')}),
    model:{...options.model,limits:{contextTokens:1000,inputTokens:1000,outputTokens:100},estimate:async()=>({tokens:1,precision:'exact',basis:'测试'}),async *stream(){yield turn({execute:{source:"import { increment } from 'example:counter'; export default await increment(1)"}});yield {type:'finish',reason:'length'}}},
    modules:[{binding:{moduleId:'example:counter',instanceId:'one',generation:1,schemaRevision:'1'},summary:'计数',operations:{increment:{summary:'增加',input:{type:'integer'},output:{type:'integer'},effects:'write',run:value=>{effects+=value;return effects}}}}],
  })
  try{const events=[];for await(const event of (await truncated.openSession('truncated')).submit('执行'))events.push(event);assert.equal(events.at(-1).status,'failed');assert.equal(effects,0)}finally{await truncated.close();await rm(root,{recursive:true,force:true})}
})
