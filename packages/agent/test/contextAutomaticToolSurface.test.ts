import { expect, test } from 'bun:test'
import { agentTools, createBuiltinAgentModDefinition } from '../src/impl/AgentTools'

test('registered tools and their manifest follow the current context contract',()=>{
  const builtin=createBuiltinAgentModDefinition()
  const names=builtin.manifest.contributes.tools?.map(tool=>tool.name)??[]
  expect(names.sort()).toEqual(Object.keys(agentTools).sort())
  expect(names.filter(name=>name.startsWith('context:'))).toEqual([])
  for(const name of ['goal:update','directive:upsert'])expect(builtin.bindings.tools).toHaveProperty(name)
})
