
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ScriptTurnDecoder } from '../../../dist/act/runtime/impl/ScriptTurnDecoder.js'

const marker='@@s12345678'
const block=(header,body='')=>`${marker} ${header}\n${body}${body?'\n':''}${marker}\n`
const decode=(text,options={},inputs={})=>{const d=new ScriptTurnDecoder(marker,options,inputs);d.push(text);return d.finish()}
const source="import {output} from 'velaros';output(1);"
const raw='const message = `Hello, ${name}`;\n```js\n"quote" \\ backslash\n```\n'
const text=`Before\n\`\`\`js\nexecute()\n\`\`\`\n${block('blobs("payload")',raw)}${block('observe',source)}${block('execute({async:true, retain:1, input:{x:[1,true,null]}})',source)}After\n${marker} done()\nFinished.`

test('INV-12 every stream split preserves Markdown, opaque payload and program preview exactly',()=>{
 const expected=decode(text)
 assert.equal(expected.done,true);assert.equal(expected.submission.executions[0].program.blobs.payload,raw)
 assert.equal(expected.submission.executions[0].async,true)
 for(let at=0;at<=text.length;at++){
   const d=new ScriptTurnDecoder(marker);const events=[...d.push(text.slice(0,at)),...d.push(text.slice(at))];const result=d.finish();events.push(...result.events)
   assert.deepEqual({...result,events:[]},{...expected,events:[]},`split ${at}`)
   assert.equal(events.filter(e=>e.type==='text').map(e=>e.text).join(''),expected.message)
   assert.equal(events.filter(e=>e.type==='program'&&e.index===0&&e.phase==='delta').map(e=>e.text).join(''),raw)
 }
 const d=new ScriptTurnDecoder(marker);for(const char of text)d.push(char);assert.equal(d.finish().submission.executions.length,1)
})

test('CRLF, no final newline, blank payload and marker-like lines are unambiguous',()=>{
 const result=decode(`${marker} blobs('empty')\r\n${marker}\r\n${marker} execute\r\n${source}\r\n${marker}\r\n${marker} done`)
 assert.equal(result.submission.executions[0].program.blobs.empty,'');assert.equal(result.submission.executions[0].program.source,source)
 assert.equal(decode('@@s12345678x execute()\ntext').submission,undefined)
 assert.equal(decode(`${block('execute',source)}${marker} done\nmore text`).message,'more text')
})

test('configuration, reference edits, full bundles and immutable host parameters use one decoder',()=>{
 const inputs={target:{path:'original'}};const d=new ScriptTurnDecoder(marker,{names:{execute:'run',done:'finish'}},inputs)
 inputs.target.path='changed';d.push(`${block('run({inputRef:"host:target"})',source)}${marker} finish`)
 assert.equal(d.finish().submission.executions[0].program.input.path,'original')
 assert.deepEqual(decode(block('observe({edits:[{oldText:"a",newText:"b"}]})')).submission.observe.edits,[{oldText:'a',newText:'b'}])
 assert.equal(decode(block('observe({clear:true})')).submission.observe,null)
 const program={source,modules:{'./data.js':'export const a=1'},input:{a:1},blobs:{inline:'text'}}
 assert.deepEqual(decode(block('execute({format:"program"})',JSON.stringify(program))).submission.executions[0].program,program)
})

for(const [name,input] of [
 ['unclosed',`${marker} execute\n${source}`],['nested',`${marker} blobs('x')\n${block('execute',source)}`],
 ['unknown',block('unknown',source)],['expression',block('execute({input: process.exit()})',source)],
 ['spread',block('execute({...x})',source)],['getter',block('execute({get x(){return 1}})',source)],
 ['duplicate argument',block('execute({retain:1,retain:2})',source)],['duplicate blob',block('blobs("x")','1')+block('blobs("x")','2')],
 ['done with arguments',`${marker} done(1)`],['done twice',`${marker} done\n${marker} done()`],
 ['control after done',`${marker} done\n${block('execute',source)}`],['two observers',block('observe',source)+block('observe',source)],
 ['async observer',block('observe({async:false})',source)],['bad lease',block('execute({retain:0})',source)],
 ['parameter collision',block('execute({input:1,inputRef:"host:p"})',source)],['unexpected field',block('execute({bogus:true})',source)],
 ['clear with content',block('observe({clear:true})',source)],['missing blob name',block('blobs','x')],['extra expression',block('execute(); done()',source)],
])test(`rejects ${name} before a submission exists`,()=>assert.throws(()=>decode(input),{code:'SCRIPT_PROTOCOL'}))

test('response, header, block budgets and decoder reset are bounded',()=>{
 assert.throws(()=>decode(text,{maxChars:5}),/预算/)
 assert.throws(()=>decode(block('execute({input:"long"})',source),{maxHeaderChars:20}),/预算/)
 assert.throws(()=>decode(block('execute',source)+block('execute',source),{maxBlocks:1}),/数量/)
 const d=new ScriptTurnDecoder(marker);d.push(`${marker} execute\n`);assert.throws(()=>d.finish());d.reset();d.push(`${marker} done`);assert.equal(d.finish().done,true)
})


test('work decision requirement is checked at finish and respects configured declaration names',()=>{
 let required=false
 const decoder=new ScriptTurnDecoder(marker,{names:{execute:'run',done:'finish'},allowed:['execute','done']},{},()=>required)
 decoder.push('Continue processing.')
 required=true
 assert.throws(()=>decoder.finish(),/run \/ finish/)
 const plain=new ScriptTurnDecoder(marker)
 plain.push('Markdown remains parseable.')
 assert.equal(plain.finish().message,'Markdown remains parseable.')
})
