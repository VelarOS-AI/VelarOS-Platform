import { describe, expect, test } from 'bun:test'

import { compactToolInputForModel } from '../src/tools/toolResultSerialization'

describe('history preview placeholder idempotency', () => {
  test('does not re-wrap a value that is already a single-layer placeholder', () => {
    const longText = 'x'.repeat(4033)
    const firstPass = compactToolInputForModel({ newContent: longText })
    const placeholder = firstPass.newContent as string
    expect(placeholder.startsWith('[history preview omitted 4033 chars from "newContent"')).toBe(
      true
    )

    // 模拟下一轮重放：占位串本身作为“历史参数”再次进入压缩管线，且它已超过
    // newContent 的大字段阈值（240），若不做幂等识别就会被当成原始大字符串再包一层。
    const secondPass = compactToolInputForModel({ newContent: placeholder })
    expect(secondPass.newContent).toBe(placeholder)
    expect((secondPass.newContent as string).match(/history preview omitted/g)).toHaveLength(1)
  })

  test('collapses an already-nested placeholder (legacy persisted data) back to a single layer', () => {
    const innerText = "test('does something real', () => { expect(1).toBe(1) })"
    const layer1 = `[history preview omitted 4033 chars from "text"; tool received the full value; preview: ${innerText}…]`
    const layer2 = `[history preview omitted 4033 chars from "text"; tool received the full value; preview: ${layer1}…]`
    const layer3 = `[history preview omitted 4033 chars from "text"; tool received the full value; preview: ${layer2}…]`

    const result = compactToolInputForModel({ text: layer3 })
    const collapsed = result.text as string

    expect(collapsed.match(/history preview omitted/g)).toHaveLength(1)
    expect(collapsed).toContain('4033 chars from "text"')
    expect(collapsed).toContain(innerText)
  })

  test('a genuine long string unrelated to the placeholder format is still wrapped normally', () => {
    const longText = 'y'.repeat(1000)
    const result = compactToolInputForModel({ notes: longText })
    expect(result.notes).toContain('history preview omitted 1000 chars from "notes"')
  })

  test('a no-preview leaf placeholder stays untouched when replayed', () => {
    // widget_code 用的是无 preview 分支：[history preview omitted N chars from "widget_code"; tool received the full value]
    const placeholder =
      '[history preview omitted 9000 chars from "widget_code"; tool received the full value]'
    const result = compactToolInputForModel({ widget_code: placeholder })
    expect(result.widget_code).toBe(placeholder)
  })
})
