import { test } from 'node:test'

import { agentsModule, interactionModule } from '../../../dist/act/agents/index.js'
import { verifyModule } from '../../runtime/test/support/module-contract.mjs'

test('INV-1 agents 的实际操作与模板一致', () => verifyModule(agentsModule, new URL('../template.js', import.meta.url)))
test('INV-1 interaction 的实际操作与模板一致', () => verifyModule(interactionModule, new URL('../interaction-template.js', import.meta.url)))
