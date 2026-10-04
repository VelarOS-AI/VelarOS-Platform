import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createRuntime } from '@velaros-ai/velaros'
import { createMemoryStore, memoryOperations } from '@velaros-ai/velaros/memory'
import { createProjectKernel, createProjectCodeQuery, createExternalLanguageService, languageQueries, typeScriptProjects } from '@velaros-ai/velaros/project'

// 已发布产物要能完成真实脚本、状态持久化、模型循环、取消和重新打开。
async function probeRuntime(){
 const root=await mkdtemp(join(tmpdir(),'velaros-packed-act-'))
 const workspace=join(root,'project');await mkdir(workspace)
 let calls=0,hold=false,started
 const model={id:'packed-model',limits:{contextTokens:128000,inputTokens:110000,outputTokens:4096},estimate:async()=>({tokens:1000,precision:'estimate',basis:'fixture'}),async *stream(request){
  calls++
  if(hold){started();await new Promise(()=>{})}
  const marker=request.compiledPrompt.match(/当前帧标记：(@@\w+)。/u)[1]
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
    assert.equal(typeof saved.revision, 'string')
    assert.ok(saved.revision.length > 0)
    assert.deepEqual(saved, { id: 'packed-contract', created: true, revision: saved.revision })
    const [entry] = await memoryOperations.list(context)
    assert.equal(entry.title, '发版夹具')
    assert.equal(entry.revision, saved.revision)
    assert.deepEqual(entry.tags, ['发版'])
    assert.match(await scope.renderIndex(), /\[发版夹具\]\(packed-contract\)/u)
    assert.deepEqual(await store.scope('project:/srv/other').list(), [])
    assert.deepEqual((await store.listScopes()).map((summary) => [summary.scope, summary.count]), [['project:/srv/packed', 1]])
    const changed = await memoryOperations.save({
      id: entry.id, type: entry.type, title: entry.title, description: entry.description,
      tags: entry.tags, content: '已按原版本更新。', expectedRevision: saved.revision,
    }, context)
    assert.equal(changed.created, false)
    assert.notEqual(changed.revision, saved.revision)
    await assert.rejects(memoryOperations.remove({ id: 'packed-contract', expectedRevision: saved.revision }, context), { code: 'CONFLICT' })
    assert.equal((await memoryOperations.list(context))[0].revision, changed.revision)
    assert.equal((await memoryOperations.list(context))[0].content, '已按原版本更新。')
    assert.deepEqual(await memoryOperations.remove({ id: 'packed-contract', expectedRevision: changed.revision }, context), { removed: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await probeRuntime()
await probeMemoryStore()

console.info('✓ packed runtime contracts: Act execution, persistent stores, cancellation, reopening, trace and the memory store')

/** 项目入口随包交付语言查询、诊断、项目池和外部服务，而不依赖源仓库的 development 包。 */
async function probeProjectLanguage() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-packed-language-')))
  const external = createExternalLanguageService(root, [])
  try {
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' } }))
    await writeFile(join(root, 'broken.ts'), "export const count: number = 'broken'\n")
    await writeFile(join(root, 'module.py'), 'def packed_function():\n    return 1\n')
    const kernel = await createProjectKernel({ root, plugins: [] })
    const context = { abortSignal: new AbortController().signal, project: { getRootPath: () => root, kernel: async () => kernel } }
    const query = createProjectCodeQuery({ isAvailable: () => false, query: async () => assert.fail('Unavailable graph must not run') })
    const result = await query({ action: 'language_diagnostics', path: 'broken.ts' }, context)
    assert.equal(result.source, 'language-service')
    assert.ok(result.diagnostics.some(item => item.code === 2322))
    const symbols = await languageQueries.run({ action: 'find_symbols', query: 'packed_function', language: 'python', exact: true }, context)
    assert.equal(symbols.symbolCount, 1)
    await assert.rejects(query({ action: 'explore', nodeIds: ['missing'] }, context), { code: 'UNAVAILABLE' })
    assert.equal(external.supports('module.py'), false)
  } finally {
    typeScriptProjects.release(root)
    await external.stop()
    await rm(root, { recursive: true, force: true })
  }
}
await probeProjectLanguage()
console.info('✓ packed project language: TypeScript diagnostics, Python syntax, graph fallback and public factories')
