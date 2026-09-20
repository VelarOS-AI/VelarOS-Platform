// 用途：钉住页面脚本求值的三件事——结果整份取回（不截数组、不截深度、DAG 不误判成环），
// 函数加 args 与表达式两种写法，失败分成「页面里抛错」与「结果太大」两种、都带专属码交给程序。
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { BrowserErrorCodes } from '../../contract/constants.js'
import type { BrowserEvaluateScriptOptions, BrowserScriptOutcome } from '../../types/browser.js'
import { buildEvaluateScript } from '../../utils/page-scripts/evaluate.js'
import { scriptOutcomeValue } from '../../utils/script-outcome.js'

/** 在一个只提供 location 的沙箱里跑构建出来的页面脚本，拿到它交回的结局。 */
async function runEvaluateScript(options: Partial<BrowserEvaluateScriptOptions> & { script: string }): Promise<BrowserScriptOutcome> {
  const pageScript = buildEvaluateScript({ maxResultChars: 10_000_000, ...options })
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 测试里跑的就是构建出来的页面脚本本身。
  const run = new Function('location', 'window', `return ${pageScript}`) as (location: { href: string }, window: Record<string, unknown>) => unknown
  return (await run({ href: 'https://example.test/' }, {})) as BrowserScriptOutcome
}

/** 跑一段脚本并解开成程序拿到的值。 */
async function evaluate(options: Partial<BrowserEvaluateScriptOptions> & { script: string }): Promise<unknown> {
  return scriptOutcomeValue(await runEvaluateScript(options))
}

void describe('页面脚本求值', () => {
  void test('结果整份取回：五千项的数组、二十层的嵌套一个不少', async () => {
    const rows = (await evaluate({ script: 'Array.from({ length: 5000 }, (_, index) => ({ index }))' })) as Array<{ index: number }>
    assert.equal(rows.length, 5000)
    assert.deepEqual(rows.at(-1), { index: 4999 })

    let deep = (await evaluate({ script: '(() => { let node = { leaf: "bottom" }; for (let i = 0; i < 20; i += 1) node = { next: node }; return node })()' })) as Record<string, unknown>
    for (let hop = 0; hop < 20; hop += 1) deep = deep.next as Record<string, unknown>
    assert.deepEqual(deep, { leaf: 'bottom' })
  })

  void test('同一个对象被两处引用照样两处都在，只有真的环才写成 [Circular]', async () => {
    const shared = (await evaluate({ script: '(() => { const tags = ["a"]; return { tags, again: { tags } } })()' })) as Record<string, any>
    assert.deepEqual(shared.again.tags, ['a'])
    const cyclic = (await evaluate({ script: '(() => { const node = { name: "n" }; node.self = node; return node })()' })) as Record<string, unknown>
    assert.equal(cyclic.self, '[Circular]')
  })

  void test('求出来是函数就用 args 调它，Promise 等完，多条语句写成箭头函数', async () => {
    assert.equal(await evaluate({ script: '(a, b) => a + b', args: [2, 3] }), 5)
    assert.equal(await evaluate({ script: 'async () => { await Promise.resolve(); return "等到了" }' }), '等到了')
    assert.deepEqual(await evaluate({ script: '(selector) => { const parts = selector.split(" "); return parts.length }', args: ['a b "c'] }), 3)
  })

  void test('undefined 交回 undefined，日期照 toJSON，Error 换成名字、原话与栈', async () => {
    assert.equal(await evaluate({ script: 'undefined' }), undefined)
    assert.equal(await evaluate({ script: 'new Date(Date.UTC(2026, 8, 18))' }), '2026-09-18T00:00:00.000Z')
    const error = (await evaluate({ script: 'new TypeError("坏了")' })) as Record<string, unknown>
    assert.equal(error.name, 'TypeError')
    assert.equal(error.message, '坏了')
  })

  void test('结果超过上限只回长度，程序拿到 BROWSER_RESULT_TOO_LARGE', async () => {
    const outcome = await runEvaluateScript({ script: '"x".repeat(2000)', maxResultChars: 100 })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.json, undefined)
    assert.equal(outcome.tooLargeChars, 2002)
    assert.throws(() => scriptOutcomeValue(outcome), (error) => AppError.from(error).code === BrowserErrorCodes.resultTooLarge)
  })

  void test('页面里抛错与语法错误都交回错误名与原话，程序拿到 BROWSER_SCRIPT_FAILED', async () => {
    const thrown = await runEvaluateScript({ script: '() => { throw new Error("boom") }' })
    assert.equal(thrown.ok, false)
    assert.equal(thrown.error?.message, 'boom')
    assert.throws(() => scriptOutcomeValue(thrown), (error) => {
      const failure = AppError.from(error)
      return failure.code === BrowserErrorCodes.scriptFailed && failure.message.includes('Error: boom')
    })

    const syntax = await runEvaluateScript({ script: 'const = ;' })
    assert.equal(syntax.error?.name, 'SyntaxError')
    // 语法错误在主进程先编译一遍拦下：拼进去的源码一行都没跑。
    assert.equal(syntax.json, undefined)
  })
})
