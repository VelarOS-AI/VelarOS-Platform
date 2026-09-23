import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AgentsLimits, InteractionLimits } from '../../../dist/act/agents/contract/constants.js'
import { VelarAgentsModule, VelarInteractionModule } from '../../../dist/act/agents/contract/surface.js'
import { agentsModule, interactionModule } from '../../../dist/act/agents/index.js'
import { verifyModule } from '../../runtime/test/support/module-contract.mjs'

test('INV-1 agents 的实际操作与模板一致', () => verifyModule(agentsModule, new URL('../template.js', import.meta.url)))
test('INV-1 interaction 的实际操作与模板一致', () => verifyModule(interactionModule, new URL('../interaction-template.js', import.meta.url)))

test('INV-2 声明里写给模型的上限与常量表一致', () => {
  for (const [surface, fragments] of [
    [VelarAgentsModule, [`materials 把已有原文引用复制给它（最多 ${AgentsLimits.materials} 条）`, `materials 最多 ${AgentsLimits.materials} 条`]],
    [VelarInteractionModule, [`要对方回答的话：message 1 到 ${InteractionLimits.messageChars} 个字符`, `说明缺少的能力：message 1 到 ${InteractionLimits.messageChars} 个字符`]],
  ]) for (const fragment of fragments) assert.ok(surface.declarations.includes(fragment), `${surface.specifier} 的声明里没有「${fragment}」`)
})
