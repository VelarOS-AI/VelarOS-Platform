import { describe, expect, test } from 'bun:test'

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

  test('collapses a realistically-truncated nested chain (each layer real 160-char preview) to a single layer', () => {
    // 真实重复包装链：每一层的 preview 都被截到 160 字符（不是手写的完整正文），这正是
    // 真机三层嵌套里内层信息已经丢失一部分的情形——旧实现要求整串以 "…]" 收尾且每层
    // 都是完整占位串才能剥离，对这种真实截断链完全不生效（见评审复核）。
    const real = 'X'.repeat(5200)
    const layer1 = rawHistoryPreviewWrap(real)
    const layer2 = rawHistoryPreviewWrap(layer1)
    const layer3 = rawHistoryPreviewWrap(layer2)

    const result = compactToolInputForModel({ content: layer3 })
    const collapsed = result.content as string

    // 每层预览只留 160 字符，第三层已经把最内层（真实 5200 字符正文）的头部截得
    // 不完整，无法再解析出一条完整头部——这是嵌套发生之前就已经丢失的信息，不是本
    // 函数能逆向补全的。可验证、也应当保证的是：不再继续增长（原始链条是 3 层，输出
    // 至多保留 2 层残留头部）、且长度恒定有界，不随嵌套深度线性膨胀。
    const headerOccurrences = collapsed.match(/history preview omitted/g)?.length ?? 0
    expect(headerOccurrences).toBeLessThanOrEqual(2)
    expect(collapsed.length).toBeLessThan(300)

    // 二次重放幂等：对已收敛的单层占位串再跑一遍必须原样不动，不能继续变化。
    const replayed = compactToolInputForModel({ content: collapsed })
    expect(replayed.content).toBe(collapsed)
  })

  test('collapses the real #118-shaped sample (model-mimicked headers with no closing "…]", followed by real code)', () => {
    // 复刻真机取证 errors.txt #118：模型把两层占位头原样抄进真实参数开头,后面紧跟真实
    // 代码,整串既不以 "…]" 收尾,内层头部也是不完整的（旧实现的锚定正则连第一层都匹配不上）。
    const realCode =
      "test('serializes duplicate apply commands for the same transaction', async () => { /* … */ })"
    const fakeHeader =
      '[history preview omitted 4033 chars from "text"; tool received the full value; preview: '
    const hybrid = `${fakeHeader}${fakeHeader}${realCode}`

    const result = compactToolInputForModel({ text: hybrid })
    const collapsed = result.text as string

    // 两层仿写头部被剥离,模型最终看到的是真实代码本身的预览,而不是嵌套头部的乱码。
    expect(collapsed.match(/history preview omitted/g)).toHaveLength(1)
    expect(collapsed).toContain(realCode.slice(0, 100))

    const replayed = compactToolInputForModel({ text: collapsed })
    expect(replayed.text).toBe(collapsed)
  })

  test('does not trust an oversized value that merely starts with the placeholder header as already-compacted', () => {
    // 边界防绕过（评审 minor #2）：只要开头匹配占位头就原样放行,会让 preview 正文无限大,
    // 绕过所有体积上限。总长明显超出真实占位串的结构上限时必须当作普通大字符串重新压缩。
    const spoofed = `[history preview omitted 5 chars from "content"; tool received the full value; preview: ${'Z'.repeat(9_000)}…]`

    const result = compactToolInputForModel({ content: spoofed })
    const compacted = result.content as string

    expect(compacted.length).toBeLessThan(400)
  })

  test('a genuine long string unrelated to the placeholder format is still wrapped normally', () => {
    const longText = 'y'.repeat(1000)
    const result = compactToolInputForModel({ notes: longText })
    expect(result.notes).toContain('history preview omitted 1000 chars from "notes"')
  })

  test('collapses a single copied header followed by real content (no closing "…]") to exactly one layer', () => {
    // 评审 major：最常见的入口形态——模型只抄了一层占位头（连 "preview: " 都原样抄了）,
    // 后面直接接真实代码,总长远超单层信任上限,且整串不以 "…]" 收尾。旧实现在 layers===1
    // 时只要超过 TrustedSinglePlaceholderMaxLength 就返回 null,回落到 summarizeToolInputString
    // 把"头部+真实代码"整体当新内容再包一层,产生两层嵌套——这正是 #118 嵌套链的第一步。
    const fakeHeader =
      '[history preview omitted 4033 chars from "text"; tool received the full value; preview: '
    const realCode = `test('serializes duplicate apply commands for the same transaction', async () => { ${'x'.repeat(4200)} })`
    const hybrid = `${fakeHeader}${realCode}`

    const result = compactToolInputForModel({ text: hybrid })
    const collapsed = result.text as string

    expect(collapsed.match(/history preview omitted/g)).toHaveLength(1)
    expect(collapsed).toContain(realCode.slice(0, 100))

    const replayed = compactToolInputForModel({ text: collapsed })
    expect(replayed.text).toBe(collapsed)
  })

  test('collapsed placeholder declares the length tool actually received, not the innermost claimed length', () => {
    // 评审 minor #2：嵌套只可能来自模型照抄,工具实际收到的是整串 value（含前面的占位头
    // 文本）。收敛后的占位串若仍报内层宣称的历史长度,既报错了长度,也把"实参开头是占位
    // 垃圾"这一事实从模型眼前抹掉。声明长度必须等于这次工具真实收到的 value.length。
    const fakeHeader =
      '[history preview omitted 4033 chars from "text"; tool received the full value; preview: '
    const realCode = "test('serializes duplicate apply commands', async () => {})"
    const hybrid = `${fakeHeader}${fakeHeader}${realCode}`

    const result = compactToolInputForModel({ text: hybrid })
    const collapsed = result.text as string
    const declaredLength = Number(collapsed.match(/history preview omitted (\d+) chars/)?.[1])

    expect(declaredLength).toBe(hybrid.length)
    expect(declaredLength).not.toBe(4033)
  })

  test('a no-preview leaf placeholder stays untouched when replayed', () => {
    // widget_code 用的是无 preview 分支：[history preview omitted N chars from "widget_code"; tool received the full value]
    const placeholder =
      '[history preview omitted 9000 chars from "widget_code"; tool received the full value]'
    const result = compactToolInputForModel({ widget_code: placeholder })
    expect(result.widget_code).toBe(placeholder)
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
