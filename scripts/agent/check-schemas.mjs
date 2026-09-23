#!/usr/bin/env node
// 模型操作合同源于实际 Kernel 模块，ScriptAct 不创建供应商 tools 注册表。
// 标准模块的模型面一律由操作接口生成（contract/surface.ts）：合同版本是生成物的哈希，声明带着接口上的说明；
// 只有外部接入的模块（MCP）才由 Kernel 从它们自带的 schema 合成声明，这里不挂那一类。
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
  assert.match(card.binding.schemaRevision,/^[0-9a-f]{64}$/u,`${card.binding.moduleId}: 合同不是由操作接口生成的`)
  assert(description.declarations.includes('/**'),`${card.binding.moduleId}: 声明缺少接口上的说明`)
  for(const [name,operation] of Object.entries(description.operations)){
   assert(operation.input&&operation.output,`${card.binding.moduleId}.${name}: schema missing`)
   for(const required of operation.input.required??[])assert(Object.hasOwn(operation.input.properties??{},required),`${name}: required field missing`)
   if(operation.effects==='write')assert(!operation.allowedModes?.includes('observe'),`${name}: write auto-observed`)
  }
 }
 assert.deepEqual(runtime.describe('velaros:interaction').operations.ask.allowedModes,['execute'])
 assert.match(runtime.describe('velaros:system-memory-local').declarations,/export function plan\(input: Partial<TaskCapsule>\)/u)
 console.log('Act schema gate: generated module surfaces, declarations and mode contract verified')
}finally{await runtime.close()}
