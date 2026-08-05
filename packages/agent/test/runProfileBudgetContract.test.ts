import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { ToolDescriptor } from '@velaros-ai/agent/protocol'

import {
  applyRunProfileToolExposure,
  resolveRunProfilePolicyForRuntime,
  RunProfileDefinitions,
} from '../src/agent/RunProfile'

/** 子 Agent 模型窗口未知时 QueryLoop 用的保守回退，与 `SubAgentFallbackContextWindow` 同值。 */
const SubAgentFallbackContextWindow = 128_000

function toolDescriptor(name: string, chars: number): ToolDescriptor {
  return { name, description: 'x'.repeat(chars) } as unknown as ToolDescriptor
}

void describe('run profile budget contract', () => {
  void test('profile defaults carry no sampling parameters', () => {
    // 三档曾各声明 temperature/topP/maxOutputTokens，全仓零读取点：档位描述宣称是「运行成本与
    // 发散度」三档，实际只有工具预算生效。别再把采样参数塞回缺席默认里而不接线。
    for (const definition of Object.values(RunProfileDefinitions)) {
      assert.deepEqual(Object.keys(definition.defaults).sort(), [
        'thinkingDepth',
        'toolSurfaceProfile',
      ])
    }
  })

  void test('an explicit parent selection wins over the sub-agent window heuristic', () => {
    // 子 Agent 继承父会话**选定**的档位；显式选档不看窗口。
    const inherited = resolveRunProfilePolicyForRuntime({
      requested: 'expanded',
      contextWindow: SubAgentFallbackContextWindow,
    })

    assert.equal(inherited.profile, 'expanded')
    assert.equal(inherited.reason, 'explicit')
  })

  void test("an 'auto' parent with an unknown sub-agent window falls back conservatively", () => {
    // 注入 runtimeOverride 的派发路径不带 contextWindow：宁可让子 Agent 端一副收紧的工具面，
    // 也不让它端着无预算的全量面。
    const inherited = resolveRunProfilePolicyForRuntime({
      requested: 'auto',
      contextWindow: SubAgentFallbackContextWindow,
    })

    assert.equal(inherited.profile, 'compact')
  })

  void test('the compact budget actually trims an over-sized sub-agent tool surface', () => {
    // 回归 A9：子面此前完全不过预算——模型派出三五个并行子 Agent，每个都端着完整工具面跑。
    const tools = Array.from({ length: 80 }, (_, index) => `tool:${index}`)
    const descriptors = tools.map((name) => toolDescriptor(name, 2_000))
    const toolSchemaChars = Object.fromEntries(tools.map((name) => [name, 2_000]))

    const exposure = applyRunProfileToolExposure(tools, 'compact', {
      toolDescriptors: descriptors,
      toolSchemaChars,
    })

    assert.ok(exposure.allowedTools.length < tools.length)
    assert.equal(exposure.allowedTools.length + exposure.droppedTools.length, tools.length)
    // compact 的 maxToolSchemaChars = 48_000，字节预算生效时它是主约束。
    const exposedChars = exposure.allowedTools.reduce(
      (total, name) => total + toolSchemaChars[name]!,
      0
    )
    assert.ok(exposedChars <= RunProfileDefinitions.compact.budget.maxToolSchemaChars!)
  })
})
