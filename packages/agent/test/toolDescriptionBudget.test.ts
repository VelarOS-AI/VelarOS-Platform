import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import {
  defineToolRuntimeSpec,
  type DefineToolRuntimeSpecInput,
  isStructuredToolDescription,
  ToolContractExampleRegistry,
  ToolDescriptionBudgetChars,
} from '../src/tool-contract'
import { mapToolDiscoveryCards } from '../src/tool-library/builtin/ToolSpaceQueries'

/**
 * 造一个描述长度可控的工具契约。
 *
 * `filler` 只往 `注意` 分节堆字符——软预算量的是**整条模型面描述**，所以用哪个分节撑长度
 * 都等价；选 `注意` 是因为它不承载行为约束，测试意图（量长度）不会和「别压缩规则」混淆。
 */
function defineProbeTool(
  overrides: Partial<DefineToolRuntimeSpecInput<{ value: string }>> & { fillerChars?: number } = {}
) {
  const { fillerChars = 0, ...contractOverrides } = overrides
  const notes: [string, ...string[]] = fillerChars > 0
    ? ['基线注意事项。', 'x'.repeat(fillerChars)]
    : ['基线注意事项。']

  return defineToolRuntimeSpec<{ value: string }>(
    {
      name: 'probe:budget',
      category: 'system',
      role: 'inspect',
      summary: '预算门探针工具。',
      suitable: ['需要验证软预算门时。'],
      forbidden: ['不要在产品里注册它。'],
      usage: ['传 value。'],
      examples: [{ value: 'x' }],
      notes,
      schema: z.object({ value: z.string() }),
      permissions: [],
      execute: async () => null,
      ...contractOverrides,
    },
    // 每个用例用独立示例注册表，避免探针工具名污染进程级默认注册表。
    new ToolContractExampleRegistry()
  )
}

describe('tool description soft budget', () => {
  test('accepts a description inside the 1800-char budget', () => {
    const tool = defineProbeTool()

    expect(tool.description.length).toBeLessThanOrEqual(ToolDescriptionBudgetChars)
    expect(isStructuredToolDescription(tool.description)).toBe(true)
    expect(tool.summary).toBe('预算门探针工具。')
    expect(tool.readOnly).toBe(true)
  })

  test('rejects an over-budget description that declares no waiver', () => {
    expect(() => defineProbeTool({ fillerChars: 2_000 })).toThrow(
      /over the 1800 soft budget/
    )
  })

  test('lets an explicit safety-protocol waiver through', () => {
    const tool = defineProbeTool({
      fillerChars: 2_000,
      descriptionBudgetWaiver: {
        reason: 'safety-protocol',
        note: '强制流程本身是防损坏的安全约束，拆进技能等于拆护栏。',
      },
    })

    expect(tool.description.length).toBeGreaterThan(ToolDescriptionBudgetChars)
  })

  test('refuses a waiver with an unrecognized reason or an empty note', () => {
    expect(() =>
      defineProbeTool({
        fillerChars: 2_000,
        descriptionBudgetWaiver: {
          // 只认 safety-protocol / meta-tool；第三种理由必须先改 design-principles §8。
          reason: 'legacy' as 'meta-tool',
          note: '历史遗留。',
        },
      })
    ).toThrow(/is not recognized/)

    expect(() =>
      defineProbeTool({
        fillerChars: 2_000,
        descriptionBudgetWaiver: { reason: 'meta-tool', note: '   ' },
      })
    ).toThrow(/must carry a note/)
  })

  test('keeps the 6000-char hard limit above the soft budget', () => {
    expect(() =>
      defineProbeTool({
        fillerChars: 8_000,
        descriptionBudgetWaiver: { reason: 'meta-tool', note: '自举工具没有先读技能的余地。' },
      })
    ).toThrow(/over the 6000 hard limit/)
  })
})

describe('usageSkillId companion skill pointer', () => {
  test('appends the pointer as the last line without breaking the grammar', () => {
    const tool = defineProbeTool({ usageSkillId: 'probe-authoring' })

    expect(tool.description.endsWith('\n- 深度用法先读 skill:probe-authoring')).toBe(true)
    expect(isStructuredToolDescription(tool.description)).toBe(true)
    expect(tool.usageSkillId).toBe('probe-authoring')
  })

  test('leaves the description untouched when no companion skill is declared', () => {
    expect(defineProbeTool().description).not.toContain('深度用法先读')
    expect(defineProbeTool().usageSkillId).toBeUndefined()
  })

  test('surfaces the companion skill id on the tooling:map card', () => {
    const descriptor = {
      name: 'example:document_edit',
      description: 'Edit structured documents through semantic operations.',
      role: 'edit',
      permissions: ['fs:write'],
      categoryId: 'example',
      systemEnabled: true,
      usageSkillId: 'structured-document-authoring',
    }
    const context = {
      codingSession: {
        hasToolCategoryAccess: () => true,
        isToolCategoryAllowed: () => true,
        getEnabledPromptFeatures: () => [],
      },
      getCurrentVisibleToolNames: () => ['example:document_edit'],
      listCapabilityPages: () => [{
        id: 'tool:example:document_edit',
        kind: 'tool',
        name: 'example:document_edit',
        categoryId: 'example',
        descriptor,
        permissions: ['fs:write'],
        availability: 'visible',
        schemaState: 'visible',
        schemaPolicy: 'full',
        nextAction: 'call_tool',
        resident: true,
        reasons: [],
      }],
      listToolCategories: () => [],
    }

    const result = mapToolDiscoveryCards(context as never, {
      op: 'map',
      kind: 'all',
      categoryIds: [],
      domainIds: [],
      toolOsStates: [],
      categoryLimit: 12,
      maxToolsPerCategory: 8,
    } as never)

    expect(result.categories[0]?.tools[0]).toMatchObject({
      name: 'example:document_edit',
      usageSkillId: 'structured-document-authoring',
    })
  })

  test('does not expose a catalog-only category after the role capability filter removes every tool', () => {
    const context = {
      codingSession: {
        hasToolCategoryAccess: () => true,
        isToolCategoryAllowed: () => true,
        getEnabledPromptFeatures: () => [],
      },
      getCurrentVisibleToolNames: () => [],
      listCapabilityPages: () => [],
      listToolCategories: () => [{
        category: {
          id: 'planning',
          label: 'Planning',
          description: 'Plan tools.',
          toolOs: { domain: 'injected', defaultState: 'resident' },
        },
        enabled: true,
        tools: [{
          name: 'plan:update',
          description: 'Update the visible execution plan.',
          role: 'control',
          permissions: [],
          categoryId: 'planning',
          systemEnabled: true,
        }],
      }],
    }

    const result = mapToolDiscoveryCards(context as never, {
      op: 'map',
      kind: 'all',
      categoryIds: [],
      domainIds: [],
      toolOsStates: [],
      categoryLimit: 12,
      maxToolsPerCategory: 8,
    } as never)

    expect(result.categories).toEqual([])
  })

  test('keeps the complete tool name index when a state filter only expands the resident capability card', () => {
    const descriptor = {
      name: 'plan:update',
      description: 'Update the visible execution plan.',
      role: 'control',
      permissions: [],
      categoryId: 'planning',
      systemEnabled: true,
    }
    const context = {
      codingSession: {
        hasToolCategoryAccess: () => true,
        isToolCategoryAllowed: () => true,
        getEnabledPromptFeatures: () => [],
      },
      getCurrentVisibleToolNames: () => [],
      listCapabilityPages: () => [{
        id: 'tool:plan:update',
        kind: 'tool',
        name: descriptor.name,
        categoryId: descriptor.categoryId,
        descriptor,
        permissions: [],
        availability: 'loadable',
        schemaState: 'visible',
        schemaPolicy: 'preview',
        nextAction: 'replace_page',
        resident: false,
        reasons: [{ layer: 'resident', code: 'loadable', message: 'loadable' }],
      }],
      listToolCategories: () => [{
        category: {
          id: 'planning',
          label: 'Planning',
          description: 'Plan tools.',
          toolOs: { domain: 'injected', defaultState: 'resident' },
        },
        enabled: true,
        tools: [descriptor],
      }],
    }

    const result = mapToolDiscoveryCards(context as never, {
      op: 'map',
      kind: 'all',
      categoryIds: [],
      domainIds: [],
      toolOsStates: ['resident'],
      categoryLimit: 12,
      maxToolsPerCategory: 8,
    } as never)

    expect(result.categories[0]).toMatchObject({
      categoryId: 'planning',
      toolNames: ['plan:update'],
      tools: [],
      totalToolCount: 0,
      totalToolNameCount: 1,
    })
  })

  test('counts the appended pointer against the budget', () => {
    // 指路行是模型面描述的一部分，不能靠「它是自动加的」逃过预算。
    const budgetEdge = defineProbeTool({ fillerChars: 1_500 })
    expect(budgetEdge.description.length).toBeLessThanOrEqual(ToolDescriptionBudgetChars)

    const fillerJustUnderBudget = 1_500 + (ToolDescriptionBudgetChars - budgetEdge.description.length)
    expect(() =>
      defineProbeTool({ fillerChars: fillerJustUnderBudget, usageSkillId: 'probe-authoring' })
    ).toThrow(/over the 1800 soft budget/)
  })
})
