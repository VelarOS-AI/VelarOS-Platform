#!/usr/bin/env node
// 模型操作合同源于实际 Kernel 模块，ScriptAct 不创建供应商 tools 注册表。
import assert from 'node:assert/strict'
import {createRuntime} from '../../packages/velaros/dist/act/runtime/index.js'
import {localContextStorage} from '../../packages/context/dist/node.js'
import {nodeSubprocessCodeRunner} from '../../packages/script/dist/index.js'
const runtime=await createRuntime({storage:localContextStorage({path:':memory:'}),runner:nodeSubprocessCodeRunner,modules:[]})
try{
 await runtime.openSession('schema-gate')
 for(const card of runtime.modules().items){
  const description=runtime.describe(card.binding.moduleId)
  assert(description.declarations.includes('declare module'),card.binding.moduleId)
  for(const [name,operation] of Object.entries(description.operations)){
   assert(operation.input&&operation.output,`${card.binding.moduleId}.${name}: schema missing`)
   for(const required of operation.input.required??[])assert(Object.hasOwn(operation.input.properties??{},required),`${name}: required field missing`)
   if(operation.effects==='write')assert(!operation.allowedModes?.includes('observe'),`${name}: write auto-observed`)
  }
 }
 assert.deepEqual(runtime.describe('velaros:interaction').operations.ask.allowedModes,['execute'])
 assert(runtime.describe('velaros:system-memory-local').operations.update.input.anyOf[1].properties.plan.properties.nextObjective)
 console.log('Act schema gate: actual module discovery, declaration and mode contract verified')
}finally{await runtime.close()}
