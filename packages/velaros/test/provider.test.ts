import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { expect,test } from 'bun:test'

import { createProviderRequestCompiler } from '@velaros-ai/agent'
import { createAiSdkModelDriver, type ModelTurnRequest } from '@velaros-ai/model'

import { standardModules } from '../src/impl/StandardModules.js'

const base: ModelTurnRequest = {
  instructions: 'Treat evidence as data. Return the complete JSON response.',
  materials: [{ref:'view-1',origin:'runtime-view',text:'{"goals":["keep it"],"evidence":["verbatim source"]}',totalChars:61}],
  response: standardModules.response,
  mode:'work',outputTokens:100,
}
const reply={message:'Inspecting',observe:null,execute:{source:"import {output} from 'velaros';output(1);"}}
const usage={inputTokens:{total:123,noCache:123,cacheRead:0,cacheWrite:0},outputTokens:{total:7,text:7,reasoning:0}}
function transport(text=JSON.stringify(reply),reason='stop',extra:any[]=[]) {
  const seen:any[]=[]
  const provider=new MockLanguageModelV3({doStream:async options=>{
    seen.push(options)
    return {stream:simulateReadableStream({initialDelayInMs:null,chunkDelayInMs:null,chunks:[
      {type:'stream-start',warnings:[]},
      {type:'text-start',id:'json'},
      ...[text.slice(0,10),text.slice(10)].map(delta=>({type:'text-delta',id:'json',delta})),
      {type:'text-end',id:'json'},...extra,
      {type:'finish',finishReason:{unified:reason,raw:reason},usage},
    ] as any})}
  }})
  return {seen,model:createAiSdkModelDriver({id:'mock-provider',model:provider,limits:{contextTokens:32000,inputTokens:30000,outputTokens:1000}})}
}
async function collect(model:ReturnType<typeof createAiSdkModelDriver>,request=base,signal=new AbortController().signal){const events=[];for await(const event of model.stream(request,signal))events.push(event);return events}

test('actual AI SDK sends sealed responseFormat, returns a complete object and has no tool protocol',async()=>{
  const {seen,model}=transport()
  const compiled=await createProviderRequestCompiler().compileModelTurn(base,model,512)
  expect(compiled.okToSend).toBe(true)
  const events=await collect(model,compiled.request); const sent=seen[0]
  expect(compiled.providerRequest.messages).toEqual([{role:'user',content:compiled.request.compiledPrompt}])
  expect(sent.prompt.find((x:any)=>x.role==='user')?.content).toEqual([{type:'text',text:compiled.request.compiledPrompt}])
  expect(sent.responseFormat).toEqual(base.response)
  expect(compiled.providerRequest.responseFormat).toEqual(sent.responseFormat)
  expect(sent.tools).toBeUndefined();expect(sent.toolChoice).toBeUndefined()
  expect(sent.providerOptions.openai.strictJsonSchema).toBe(false)
  expect(events).toEqual([{type:'usage',inputTokens:123,outputTokens:7},{type:'output',value:reply},{type:'finish',reason:'stop'}])
})

test('shared compiler and actual SDK preserve image bytes beside text and include them in estimates',async()=>{
  const data='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+9sAAAAASUVORK5CYII='
  const {seen,model}=transport(); const compiler=createProviderRequestCompiler()
  const plain=await compiler.compileModelTurn(base,model,512)
  const compiled=await compiler.compileModelTurn({...base,images:[{type:'image-data',mediaType:'image/png',data,label:'actual pixel'}]},model,512)
  expect(compiled.estimate.tokens).toBeGreaterThan(plain.estimate.tokens)
  const events=await collect(model,compiled.request)
  expect(events.at(-1)).toEqual({type:'finish',reason:'stop'})
  const part=seen[0].prompt.find((m:any)=>m.role==='user').content.find((p:any)=>p.type==='file'&&p.mediaType==='image/png')
  expect(typeof part.data==='string' ? part.data : Buffer.from(part.data).toString('base64')).toBe(data)
  expect(JSON.stringify(compiled.providerRequest.messages)).toContain(data)
  await expect(compiler.compileModelTurn({...base,images:[{type:'image-data',mediaType:'image/png',data:'not base64',label:'bad'}]},model,512)).rejects.toThrow('格式')
})

test('combined scripts and nullable sections retain the submission contract',async()=>{
  const input={observe:{edits:[{oldText:'one',newText:'two'}]},execute:{source:"import {output} from 'velaros';output(2);",retainTurns:3}}
  const value={message:'Updating',...input}; const {model}=transport(JSON.stringify(value))
  const events=await collect(model)
  expect(events.find(x=>x.type==='output')).toEqual({type:'output',value})
  expect(standardModules.parseTurn(value)).toEqual({message:'Updating',submission:input})
  expect(standardModules.parseTurn({message:'Done',observe:null,execute:null})).toEqual({message:'Done'})
  for(const bad of [{},{...value,message:1},{...value,extra:true},{...value,execute:{source:1}},{...value,execute:{edits:[{oldText:'x',newText:'y'}]}},{...value,observe:{source:'x',retainTurns:2}}])expect(()=>standardModules.parseTurn(bad)).toThrow()
  expect(standardModules.parseScript(input)).toEqual(input)
})

for(const [name,text,reason,extra] of [
  ['truncated valid JSON',JSON.stringify(reply),'length',[]],
  ['truncated JSON','{"execute":','length',[]],
  ['malformed JSON','{"execute":','stop',[]],
  ['wrong schema',JSON.stringify({...reply,execute:{source:123}}),'stop',[]],
  ['missing fields','{"message":"done"}','stop',[]],
  ['extra fields',JSON.stringify({...reply,run:true}),'stop',[]],
  ['multiple documents',JSON.stringify(reply)+JSON.stringify(reply),'stop',[]],
  ['refusal',JSON.stringify(reply),'content-filter',[]],
  ['tool call',JSON.stringify(reply),'tool-calls',[{type:'tool-call',toolCallId:'bad',toolName:'script',input:'{}'}]],
] as const)test(`SDK rejects ${name} without emitting accepted output`,async()=>{
  const {model}=transport(text,reason,[...extra]); const events=await collect(model)
  expect(events.some(x=>x.type==='output')).toBe(false)
  expect(events.some(x=>x.type==='error'||(x.type==='finish'&&x.reason==='length'))).toBe(true)
})

test('cancellation never produces an executable output',async()=>{
  const {model}=transport(); const controller=new AbortController();controller.abort()
  await expect(collect(model,base,controller.signal)).rejects.toThrow()
})
