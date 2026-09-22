import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {createRuntime} from '../../../dist/act/runtime/index.js'
import {done} from './support/model-turn.mjs'

async function fixture(t){
 const dataDir=await mkdtemp(join(tmpdir(),'host-notes-'));const frames=[]
 const options={dataDir,agents:false,search:false,memory:false,context:{maintenance:false}}
 const runtime=await createRuntime({...options,model:{id:'notes-test',limits:{contextTokens:100000,inputTokens:90000,outputTokens:4096},estimate:async()=>({tokens:1000,precision:'exact'}),async *stream(request){frames.push(request);yield* done(request)}}})
 t.after(async()=>{await runtime.close();await rm(dataDir,{recursive:true,force:true})})
 const session=await runtime.openSession('notes')
 return {runtime,session,options,frames}
}
async function write(session,key,body,baseRevision=0){
 const receipt=await session.execute({source:`import {memory} from 'velaros:system';await memory.update(${JSON.stringify({key,body,baseRevision})});`})
 assert.equal(receipt.checked,true,JSON.stringify(receipt));assert(receipt.calls.every(call=>call.ok))
}
async function run(session){for await(const event of session.submit('查看当前工作区'))assert.notEqual(event.type,'error')}

test('INV-47 host archive/restore uses the model note version and changes the next real request',async t=>{
 const f=await fixture(t)
 await f.session.context.ingest({text:'maintain notes'})
 await write(f.session,'plan','HOST-NOTE-CONTENT-UNIQUE')
 const original=(await f.session.listNotes()).items[0]
 assert.equal((await f.session.readNote({key:'plan',revision:1})).text,'HOST-NOTE-CONTENT-UNIQUE')
 await run(f.session)
 const notes=JSON.parse(f.frames.at(-1).materials.find(m=>m.origin==='runtime-view').text).partitions.workspace.notes
 assert(notes.some(note=>note.key==='plan'&&note.text==='HOST-NOTE-CONTENT-UNIQUE'))
 const archived=await f.session.setNoteResident({key:'plan',baseRevision:1,resident:false})
 assert.equal(archived.revision,2);assert.equal(archived.resident,false)
 assert.equal((await f.session.readNote({key:'plan',revision:2})).text,'HOST-NOTE-CONTENT-UNIQUE')
 assert.equal((await f.session.context.read(original.ref)).record.ref.id,original.ref.id)
 await assert.rejects(f.session.setNoteResident({key:'plan',baseRevision:1,resident:true}),{code:'WORKSPACE_CONFLICT'})
 await run(f.session)
 const after=JSON.parse(f.frames.at(-1).materials.find(m=>m.origin==='runtime-view').text).partitions.workspace.notes
 assert(!after.some(note=>note.key==='plan'&&note.bodyIncluded))
 await f.runtime.close()
 const runtime=await createRuntime(f.options)
 try{
  const session=await runtime.openSession('notes')
  assert.equal((await session.listNotes()).items[0].resident,false)
  await session.setNoteResident({key:'plan',baseRevision:2,resident:true})
  assert.equal((await session.listNotes()).items[0].resident,true)
 }finally{await runtime.close()}
 await assert.rejects(f.session.listNotes(),/关闭/)
})

test('host note pages are bounded, revisions conflict, and empty sessions are readable',async t=>{
 const f=await fixture(t)
 assert.deepEqual(await f.session.listNotes(),{items:[],nextAfter:null})
 await f.session.context.ingest({text:'notes'})
 await write(f.session,'a','x'.repeat(5000)+'tail')
 await write(f.session,'b','other')
 const page=await f.session.listNotes({limit:1})
 assert.equal(page.nextAfter,'a');assert.equal((await f.session.listNotes({after:page.nextAfter})).items[0].key,'b')
 assert.deepEqual((await f.session.readNote({key:'a',revision:1,offset:5000,limit:4})).text,'tail')
 await assert.rejects(f.session.readNote({key:'a',revision:1,limit:32001}),/分页/)
 await assert.rejects(f.session.readNote({key:'a',revision:2}),{code:'WORKSPACE_CONFLICT'})
 await assert.rejects(f.session.setNoteResident({key:'missing',baseRevision:0,resident:false}),{code:'MEMORY_INPUT'})
 assert.equal(f.frames.length,0)
})
