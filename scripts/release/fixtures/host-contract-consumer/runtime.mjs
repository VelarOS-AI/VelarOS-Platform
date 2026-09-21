import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createRuntime } from '@velaros-ai/velaros'
import { createMemoryStore, memoryOperations } from '@velaros-ai/velaros/memory'

// 已发布产物要能完成真实脚本、状态持久化、模型循环、取消和重新打开。
async function probeRuntime(){
 const root=await mkdtemp(join(tmpdir(),'velaros-packed-act-'))
 const workspace=join(root,'project');await mkdir(workspace)
 let calls=0,hold=false,started
 const model={id:'packed-model',limits:{contextTokens:128000,inputTokens:110000,outputTokens:4096},estimate:async()=>({tokens:1000,precision:'estimate',basis:'fixture'}),async *stream(request){
  calls++
  if(hold){started();await new Promise(()=>{})}
  const marker=request.instructions.match(/当前帧标记：(\S+)。普通/u)[1]
  yield {type:'text',text:`packed complete\n${marker} done`};yield {type:'finish',reason:'stop'}
 }}
 const runtime=await createRuntime({workspace,dataDir:join(root,'data'),model,agents:false,search:false})
 try{
  const session=await runtime.openSession('packed')
  await session.context.append({kind:'user',body:'Probe durable state'})
  const saved=await session.execute({source:"import {output} from 'velaros';import {store} from 'velaros:system';const space=await store.create({name:'packed',description:'Published package probe'});output(await store.set({store:space.id,key:'ready',baseRevision:0,value:true}));"})
  assert.equal(saved.result.failed,undefined,JSON.stringify(saved));assert.equal(saved.result.value.default.value,true)
  const events=[];for await(const event of session.submit('Verify packaged runtime'))events.push(event)
  assert.equal(events.at(-1).status,'completed');assert.equal(calls,1)
  const trace=await runtime.trace('packed');assert.equal(trace.turns.length,1);assert(trace.turns[0].response.body.includes('packed complete'))
  hold=true
  const sending=new Promise(resolve=>{started=resolve})
  const cancelled=[]
  const running=(async()=>{for await(const event of session.submit('cancel active stream'))cancelled.push(event)})()
  await sending;session.cancel();await running
  assert.equal(cancelled.at(-1).status,'cancelled')
  await session.close()
  const reopened=await runtime.openSession('packed');assert.notEqual(reopened,session)
  assert((await runtime.trace('packed')).turns.length>=2)
 }finally{await runtime.close();await rm(root,{recursive:true,force:true})}
}

/** 记忆库照发布的包接得上：宿主给根目录，按作用域取一份，三个操作经作用域端口读写，别的作用域看不见。 */
async function probeMemoryStore() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-packed-memory-')))
  assert.ok(basename(root).startsWith('velaros-packed-memory-'))
  try {
    const store = createMemoryStore({ root })
    const scope = store.scope('project:/srv/packed')
    const context = { abortSignal: new AbortController().signal, memory: scope }
    const saved = await memoryOperations.save({
      id: 'packed-contract',
      type: 'work',
      title: '发版夹具',
      description: '打包之后的记忆库照样能读写',
      tags: ['发版'],
      content: '宿主给根目录，按作用域取一份。',
    }, context)
    assert.deepEqual(saved, { id: 'packed-contract', created: true })
    const [entry] = await memoryOperations.list(context)
    assert.equal(entry.title, '发版夹具')
    assert.deepEqual(entry.tags, ['发版'])
    assert.match(await scope.renderIndex(), /\[发版夹具\]\(packed-contract\)/u)
    assert.deepEqual(await store.scope('project:/srv/other').list(), [])
    assert.deepEqual((await store.listScopes()).map((summary) => [summary.scope, summary.count]), [['project:/srv/packed', 1]])
    assert.deepEqual(await memoryOperations.remove({ id: 'packed-contract' }, context), { removed: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await probeRuntime()
await probeMemoryStore()

console.info('✓ packed runtime contracts: Act execution, persistent stores, cancellation, reopening, trace and the memory store')
