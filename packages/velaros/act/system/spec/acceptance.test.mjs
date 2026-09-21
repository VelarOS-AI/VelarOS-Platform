import {test} from 'node:test'

import {contextModule} from '../../../dist/act/system/impl/ContextModule.js'
import {memoryModule,modulesModule,storeModule} from '../../../dist/act/system/index.js'
import {verifyModule} from '../../runtime/test/support/module-contract.mjs'
test('INV-1 memory 的实际操作与模板一致',()=>verifyModule(memoryModule,new URL('../memory-template.js',import.meta.url)))
test('INV-1 本地 memory 只生成五个实际操作',()=>verifyModule({create:host=>memoryModule.create(host,false)},new URL('../memory-local-template.js',import.meta.url)))
test('INV-1 modules 的实际操作与模板一致',()=>verifyModule(modulesModule,new URL('../modules-template.js',import.meta.url)))

test('INV-13 store 完整合同与模板一致',()=>verifyModule(storeModule,new URL('../store-template.js',import.meta.url)))
test('INV-13 store 只读投影与模板一致',()=>verifyModule({create:host=>storeModule.create(host,'read')},new URL('../store-read-template.js',import.meta.url)))

test('INV-13 store 写入投影与模板一致',()=>verifyModule({create:host=>storeModule.create(host,'write')},new URL('../store-write-template.js',import.meta.url)))

test('整理材料目录和正文使用精确类型，模板可直接通过脚本检查',()=>verifyModule({create:host=>contextModule.create(host)[0]},new URL('../context-materials-template.js',import.meta.url)))
