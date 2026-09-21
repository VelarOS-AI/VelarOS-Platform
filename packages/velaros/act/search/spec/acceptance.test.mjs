import assert from 'node:assert/strict'
import { test } from 'node:test'

import { evidenceModule,searchModule } from '../../../dist/act/search/index.js'
import { verifyModule } from '../../runtime/test/support/module-contract.mjs'

test('INV-1 search 的实际操作与模板一致', () => verifyModule(searchModule, new URL('../template.js', import.meta.url)))
test('INV-1 evidence 的实际操作与模板一致', () => verifyModule(evidenceModule, new URL('../evidence-template.js', import.meta.url)))

test('搜索档位目录与调用使用同一组宿主名称，发现的名称可直接用于搜索', async () => {
  const names = ['quick', 'investigate']
  const info = names.map(name => ({name, default:name === 'investigate', limits:{}}))
  let selected
  const definition = searchModule.create({search:{
    profiles:()=>names,
    profileInfo:()=>info,
    run:async input=>{selected=input.profile; return {selected}}
  }})
  const operations=definition.operations
  const directory=await operations.profiles.run(null,{})
  assert.deepEqual(operations.profiles.output.items.properties.name.enum,names)
  for(const variant of operations.search.input.anyOf) assert.deepEqual(variant.properties.profile.enum,names)
  const profile=directory.find(item=>item.default).name
  assert.deepEqual(await operations.search.run({query:'session',profile},{}),{selected:'investigate'})
  assert.equal(selected,'investigate')
})
