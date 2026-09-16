/**
 * 工具契约公共件的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 这里只测对外承诺的行为，只经根入口；实现细节的测试在 test/ 目录。
 */

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import {
  createToolExampleRegistry,
  type DefineToolRuntimeSpecInput,
  toolContracts,
  toolDescriptions,
  ToolFailureLimits,
  toolFailures,
  toolKernelModules,
} from '../src/index'

interface ProbeContext {
  abortSignal: AbortSignal
  ready: boolean
}

/** 造一份能过全部校验的最小工具定义，调用方只覆盖要测的那几格。 */
function probeToolInput(
  overrides: Partial<DefineToolRuntimeSpecInput<{ text: string }, ProbeContext>> = {}
): DefineToolRuntimeSpecInput<{ text: string }, ProbeContext> {
  return {
    name: 'probe:echo',
    category: 'probe',
    role: 'inspect',
    summary: '把收到的文本原样回显。',
    suitable: ['确认工具链路通不通'],
    schema: z.strictObject({ text: z.string() }),
    permissions: [],
    execute: async (input) => input.text,
    ...overrides,
  }
}

describe('工具契约', () => {
  test('INV-1 工具名必须是 canonical 工具 id，不合法的在定义期就抛', () => {
    const examples = createToolExampleRegistry()
    expect(() => toolContracts.defineRuntime(probeToolInput(), examples)).not.toThrow()
    expect(() => toolContracts.defineRuntime(probeToolInput({ name: 'Probe:Echo' }), examples)).toThrow(/canonical/u)
    expect(() => toolContracts.defineRuntime(probeToolInput({ name: 'probe' }), examples)).toThrow(/canonical/u)
  })

  test('INV-2 示例按模型会发的那份 JSON 校验，过不了自己的 schema 就在定义期抛', () => {
    const examples = createToolExampleRegistry()
    expect(() =>
      toolContracts.defineRuntime(probeToolInput({ examples: [{ text: '你好' }] }), examples)
    ).not.toThrow()
    // undefined 只在内存里成立：序列化后整格消失，必填的 text 就缺了。
    expect(() =>
      toolContracts.defineRuntime(probeToolInput({ examples: [{ text: undefined }] }), examples)
    ).toThrow(/probe:echo/u)
    expect(() =>
      toolContracts.defineRuntime(probeToolInput({ examples: [{ text: 1 }] }), examples)
    ).toThrow(/示例/u)
  })

  test('INV-3 说明的硬上限不可豁免，软预算只认两种理由且 note 不能空白', () => {
    const examples = createToolExampleRegistry()
    const long = (count: number) => '啊'.repeat(count)
    expect(() =>
      toolContracts.defineRuntime(probeToolInput({ summary: long(toolDescriptions.maxChars + 1) }), examples)
    ).toThrow(/硬上限/u)
    expect(() =>
      toolContracts.defineRuntime(
        probeToolInput({
          summary: long(toolDescriptions.maxChars + 1),
          descriptionBudgetWaiver: { reason: 'safety-protocol', note: '整条流程就是护栏' },
        }),
        examples
      )
    ).toThrow(/硬上限/u)
    expect(() =>
      toolContracts.defineRuntime(probeToolInput({ summary: long(toolDescriptions.budgetChars + 1) }), examples)
    ).toThrow(/软预算/u)
    expect(() =>
      toolContracts.defineRuntime(
        probeToolInput({
          summary: long(toolDescriptions.budgetChars + 1),
          descriptionBudgetWaiver: { reason: 'safety-protocol', note: '整条流程就是护栏' },
        }),
        examples
      )
    ).not.toThrow()
    expect(() =>
      toolContracts.defineRuntime(
        probeToolInput({
          summary: long(toolDescriptions.budgetChars + 1),
          descriptionBudgetWaiver: { reason: 'safety-protocol', note: '   ' },
        }),
        examples
      )
    ).toThrow(/note/u)
  })

  test('INV-4 分节语法固定：渲染出来的说明一定判为结构化，乱序或空节判非结构化', () => {
    const rendered = toolDescriptions.renderTool({
      description: '把收到的文本原样回显。',
      suitable: ['确认工具链路通不通'],
      forbidden: ['当成日志工具用'],
      notes: ['回显不改动内容'],
    })
    expect(toolDescriptions.isToolDescription(rendered)).toBe(true)
    const parsed = toolDescriptions.parseTool(rendered)
    expect(parsed?.suitable).toEqual(['确认工具链路通不通'])
    expect(parsed?.usage).toEqual([])
    // 缺必填的「适合」、分节回头、以及只有标题的空节都判非结构化。
    expect(toolDescriptions.isToolDescription('描述：只有描述')).toBe(false)
    expect(toolDescriptions.isToolDescription('描述：x\n\n禁止：\n- a\n\n适合：\n- b')).toBe(false)
    expect(toolDescriptions.isToolDescription('描述：x\n\n适合：')).toBe(false)
  })

  test('INV-5 readOnly 的判据顺序是 effectKind → 显式 readOnly → role', () => {
    expect(toolContracts.isReadOnly({ capabilities: { effectKind: 'read' }, readOnly: false, role: 'edit' })).toBe(true)
    expect(toolContracts.isReadOnly({ capabilities: { effectKind: 'write' }, readOnly: true, role: 'inspect' })).toBe(false)
    expect(toolContracts.isReadOnly({ readOnly: true, role: 'edit' })).toBe(true)
    expect(toolContracts.isReadOnly({ role: 'inspect' })).toBe(true)
    expect(toolContracts.isReadOnly({ role: 'edit' })).toBe(false)
  })

  test('INV-6 内核操作严格解析入参、换上内核的 abortSignal、不可用报 UNAVAILABLE', async () => {
    const examples = createToolExampleRegistry()
    const defineProbeTool = toolContracts.createDefiner<ProbeContext>({ categoryOf: () => 'probe' })
    const tool = defineProbeTool({
      ...probeToolInput({ execute: async (input, ctx) => `${input.text}:${ctx.ready}` }),
      category: 'probe',
    })
    void toolContracts.defineRuntime(probeToolInput(), examples)

    expect(toolKernelModules.callableOperations({ 'probe:echo': tool }, undefined, { label: '探针' })).toEqual({})

    const operations = toolKernelModules.callableOperations<ProbeContext>(
      { 'probe:echo': tool },
      (_scope, signal) => ({ abortSignal: signal, ready: true }),
      { label: '探针' }
    )
    const controller = new AbortController()
    await expect(
      operations['probe:echo']!.invoke(undefined, { text: '嗨', extra: 1 }, controller.signal)
    ).rejects.toThrow(/入参不合法/u)
    await expect(operations['probe:echo']!.invoke(undefined, '嗨', controller.signal)).rejects.toThrow(/必须是对象/u)
    expect(await operations['probe:echo']!.invoke(undefined, { text: '嗨' }, controller.signal)).toBe('嗨:true')

    const unavailable = toolKernelModules.callableOperations<ProbeContext>(
      { 'probe:echo': { ...tool, isAvailable: () => false } },
      (_scope, signal) => ({ abortSignal: signal, ready: true }),
      { label: '探针' }
    )
    await expect(
      unavailable['probe:echo']!.invoke(undefined, { text: '嗨' }, controller.signal)
    ).rejects.toThrow(/不可用/u)
  })

  test('INV-7 失败回执的三种结论写在 context.executionOutcome，清单按上限截', () => {
    expect(toolFailures.create('VALIDATION', '什么都没写', undefined, { notApplied: true }).context.executionOutcome)
      .toBe('not-applied')
    expect(toolFailures.create('PERMISSION', '整步跳过').context.executionOutcome).toBe('skipped')
    const applied = Array.from({ length: ToolFailureLimits.listItems + 5 }, (_, index) => `a/${index}.ts`)
    const failure = toolFailures.create('EXECUTION', '写到一半失败', undefined, { applied })
    expect(failure.context.executionOutcome).toBe('failed')
    expect(failure.context.applied).toHaveLength(ToolFailureLimits.listItems)
  })
})
