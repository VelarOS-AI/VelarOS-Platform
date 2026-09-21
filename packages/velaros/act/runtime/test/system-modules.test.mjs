import {test} from 'node:test'

import {modulesModule} from '../../../dist/act/runtime/index.js'

import {verifyModule} from './support/module-contract.mjs'
test('INV-1 modules 的实际操作与模板一致',()=>verifyModule(modulesModule,new URL('../../system/modules-template.js',import.meta.url)))
