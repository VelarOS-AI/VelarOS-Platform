/** 文件能力的实现细节测试：对外承诺在 spec/acceptance.test.ts，这里补行的拆合与按行改、改动账、一批的小工具、特殊文件、媒体类型这些边角。 */

import { spawnSync } from 'node:child_process'
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { FileChanges } from '../impl/FileChanges'
import { FileErrorCodes, FileLimits, fileOperations } from '../index'
import { diskSpace, failureOf } from '../spec/support'
import type { FileEditPlan } from '../types/edit'
import { commitFailure, staleProblem, unresolvedEditFailure, withLinkTarget, writeOfPlan } from '../utils/batch'
import { applyLineEdits, joinLines, lineCount, lineSpan, numberedLines, splitLines, toFileNewlines } from '../utils/lines'
import { fileIdentity } from '../utils/paths'
import { detectMediaType, stampProvesUnchanged } from '../utils/text-file'
import { FileTuning } from '../utils/tuning'

let root = ''
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-files-impl-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 在一段正文上按行号改，交回改好的正文；改法不合法直接让用例挂掉。 */
function edited(content: string, edits: unknown): string {
  const result = applyLineEdits(splitLines(content), edits)
  if (typeof result === 'string') throw new Error(`应当改得了，却被拒：${result}`)
  return joinLines(result)
}

/** 在一段正文上按行号改，应当被拒：交回那句说明。 */
function rejected(content: string, edits: unknown): string {
  const result = applyLineEdits(splitLines(content), edits)
  if (typeof result !== 'string') throw new Error(`应当被拒，却改成了 ${JSON.stringify(joinLines(result))}`)
  return result
}

/** 一份写入计划：缺省是一个已有的小文件，原文留着。 */
function planOf(overrides: Partial<FileEditPlan> = {}): FileEditPlan {
  return {
    index: 0, path: 'a.txt', target: '/space/a.txt', linked: false, created: false, previous: Buffer.from('old\n'), bytes: Buffer.from('new\n'),
    totalLines: 1, baseVersion: 'v-old', stamp: { mtimeMs: 1, size: 4 }, ...overrides,
  }
}

describe('行：拆开、数行、拼回', () => {
  test('\\n 与 \\r\\n 都算换行，行文本不带换行符；结尾的换行不多出一行，最后一行没换行也算一行；单独的 \\r 不算换行', () => {
    const cases: Array<[string, Array<{ text: string; br: string }>]> = [
      ['', []],
      ['a', [{ text: 'a', br: '' }]],
      ['a\n', [{ text: 'a', br: '\n' }]],
      ['a\nb', [{ text: 'a', br: '\n' }, { text: 'b', br: '' }]],
      ['\n', [{ text: '', br: '\n' }]],
      ['\n\n', [{ text: '', br: '\n' }, { text: '', br: '\n' }]],
      ['\r\n', [{ text: '', br: '\r\n' }]],
      ['a\r\nb\r\n', [{ text: 'a', br: '\r\n' }, { text: 'b', br: '\r\n' }]],
      ['a\n\r\nb', [{ text: 'a', br: '\n' }, { text: '', br: '\r\n' }, { text: 'b', br: '' }]],
      ['a\rb\n\r', [{ text: 'a\rb', br: '\n' }, { text: '\r', br: '' }]],
    ]
    for (const [content, lines] of cases) expect(`${JSON.stringify(content)} → ${JSON.stringify(splitLines(content).lines)}`).toBe(`${JSON.stringify(content)} → ${JSON.stringify(lines)}`)
  })

  test('拼回去和原文一字不差：每行接上它自己的换行符', () => {
    for (const content of ['', 'a', 'a\n', 'a\r\nb\nc', '\r\n\n\r\n', 'x\ry\r\n', '中文\r\n第二行', 'tail\n\n']) {
      expect(joinLines(splitLines(content))).toBe(content)
    }
  })

  test('新写的行用出现得多的那种换行；一样多或者一个换行都没有时用 \\n', () => {
    expect(splitLines('a\r\nb\r\nc\n').eol).toBe('\r\n')
    expect(splitLines('a\nb\nc\r\n').eol).toBe('\n')
    expect(splitLines('a\r\nb\n').eol).toBe('\n')
    expect(splitLines('abc').eol).toBe('\n')
    expect(splitLines('').eol).toBe('\n')
    expect(splitLines('a\r\n').eol).toBe('\r\n')
  })

  test('行数和 wc -l 一样，只是最后一行没有换行时也算一行', () => {
    expect(['', 'a', 'a\n', 'a\nb', 'a\nb\n', '\n', '\n\n', 'a\r\nb\r\n'].map(lineCount)).toEqual([0, 1, 1, 2, 2, 1, 2, 2])
  })

  test('取一段带行号的行：末行超过文件行数就到最后一行为止', () => {
    const text = splitLines('a\nb\nc\n')
    expect(numberedLines(text, 2, 99)).toEqual([[2, 'b'], [3, 'c']])
    expect(numberedLines(text, 1, 1)).toEqual([[1, 'a']])
    expect(numberedLines(text, 1, 3)).toEqual([[1, 'a'], [2, 'b'], [3, 'c']])
    expect(numberedLines(text, 4, 5)).toEqual([])
    expect(numberedLines(splitLines(''), 1, 1)).toEqual([])
  })

  test('行号与区间：正整数、[n]、[首行, 末行]（末行不小于首行）；其余一律不认', () => {
    expect(lineSpan(3)).toEqual([3, 3])
    expect(lineSpan([3])).toEqual([3, 3])
    expect(lineSpan([2, 5])).toEqual([2, 5])
    expect(lineSpan([4, 4])).toEqual([4, 4])
    const invalid: unknown[] = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '3', null, undefined, {}, [], [0], [3, 2], [1, 2, 3], ['1', '2'], [1, 2.5], [0, 2]]
    for (const range of invalid) expect(`${JSON.stringify(range)}:${JSON.stringify(lineSpan(range))}`).toBe(`${JSON.stringify(range)}:null`)
  })

  test('整份写的正文换成文件的换行风格：先把 \\r\\n 统一成 \\n，单独的 \\r 不动', () => {
    expect(toFileNewlines('a\nb\r\nc', '\r\n')).toBe('a\r\nb\r\nc')
    expect(toFileNewlines('a\r\nb\n', '\n')).toBe('a\nb\n')
    expect(toFileNewlines('a\rb\n', '\r\n')).toBe('a\rb\r\n')
    expect(toFileNewlines('', '\r\n')).toBe('')
  })
})

describe('行：按行号改几处', () => {
  test('插在最前面、接在最后一行后面；空文件插进去的内容照空文件的样子，结尾不加换行', () => {
    expect(edited('a\nb\n', [{ after: 0, text: 'top' }])).toBe('top\na\nb\n')
    expect(edited('a\nb\n', [{ after: 2, text: 'end' }])).toBe('a\nb\nend\n')
    expect(edited('a\nb', [{ after: 2, text: 'end' }])).toBe('a\nb\nend')
    expect(edited('a\nb', [{ after: 0, text: 'top' }])).toBe('top\na\nb')
    expect(edited('', [{ after: 0, text: 'x\ny' }])).toBe('x\ny')
    // 空文件里要结尾换行，就像说明写的那样在 text 结尾多加一个 \n
    expect(edited('', [{ after: 0, text: 'x\n' }])).toBe('x\n')
  })

  test('CRLF 文件：新写的行用 \\r\\n，没动的行不变；text 里写的 \\r\\n 先统一成 \\n 再拆', () => {
    expect(edited('a\r\nb\r\nc\r\n', [{ range: 2, text: 'B1\nB2' }])).toBe('a\r\nB1\r\nB2\r\nc\r\n')
    expect(edited('a\r\nb', [{ after: 2, text: 'c' }])).toBe('a\r\nb\r\nc')
    expect(edited('a\r\nb\r\n', [{ after: 0, text: 'x\r\ny' }])).toBe('x\r\ny\r\na\r\nb\r\n')
    expect(edited('a\nb\n', [{ range: 1, text: 'x\r\ny' }])).toBe('x\ny\nb\n')
  })

  test('混合换行：没动的行留着自己的换行符，新写的行用为主的那种', () => {
    expect(edited('one\r\ntwo\nthree\r\nfour\r\n', [{ range: 3, text: 'THREE' }])).toBe('one\r\ntwo\nTHREE\r\nfour\r\n')
    expect(edited('one\ntwo\r\nthree\n', [{ after: 1, text: 'new' }])).toBe('one\nnew\ntwo\r\nthree\n')
    // 换掉的那一行原来的换行符不留：它是新写的行
    expect(edited('one\r\ntwo\nthree\r\n', [{ range: 2, text: 'TWO' }])).toBe('one\r\nTWO\r\nthree\r\n')
  })

  test('原来结尾没有换行的：删掉、换掉最后一行，接在后面，改完结尾还是没有；原来有的还有；全删了是空文件', () => {
    expect(edited('a\nb', [{ range: 2, text: '' }])).toBe('a')
    expect(edited('a\nb', [{ range: 2, text: 'x\ny' }])).toBe('a\nx\ny')
    expect(edited('a\nb', [{ range: 2, text: '' }, { after: 2, text: 'c' }])).toBe('a\nc')
    expect(edited('a\nb\n', [{ range: 2, text: '' }])).toBe('a\n')
    expect(edited('a\nb\n', [{ range: 2, text: 'x' }])).toBe('a\nx\n')
    expect(edited('a\nb', [{ range: [1, 2], text: '' }])).toBe('')
    expect(edited('a\nb\n', [{ range: [1, 2], text: '' }])).toBe('')
    expect(edited('a\r\nb', [{ range: 1, text: '' }])).toBe('b')
  })

  test('几处都按改之前那一版的行号算，给的顺序不要紧；挨着的几处各改各的', () => {
    const base = '1\n2\n3\n4\n5\n'
    const edits = [{ range: 4, text: 'D' }, { range: [2, 3], text: 'BC' }, { after: 0, text: 'top' }, { after: 5, text: 'end' }, { range: 1, text: 'A' }]
    expect(edited(base, edits)).toBe('top\nA\nBC\nD\n5\nend\n')
    expect(edited(base, [...edits].reverse())).toBe('top\nA\nBC\nD\n5\nend\n')
    expect(edited(base, [{ range: [1, 2], text: 'x' }, { range: [3, 4], text: 'y' }])).toBe('x\ny\n5\n')
    expect(edited(base, [{ range: 5, text: 'e' }, { range: 4, text: 'd' }, { range: 3, text: 'c' }])).toBe('1\n2\nc\nd\ne\n')
  })

  test('同一个位置：先换后插，插在第 n 行后面的落在从第 n+1 行起被换掉的那一段前面；几处插入按给的顺序排', () => {
    expect(edited('1\n2\n3\n', [{ range: 2, text: 'B' }, { after: 1, text: 'I' }])).toBe('1\nI\nB\n3\n')
    expect(edited('1\n2\n3\n', [{ after: 1, text: 'I' }, { range: 2, text: 'B' }])).toBe('1\nI\nB\n3\n')
    expect(edited('1\n2\n', [{ after: 1, text: 'x' }, { after: 1, text: 'y' }, { after: 1, text: 'z' }])).toBe('1\nx\ny\nz\n2\n')
    expect(edited('1\n2\n3\n', [{ range: 2, text: '' }, { after: 1, text: 'X' }, { after: 2, text: 'Y' }])).toBe('1\nX\nY\n3\n')
    // 插在被换掉的那一段的前后两头都不算重叠
    expect(edited('1\n2\n3\n4\n', [{ range: [2, 3], text: 'x' }, { after: 1, text: 'before' }, { after: 3, text: 'after' }])).toBe('1\nbefore\nx\nafter\n4\n')
    expect(edited('1\n2\n3\n', [{ range: [1, 2], text: 'AB' }, { after: 2, text: 'C' }])).toBe('AB\nC\n3\n')
  })

  test('text 是空串就删掉那几行；结尾多加一个 \\n 就多一个空行；插入空串什么都不加', () => {
    expect(edited('a\nb\nc\n', [{ range: 2, text: '' }])).toBe('a\nc\n')
    expect(edited('a\nb\n', [{ range: 1, text: 'x\n' }])).toBe('x\n\nb\n')
    expect(edited('a\nb\n', [{ after: 1, text: '' }])).toBe('a\nb\n')
    expect(edited('a\nb\n', [{ after: 1, text: '\n' }])).toBe('a\n\n\nb\n')
  })

  test('重叠的几处拒绝：两段区间交叉、同一行换两次、插入点落在被换掉的几行中间', () => {
    expect(rejected('1\n2\n3\n4\n', [{ range: [1, 2], text: 'x' }, { range: [2, 3], text: 'y' }])).toContain('edits[0] 与 edits[1] 重叠了')
    expect(rejected('1\n2\n3\n4\n', [{ range: 2, text: 'x' }, { range: 2, text: 'y' }])).toContain('edits[0] 与 edits[1] 重叠了')
    expect(rejected('1\n2\n3\n4\n', [{ range: [1, 4], text: 'x' }, { range: [2, 3], text: 'y' }])).toContain('重叠了')
    expect(rejected('1\n2\n3\n4\n', [{ range: [2, 4], text: 'x' }, { after: 3, text: 'y' }])).toContain('edits[1] 与 edits[0] 重叠了')
    expect(rejected('1\n2\n3\n4\n', [{ after: 2, text: 'y' }, { range: [2, 3], text: 'x' }])).toContain('edits[0] 与 edits[1] 重叠了')
  })

  test('改法不合法交回一句说明：不是数组、空的、超过上限、形状不对、行号越出文件', () => {
    const wholeShape = `edits 要 1–${FileLimits.editsPerFile} 处改动的数组`
    expect(rejected('a\n', 'x')).toBe(wholeShape)
    expect(rejected('a\n', [])).toBe(wholeShape)
    expect(rejected('a\n', Array.from({ length: FileLimits.editsPerFile + 1 }, () => ({ after: 0, text: 'x' })))).toBe(wholeShape)
    expect(rejected('a\n', [{ range: 1, text: 'ok' }, null])).toContain('edits[1] 要 { range, text } 或 { after, text }')
    expect(rejected('a\n', [{ range: 1 }])).toContain('edits[0] 要 { range, text }')
    expect(rejected('a\n', [{ range: 1, text: 3 }])).toContain('text 是字符串')
    expect(rejected('a\n', [{ range: 1, after: 0, text: 'x' }])).toContain('range 与 after 只给一个')
    expect(rejected('a\n', [{ text: 'x' }])).toContain('range 与 after 只给一个')
    expect(rejected('a\n', [{ range: [0, 1], text: 'x' }])).toContain('edits[0].range 要行号或 [首行, 末行]')
    expect(rejected('a\nb\n', [{ range: [2, 3], text: 'x' }])).toBe('edits[0].range 超出了文件：文件只有 2 行，这里要到第 3 行')
    expect(rejected('', [{ range: 1, text: 'x' }])).toContain('文件只有 0 行')
    expect(rejected('a\n', [{ after: 2, text: 'x' }])).toContain('edits[0].after 要 0–1 的整数')
    expect(rejected('a\n', [{ after: -1, text: 'x' }])).toContain('edits[0].after 要 0–1 的整数')
    expect(rejected('a\n', [{ after: '1', text: 'x' }])).toContain('这里给的是 "1"')
    expect(rejected('a\n', [{ after: 0.5, text: 'x' }])).toContain('edits[0].after')
    // 正好到上限的照改
    expect(lineCount(edited('a\n', Array.from({ length: FileLimits.editsPerFile }, () => ({ after: 1, text: 'x' }))))).toBe(FileLimits.editsPerFile + 1)
  })

  test('传进来的行不被改动：改好的是另一份', () => {
    const text = splitLines('a\nb')
    const result = applyLineEdits(text, [{ after: 2, text: 'c' }])
    expect(joinLines(text)).toBe('a\nb')
    expect(typeof result === 'string' ? result : joinLines(result)).toBe('a\nb\nc')
  })
})

describe('改动账：FileChanges', () => {
  /** 一次改动里的一个文件。 */
  const entry = (path: string, before: Buffer | null | undefined) => ({ path, target: `/space/${path}`, linked: false, before, after: `after-${path}` })

  test('记一次交回号，按号取回；号每次都不一样；撤回过的记着撤回过', () => {
    const changes = new FileChanges()
    const first = changes.record([entry('a.txt', Buffer.from('a')), entry('new.txt', null)])
    const second = changes.record([entry('a.txt', Buffer.from('b'))])
    expect(first.changeId).not.toBe(second.changeId)
    expect(changes.recall(first.changeId)).toMatchObject({ undoable: true, undone: false, bytes: 1, entries: [{ path: 'a.txt' }, { path: 'new.txt', before: null }] })
    changes.markUndone(first.changeId)
    expect(changes.recall(first.changeId)?.undone).toBe(true)
    expect(changes.recall(second.changeId)?.undone).toBe(false)
    expect(changes.recall('change-0-nothing')).toBeNull()
    changes.markUndone('change-0-nothing')
  })

  test('有文件的原文没留下来（缺席）这次改动就撤不回；新建的（null）不影响', () => {
    const changes = new FileChanges()
    expect(changes.record([entry('new.txt', null)]).undoable).toBe(true)
    expect(changes.record([entry('a.txt', Buffer.from('a')), entry('big.log', undefined)]).undoable).toBe(false)
  })

  test(`只留最近 ${FileLimits.undoChanges} 次：多出来的从最早的丢起`, () => {
    const changes = new FileChanges()
    const ids = Array.from({ length: FileLimits.undoChanges + 2 }, (_, index) => changes.record([entry(`${index}.txt`, Buffer.from('x'))]).changeId)
    expect(ids.slice(0, 2).map((id) => changes.recall(id))).toEqual([null, null])
    expect(ids.slice(2).every((id) => changes.recall(id) !== null)).toBe(true)
  })

  test('留着的原文总量超过预算，从最早的丢起；最近那一次再大也留着', () => {
    const changes = new FileChanges()
    const half = FileTuning.changes.totalBytes / 2
    const small = changes.record([entry('small.txt', Buffer.from('s'))]).changeId
    const first = changes.record([entry('a.bin', Buffer.alloc(half))]).changeId
    expect(changes.recall(small)).not.toBeNull()
    const second = changes.record([entry('b.bin', Buffer.alloc(half))]).changeId
    expect([small, first, second].map((id) => changes.recall(id) !== null)).toEqual([false, true, true])
    const huge = changes.record([entry('c.bin', Buffer.alloc(FileTuning.changes.totalBytes + 1))]).changeId
    expect([first, second, huge].map((id) => changes.recall(id) !== null)).toEqual([false, false, true])
    // 撤不回的（原文缺席）不占预算
    const cheap = changes.record([entry('d.bin', undefined)]).changeId
    expect([huge, cheap].map((id) => changes.recall(id) !== null)).toEqual([false, true])
  })
})

describe('一批的小工具：utils/batch.ts', () => {
  test('落盘时核对什么：留着原文的核对原字节，新建的核对仍不存在，原文没留的不核对（只靠计划后那次印记）', () => {
    expect(writeOfPlan(planOf())).toEqual({ target: '/space/a.txt', bytes: Buffer.from('new\n'), expected: { exists: true, bytes: Buffer.from('old\n') } })
    expect(writeOfPlan(planOf({ previous: Buffer.alloc(0) }))).toEqual({ target: '/space/a.txt', bytes: Buffer.from('new\n'), expected: { exists: true, bytes: Buffer.alloc(0) } })
    expect(writeOfPlan(planOf({ created: true, previous: null }))).toEqual({ target: '/space/a.txt', bytes: Buffer.from('new\n'), expected: { exists: false } })
    expect(writeOfPlan(planOf({ previous: undefined }))).toEqual({ target: '/space/a.txt', bytes: Buffer.from('new\n') })
  })

  test('整批的失败：有一个被拒就是 FILES_EDIT_DENIED，否则 FILES_EDIT_UNRESOLVED；问题逐条进 message，完整清单进 context', () => {
    const stale = { file: 1, path: 'b.txt', reason: 'stale' as const, message: '被改过', currentVersion: 'v2' }
    const unresolved = unresolvedEditFailure([{ file: 0, path: 'a.txt', reason: 'invalid', message: '不是文本' }, stale])
    expect(unresolved.code).toBe(FileErrorCodes.editUnresolved)
    expect(unresolved.message).toBe('这一批一个文件都没写，有 2 个问题。files[0] a.txt：不是文本；files[1] b.txt：被改过')
    expect(unresolved.context).toEqual({ executionOutcome: 'not-applied', problems: [{ file: 0, path: 'a.txt', reason: 'invalid', message: '不是文本' }, stale] })
    expect(unresolvedEditFailure([stale, { file: 2, path: 'c.pem', reason: 'denied', message: '用户没同意' }]).code).toBe(FileErrorCodes.editDenied)
  })

  test('核对版本：没给就不核；给了对不上带上现在的版本；文件不存在另说', () => {
    expect(staleProblem(undefined, 'v1')).toBeNull()
    expect(staleProblem('v1', 'v1')).toBeNull()
    expect(staleProblem('v1', 'v2')).toEqual({ reason: 'stale', message: '文件在版本 v1 之后被改过，现在是 v2；重新读一遍再改', currentVersion: 'v2' })
    expect(staleProblem('v1', null)).toEqual({ reason: 'stale', message: '给了版本 v1，但文件不存在' })
  })

  test('落盘途中出错：空间点名写进去的换成模型认得的路径，另记成一次改动给出号；撤不回时直说；没点名就是什么都没写', () => {
    const plans = [planOf(), planOf({ index: 1, path: 'b.txt', target: '/space/b.txt' })]
    const recorded: string[][] = []
    const failure = new AppError('PLATFORM', '磁盘满了', undefined, { applied: ['/space/a.txt'] })
    const partial = commitFailure(failure, plans, (applied) => {
      recorded.push(applied.map((plan) => plan.path))
      return 'change-9-abc'
    })
    expect(partial.code).toBe('PLATFORM')
    expect(partial.message).toBe("这一批只写进去了一部分——已经写入的：a.txt；出错的原因：磁盘满了。要退回到改之前，就 undo({ changeId: 'change-9-abc' })；不要整批重发，先 read 一遍看现状")
    expect(partial.context).toEqual({ applied: ['a.txt'] })
    expect(recorded).toEqual([['a.txt']])
    expect(commitFailure(failure, plans, () => null).message).toContain('这几个文件改之前太大，没留原文，撤不回')
    const nothing = commitFailure(new AppError('PLATFORM', '磁盘满了'), plans, () => {
      throw new Error('什么都没写时不该记改动')
    })
    expect(nothing.message).toBe('这一批没有写进去：磁盘满了')
    expect(nothing.context).toEqual({ applied: [] })
  })

  test('路径是符号链接时回执里带上 target，不是就不带这个键', () => {
    expect(withLinkTarget<{ path: string; target?: string }>({ path: 'link' }, '/real', true)).toEqual({ path: 'link', target: '/real' })
    expect(withLinkTarget<{ path: string; target?: string }>({ path: 'plain' }, '/plain', false)).not.toHaveProperty('target')
  })

  test('判重的身份键：Windows 与 macOS 不分大小写，Linux 分；Windows 两种分隔符都认', () => {
    expect(fileIdentity('/a/B.txt', 'darwin')).toBe(fileIdentity('/a/b.txt', 'darwin'))
    expect(fileIdentity('/a/./x/../B.txt', 'darwin')).toBe('/a/b.txt')
    expect(fileIdentity('/a/B.txt', 'linux')).not.toBe(fileIdentity('/a/b.txt', 'linux'))
    expect(fileIdentity('C:\\Data\\A.txt', 'win32')).toBe(fileIdentity('c:/data/a.txt', 'win32'))
  })
})

describe('读写的边角', () => {
  test('UTF-16 解码后行文本不带换行符，编码照实报', async () => {
    await writeFile(join(root, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\r\nb', 'utf16le')]))
    const [file] = (await fileOperations.read({ files: [{ path: 'utf16.txt' }] }, diskSpace({ root }).context)).files
    expect(file).toMatchObject({ encoding: 'utf16le', totalLines: 2, lines: [[1, 'a'], [2, 'b']] })
  })

  test('目录、其他二进制、设备文件、不存在的文件都算失败；全部失败时整个调用抛第一个失败', async () => {
    const { context } = diskSpace({ root })
    await writeFile(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]))
    const paths = ['.', 'blob.bin', 'missing.txt', ...(process.platform === 'win32' ? [] : ['/dev/null'])]
    const failures = await Promise.all(paths.map((path) => failureOf(fileOperations.read({ files: [{ path }] }, context))))
    expect(failures.map((failure) => `${failure.code} ${failure.message}`)).toEqual([
      expect.stringMatching(/^VALIDATION 路径是目录/),
      expect.stringMatching(/^VALIDATION 文件是二进制的/),
      expect.stringMatching(/^NOT_FOUND 文件不存在/),
      ...(process.platform === 'win32' ? [] : [expect.stringMatching(/^VALIDATION 路径不是普通文件/)]),
    ])
    const all = await failureOf(fileOperations.read({ files: paths.map((path) => ({ path })) }, context))
    expect(all.message).toContain('路径是目录')
  })

  test('预算用完之后的文件不定位、不读盘，那一项是失败条目', async () => {
    await writeFile(join(root, 'big.txt'), 'a'.repeat(FileLimits.readChars))
    await writeFile(join(root, 'note.txt'), 'here')
    const space = diskSpace({ root })
    const budget = await fileOperations.read({ files: [{ path: 'big.txt' }, { path: 'note.txt' }] }, space.context)
    expect(budget.files[1]).toEqual({ path: 'note.txt', error: { code: 'VALIDATION', message: expect.stringContaining('预算已被前面的文件用完') } })
    expect(space.located).toEqual(['big.txt'])
  }, 30_000)

  test('读越界只是那一项失败；只有这一项时整个调用报出拒绝原因', async () => {
    await writeFile(join(root, 'note.txt'), 'here')
    const space = diskSpace({ root, clamp: true })
    const refused = await fileOperations.read({ files: [{ path: 'note.txt' }, { path: '/etc/hosts' }] }, space.context)
    expect(refused.files.map((entry) => ('error' in entry ? entry.error.code : entry.lines))).toEqual([[[1, 'here']], 'PERMISSION'])
    await expect(fileOperations.read({ files: [{ path: '/etc/hosts' }] }, space.context)).rejects.toThrow('在这个空间之外')
  })

  test.skipIf(process.platform === 'win32')('已有文件的权限位原样保留，新文件的权限由 umask 定', async () => {
    const mask = process.umask(0o077)
    try {
      const { context } = diskSpace({ root })
      await writeFile(join(root, 'shared.sh'), 'echo one\n')
      await chmod(join(root, 'shared.sh'), 0o777)
      await fileOperations.edit({ files: [{ path: 'shared.sh', newText: 'echo two\n' }] }, context)
      expect((await stat(join(root, 'shared.sh'))).mode & 0o777).toBe(0o777)
      await fileOperations.edit({ files: [{ path: 'fresh.txt', newText: 'new\n' }] }, context)
      expect((await stat(join(root, 'fresh.txt'))).mode & 0o777).toBe(0o600)
    } finally {
      process.umask(mask)
    }
  })

  test.skipIf(process.platform === 'win32')('命名管道不当文本改，也不会被换成普通文件', async () => {
    const pipe = join(root, 'pipe')
    expect(spawnSync('mkfifo', [pipe]).status).toBe(0)
    const failure = await failureOf(fileOperations.edit({ files: [{ path: 'pipe', newText: 'x' }] }, diskSpace({ root }).context))
    expect(failure.message).toContain('不是普通文件')
    expect((await lstat(pipe)).isFIFO()).toBe(true)
  })

  test('多个硬链接的文件不碰；上级路径是文件时在计划期就报出来；路径是目录不当文件改', async () => {
    const { context } = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), 'a\n')
    spawnSync('ln', [join(root, 'a.txt'), join(root, 'b.txt')])
    expect((await failureOf(fileOperations.edit({ files: [{ path: 'a.txt', newText: 'x' }] }, context))).message).toContain('2 个硬链接')
    expect((await failureOf(fileOperations.edit({ files: [{ path: 'a.txt/child.txt', newText: 'x' }] }, context))).message).toContain('上级路径不是目录')
    expect((await failureOf(fileOperations.edit({ files: [{ path: '.', newText: 'x' }] }, context))).message).toContain('路径是目录，不是文件')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('a\n')
  })

  test('同一个文件换个写法也算出现两次，整批不写', async () => {
    await writeFile(join(root, 'a.pem'), 'a\n')
    const space = diskSpace({ root })
    const failure = await failureOf(fileOperations.edit({ files: [{ path: 'a.pem', newText: 'x' }, { path: './sub/../a.pem', newText: 'y' }] }, space.context))
    expect(failure.message).toContain('files[1]')
    expect(failure.message).toContain('不止一次')
    expect(space.commits).toHaveLength(0)
    expect(await readFile(join(root, 'a.pem'), 'utf8')).toBe('a\n')
  })

  test('按行号改不存在的文件指向用 newText 新建；带 version 的 newText 遇上不存在的文件算版本对不上', async () => {
    const { context } = diskSpace({ root })
    expect((await failureOf(fileOperations.edit({ files: [{ path: 'nope.txt', version: 'v1', edits: [{ after: 0, text: 'x' }] }] }, context))).message).toContain('新建文件用 newText')
    expect((await failureOf(fileOperations.edit({ files: [{ path: 'nope.txt', version: 'v1', newText: 'x' }] }, context))).message).toContain('给了版本 v1，但文件不存在')
  })

  test('edit 回执里的版本与行数就是写进去的那份：CRLF 文件按落盘的字节算版本', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'crlf.txt'), 'a\r\n')
    const result = await fileOperations.edit({ files: [{ path: 'crlf.txt', newText: 'x\ny\nz' }] }, space.context)
    const [file] = (await fileOperations.read({ files: [{ path: 'crlf.txt' }] }, space.context)).files
    expect(result.files[0]).toMatchObject({ totalLines: 3, version: file && 'version' in file ? file.version : '' })
    expect(await readFile(join(root, 'crlf.txt'), 'utf8')).toBe('x\r\ny\r\nz')
  })
})

describe('这一轮修的几处', () => {
  test('GB18030 按行改：没动的行沿用原字节（同一个字的另一种写法不被改写）', async () => {
    // 0x80 在 GB18030 里解成 €，重新编码却写成 A2 E3：没动的第一行必须原样留着 0x80。
    await writeFile(join(root, 'gb.txt'), Buffer.from([0x80, 0x0a, 0x61, 0x0a]))
    const space = diskSpace({ root })
    const [file] = (await fileOperations.read({ files: [{ path: 'gb.txt' }] }, space.context)).files
    if (!file || 'error' in file) throw new Error('应当读得到')
    expect(file.encoding).toBe('gb18030')
    await fileOperations.edit({ files: [{ path: 'gb.txt', version: file.version, edits: [{ range: 2, text: 'b' }] }] }, space.context)
    expect([...await readFile(join(root, 'gb.txt'))]).toEqual([0x80, 0x0a, 0x62, 0x0a])
  })

  test('撤回做到一半出错：点名已经退回去的；再撤一次接着撤剩下的，不算冲突', async () => {
    await writeFile(join(root, 'a.txt'), 'a\n')
    await writeFile(join(root, 'b.txt'), 'b\n')
    let broken = false
    const space = diskSpace({ root, failOn: (target) => broken && target.endsWith('b.txt') })
    const change = await fileOperations.edit({ files: [{ path: 'a.txt', newText: 'A\n' }, { path: 'b.txt', newText: 'B\n' }] }, space.context)
    broken = true
    const failure = await failureOf(fileOperations.undo({ changeId: change.changeId }, space.context))
    expect(failure.message).toContain('已经退回去的是')
    expect(failure.message).toContain(join(root, 'a.txt'))
    expect(failure.message).toContain('再 undo 一次')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('a\n')
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('B\n')
    broken = false
    const resumed = await fileOperations.undo({ changeId: change.changeId }, space.context)
    expect(resumed.files.map((file) => file.path)).toEqual([join(root, 'b.txt')])
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('b\n')
  })

  test('撤回第一个文件就没做成：说一个文件都没动，不说做到一半', async () => {
    await writeFile(join(root, 'a.txt'), 'a\n')
    let broken = false
    const space = diskSpace({ root, failOn: () => broken })
    const change = await fileOperations.edit({ files: [{ path: 'a.txt', newText: 'A\n' }] }, space.context)
    broken = true
    const failure = await failureOf(fileOperations.undo({ changeId: change.changeId }, space.context))
    expect(failure.message).toContain('一个文件都没动')
    expect(failure.message).not.toContain('做到一半')
  })

  test('第一项越界：整批不写，后面那一项也不写', async () => {
    await writeFile(join(root, 'k.pem'), 'k\n')
    const space = diskSpace({ root, clamp: true })
    const failure = await failureOf(fileOperations.edit({ files: [{ path: '/etc/hosts', newText: 'x' }, { path: 'k.pem', newText: 'y\n' }] }, space.context))
    expect(failure.code).toBe(FileErrorCodes.editDenied)
    expect(space.commits).toEqual([])
    expect(await readFile(join(root, 'k.pem'), 'utf8')).toBe('k\n')
  })

  test('写出去超过 20 MB 的不写：那样的文件之后读不了也改不了', async () => {
    const space = diskSpace({ root })
    const failure = await failureOf(fileOperations.edit({ files: [{ path: 'huge.txt', newText: 'x'.repeat(FileLimits.fileBytes + 1) }] }, space.context))
    expect(failure.code).toBe(FileErrorCodes.editUnresolved)
    expect(failure.message).toContain('超过')
    expect(space.commits).toEqual([])
  })
})

describe('媒体类型与印记：utils/text-file.ts', () => {
  test('按文件头认出 PNG、JPEG、GIF、WebP 与 PDF，别的不认', () => {
    expect(detectMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toEqual({ kind: 'image', mediaType: 'image/png' })
    expect(detectMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xdb]))).toEqual({ kind: 'image', mediaType: 'image/jpeg' })
    expect(detectMediaType(Buffer.from('GIF89a\x01\x00', 'latin1'))).toEqual({ kind: 'image', mediaType: 'image/gif' })
    const webp = Buffer.alloc(16)
    webp.write('RIFF', 0, 'ascii')
    webp.write('WEBPVP8 ', 8, 'ascii')
    expect(detectMediaType(webp)).toEqual({ kind: 'image', mediaType: 'image/webp' })
    expect(detectMediaType(Buffer.from('%PDF-1.7\n'))).toEqual({ kind: 'document', mediaType: 'application/pdf' })
    const riffWave = Buffer.alloc(16)
    riffWave.write('RIFF', 0, 'ascii')
    riffWave.write('WAVE', 8, 'ascii')
    for (const other of [Buffer.alloc(0), Buffer.from('plain text\n'), Buffer.from([0x89, 0x50]), riffWave]) expect(detectMediaType(other)).toBeNull()
  })

  test('印记只替大文件作证：两边都在、完全相同、且超过重读的阈值才算没变', () => {
    const big = FileTuning.io.alwaysRehashBytes + 1
    expect(stampProvesUnchanged({ mtimeMs: 1, size: big }, { mtimeMs: 1, size: big })).toBe(true)
    expect(stampProvesUnchanged({ mtimeMs: 1, size: FileTuning.io.alwaysRehashBytes }, { mtimeMs: 1, size: FileTuning.io.alwaysRehashBytes })).toBe(false)
    expect(stampProvesUnchanged({ mtimeMs: 1, size: big }, { mtimeMs: 2, size: big })).toBe(false)
    expect(stampProvesUnchanged({ mtimeMs: 1, size: big }, { mtimeMs: 1, size: big + 1 })).toBe(false)
    expect(stampProvesUnchanged(null, { mtimeMs: 1, size: big })).toBe(false)
    expect(stampProvesUnchanged({ mtimeMs: 1, size: big }, null)).toBe(false)
  })
})
