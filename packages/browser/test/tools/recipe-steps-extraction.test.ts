// 用途：钉住 recipe 的 extract_table / extract_list 与 browser:extract 走同一条取回口径。
// 求值通道恒返回信封、且为「模型直读」把数组截到前 100 项：直接读信封的老写法会让 run 记录
// 存下一个信封，150 行的表格只剩 100 行，而 rowCount 还写着 150——错得看不出来。
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { simplifyBrowserEvaluatedValue } from '../../src/core/BrowserEvaluateScriptBuilder.js'
import type { BrowserRecipeStepPlan } from '../../src/tools/RecipePlan.js'
import { executeBrowserRecipeSteps } from '../../src/tools/RecipeSteps.js'
import type { ToolContext } from '../../src/tools/Types.js'

/** 只属于求值信封的键：recipe 步骤结果里一个都不许出现。 */
const EnvelopeOnlyKeys = ['mode', 'result', 'resultText', 'resultTruncated', 'durationMs']

/**
 * 仿真的求值通道：与页面侧真实行为一致——先 simplify（数组截到前 100 项），再 JSON 化，
 * 文本超过 maxResultChars 时 result 置 null、resultTruncated 为 true。
 * 载荷先在页面里 JSON.stringify 成字符串的调用方不受 simplify 影响，这正是被测的取回口径。
 */
function createEvaluateChannel(payload: Record<string, unknown>) {
  const scripts: string[] = []
  const evaluateScript = async (options: { script: string; maxResultChars?: number }) => {
    scripts.push(options.script)
    const value: unknown = options.script.startsWith('JSON.stringify(')
      ? JSON.stringify(payload)
      : simplifyBrowserEvaluatedValue(payload)
    const text = JSON.stringify(value, null, 2)
    const resultTruncated = text.length > (options.maxResultChars ?? 20_000)
    return {
      url: 'https://example.test/list',
      ok: true,
      mode: 'expression',
      result: resultTruncated ? null : value,
      resultTruncated,
      error: null,
      durationMs: 1,
      capturedAt: 0,
    }
  }

  return { scripts, evaluateScript }
}

function createToolContext(evaluateScript: unknown): ToolContext {
  return {
    browser: { evaluateScript },
    abortSignal: new AbortController().signal,
  } as unknown as ToolContext
}

function buildStepPlan(operation: BrowserRecipeStepPlan['operation']): BrowserRecipeStepPlan[] {
  return [
    {
      step: {
        id: 'collect',
        kind: operation?.kind === 'extract_list' ? 'extract_list' : 'extract_table',
        title: '收集列表',
        instruction: '提取当前页面的数据。',
      },
      status: 'ready',
      operation,
      message: '可执行。',
    },
  ]
}

void describe('recipe 提取步骤的取回口径', () => {
  void test('150 行的表格整份存进 run 记录，而不是信封里的前 100 行', async () => {
    const rows = Array.from({ length: 150 }, (_, index) => [`row-${index}`, String(index)])
    const channel = createEvaluateChannel({
      ok: true,
      headers: ['name', 'value'],
      rows,
      rowCount: rows.length,
    })

    const [stepResult] = await executeBrowserRecipeSteps(
      { stepPlan: buildStepPlan({ kind: 'extract_table', maxRows: 200 }) },
      createToolContext(channel.evaluateScript)
    )

    const result = stepResult?.result as Record<string, unknown>
    assert.equal(stepResult?.status, 'executed')
    assert.equal(result.rowCount, 150)
    assert.equal((result.rows as unknown[]).length, 150)
    assert.ok(channel.scripts[0]?.startsWith('JSON.stringify('))
    for (const key of EnvelopeOnlyKeys) {
      assert.ok(!(key in result), `${key} 不应出现在步骤结果里`)
    }
  })

  void test('150 条的列表整份存进 run 记录', async () => {
    const items = Array.from({ length: 150 }, (_, index) => ({
      title: `item-${index}`,
      href: `https://example.test/item/${index}`,
    }))
    const channel = createEvaluateChannel({ ok: true, items, itemCount: items.length })

    const [stepResult] = await executeBrowserRecipeSteps(
      { stepPlan: buildStepPlan({ kind: 'extract_list', maxItems: 200 }) },
      createToolContext(channel.evaluateScript)
    )

    const result = stepResult?.result as Record<string, unknown>
    assert.equal(result.itemCount, 150)
    assert.equal((result.items as unknown[]).length, 150)
    for (const key of EnvelopeOnlyKeys) {
      assert.ok(!(key in result), `${key} 不应出现在步骤结果里`)
    }
  })

  void test('页面结果超出求值通道上限时明确失败，不把半截结果当完整结果', async () => {
    const rows = Array.from({ length: 4000 }, (_, index) => [
      `row-${index}`,
      'x'.repeat(80),
    ])
    const channel = createEvaluateChannel({
      ok: true,
      headers: ['name', 'value'],
      rows,
      rowCount: rows.length,
    })

    await assert.rejects(
      executeBrowserRecipeSteps(
        { stepPlan: buildStepPlan({ kind: 'extract_table', maxRows: 4000 }) },
        createToolContext(channel.evaluateScript)
      ),
      /超过页面求值通道上限/u
    )
  })
})
