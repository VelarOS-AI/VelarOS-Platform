import { describe, expect, test } from 'bun:test'

import { selectJsonPath } from '../src/agent/context/retrieval/PayloadReader'
import { findHistoryPreviewPlaceholderArgumentPaths } from '../src/tools/historyPreviewPlaceholder'
import { compactToolInputForModel } from '../src/tools/toolResultSerialization'

/**
 * 独立复刻 summarizeToolInputString 的截断规则（160 字符预览 + 折叠空白），不复用被测代码，
 * 用来拼出「真实产生」而非手写全量正文的嵌套占位串——被测函数每一层都会把 preview 截到
 * 160 字符，手写未截断的完整正文当 fixture 测不出真机会遇到的信息丢失场景。
 */
function rawHistoryPreviewWrap(text: string, field = 'content'): string {
  const preview = text.slice(0, 160).replaceAll(/\s+/g, ' ').trim()
  return preview
    ? `[history preview omitted ${text.length} chars from "${field}"; tool received the full value; preview: ${preview}…]`
    : `[history preview omitted ${text.length} chars from "${field}"; tool received the full value]`
}

describe('history input omission metadata', () => {
  test('removes long source fields and supplies an exact recall path without fabricated text', () => {
    const text = '中文🙂\\path\r\n'.repeat(1000)
    const input = { actions: [{ op: 'create', path: 'src/a.ts', text }] }
    const shown = compactToolInputForModel(input, 'create-source')
    expect(shown.actions).toEqual([{ op: 'create', path: 'src/a.ts' }])
    expect(shown.__historyInputOmissions).toEqual([{
      path: ['actions', 0, 'text'], jsonPath: '$.actions[0].text', chars: text.length, ref: 'input:create-source',
    }])
    expect(JSON.stringify(shown)).not.toContain('history preview omitted')
    expect(input.actions[0]!.text).toBe(text)
    expect(compactToolInputForModel(shown, 'create-source')).toEqual(shown)
  })

  test('ordinary source stays unchanged, including quoted examples of the old placeholder format', () => {
    const input = { text: 'const text = "[history preview omitted 10 chars from string; tool received the full value]"' }
    expect(compactToolInputForModel(input)).toEqual(input)
  })

  test.each(['one layer', 'nested layers', 'copied header plus code', 'no preview'] as const)('old %s source placeholders become separate omissions', (shape) => {
    const once = rawHistoryPreviewWrap('x'.repeat(4000), 'text')
    const value = shape === 'nested layers' ? rawHistoryPreviewWrap(rawHistoryPreviewWrap(once))
      : shape === 'copied header plus code' ? `[history preview omitted 4033 chars from "text"; tool received the full value; preview: ${  'realCode'.repeat(1000)}`
        : shape === 'no preview' ? '[history preview omitted 9000 chars from "widget_code"; tool received the full value]'
          : once
    const shown = compactToolInputForModel({ text: value }, 'old-input')
    expect(Object.hasOwn(shown, 'text')).toBe(false)
    expect(shown.__historyInputOmissions).toEqual([{ path: ['text'], jsonPath: '$.text', ref: 'input:old-input' }])
    expect(compactToolInputForModel(shown, 'old-input')).toEqual(shown)
  })

  test('omits long primitive arrays as a unit without inserting holes or shifting indices', () => {
    const shown = compactToolInputForModel({ paths: ['a', 'b'.repeat(1000), 'c'] }, 'array-input')
    expect(Object.hasOwn(shown, 'paths')).toBe(false)
    expect(shown.__historyInputOmissions).toEqual([{ path: ['paths'], jsonPath: '$.paths', items: 3, ref: 'input:array-input' }])
  })

  test('omission recall paths retrieve exact source under quoted bracket, escape and Unicode keys', () => {
    for (const key of ['a]b', 'x[0].y', 'quote"and\\slash', '中文🙂\n']) {
      const original = { nested: { [key]: 'original source'.repeat(100) } }
      const shown = compactToolInputForModel(original, 'complex-keys')
      const omission = (shown.__historyInputOmissions as Array<{ jsonPath: string }>)[0]!
      expect(selectJsonPath(JSON.stringify(original), omission.jsonPath)).toEqual({ found: true, value: original.nested[key] })
    }
  })

  test('non-JSON values and sparse arrays are omitted without fabricated nulls or serialization errors', () => {
    const shown = compactToolInputForModel({ absent: undefined, big: 1n, items: ['a', undefined, 'b'], sparse: Array(3), invalid: NaN }, 'non-json')
    expect(shown.items).toBeUndefined()
    expect(shown.sparse).toBeUndefined()
    expect(shown.big).toBeUndefined()
    expect(JSON.stringify(shown)).not.toContain('null')
    expect((shown.__historyInputOmissions as unknown[]).length).toBe(5)
  })

  test('whole-input budget fallback contains a recall receipt and no clipped input string', () => {
    const fields = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field${index}`, 'data'.repeat(200)]))
    const shown = compactToolInputForModel(fields, 'whole-input')
    expect(shown.__historyInputPreview).toBe(true)
    expect(shown.__historyInputOmissions).toEqual([{ path: [], jsonPath: '$', ref: 'input:whole-input' }])
    expect(shown.preview).toBeUndefined()
    expect(JSON.stringify(shown).length).toBeLessThan(1000)
    expect(compactToolInputForModel(shown, 'whole-input')).toEqual(shown)
  })

  test('keeps the existing widget replay budget while omitting larger source through metadata', () => {
    const source = ' '.repeat(7000)
    expect(compactToolInputForModel({ widget_code: source })).toEqual({ widget_code: source })
    expect(compactToolInputForModel({ widget_code: source.repeat(2) }).widget_code).toBeUndefined()
  })
})

describe('history preview placeholder copied into tool arguments', () => {
  test('finds placeholder-leading strings at any nesting depth', () => {
    const placeholder = rawHistoryPreviewWrap('x'.repeat(900), 'newText')

    expect(
      findHistoryPreviewPlaceholderArgumentPaths({
        path: 'src/a.ts',
        newText: `\n  ${placeholder}`,
        edits: [
          { oldText: 'a', newText: placeholder },
          { oldText: 'b', newText: 'real content' },
        ],
        command: '[history preview omitted 12 chars from string; tool received the full value]',
      })
    ).toEqual(['newText', 'edits[0].newText', 'command'])
  })

  test('ignores text that only quotes the placeholder format', () => {
    expect(
      findHistoryPreviewPlaceholderArgumentPaths({
        newText: `const expected = '${rawHistoryPreviewWrap('y'.repeat(300))}'`,
        content: `# 历史占位串\n${rawHistoryPreviewWrap('z'.repeat(300))}`,
      })
    ).toEqual([])
  })
})
