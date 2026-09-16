// 用途：钉住求值回执不再把同一份内容给两遍。
// 老回执在没截断时同时给 result（对象）与 resultText（缩进 JSON 文本），
// evaluate_script、read_page_data、get_element_bounds 每次的回执体积都因此翻倍还多。
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { BrowserEvaluateScriptBuilder } from '../../src/utils/page-scripts/evaluate.js'

const builder = new BrowserEvaluateScriptBuilder()

/** 在一个只提供 location 的沙箱里跑构建出来的页面脚本，拿到它返回的信封。 */
async function runEvaluateScript(options: {
  script: string
  mode?: 'expression' | 'function-body'
  maxResultChars?: number
}): Promise<Record<string, unknown>> {
  const pageScript = builder.buildEvaluateScript(options)
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 测试里跑的就是构建出来的页面脚本本身。
  const run = new Function('location', 'window', `return ${pageScript}`) as (
    location: { href: string },
    window: Record<string, unknown>
  ) => unknown
  return (await run({ href: 'https://example.test/' }, {})) as Record<string, unknown>
}

void describe('求值回执', () => {
  void test('没截断时只给 result，不再附一份同内容的 resultText', async () => {
    const envelope = await runEvaluateScript({ script: '({ title: "a", rows: [1, 2, 3] })' })

    assert.equal(envelope.ok, true)
    assert.deepEqual(envelope.result, { title: 'a', rows: [1, 2, 3] })
    assert.equal(envelope.resultTruncated, false)
    assert.ok(!('resultText' in envelope))
  })

  void test('截断时才给 resultText，此时 result 为 null', async () => {
    const envelope = await runEvaluateScript({
      script: '({ text: "x".repeat(2000) })',
      maxResultChars: 100,
    })

    assert.equal(envelope.resultTruncated, true)
    assert.equal(envelope.result, null)
    assert.equal(String(envelope.resultText).length, 100)
  })

  void test('语法错误与运行时错误的回执也不带 resultText', async () => {
    const syntaxError = await runEvaluateScript({ script: 'const = ;' })
    const runtimeError = await runEvaluateScript({
      script: 'throw new Error("boom")',
      mode: 'function-body',
    })

    assert.equal(syntaxError.ok, false)
    assert.ok(!('resultText' in syntaxError))
    assert.equal(runtimeError.ok, false)
    assert.match(String((runtimeError.error as { message: string }).message), /boom/u)
    assert.ok(!('resultText' in runtimeError))
  })
})
