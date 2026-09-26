/** 文件能力的实现细节测试：对外承诺在 spec/acceptance.test.ts，这里补行的拆分与取段、按原文换一段、一步的形状与底稿、改动账、一批的小工具、特殊文件、媒体类型这些边角。 */

import { spawnSync } from 'node:child_process'
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { FileChanges } from '../impl/FileChanges'
import { FileErrorCodes, FileLimits, fileOperations } from '../index'
import { diskSpace, failureOf } from '../spec/support'
import type { FileEditDraft, FileEditPlan } from '../types/edit'
import {
  batchItems,
  commitFailure,
  unresolvedEditFailure,
  withLinkTarget,
  writeOfPlan,
} from '../utils/batch'
import { lineCount, lineSpan, splitLines, toFileNewlines, windowText } from '../utils/lines'
import { fileIdentity } from '../utils/paths'
import { applyStep, finishDraft, parseStep } from '../utils/plan'
import { replaceOnce } from '../utils/replace'
import { detectMediaType, fileVersionOf, stampProvesUnchanged } from '../utils/text-file'
import { FileTuning } from '../utils/tuning'

let root = ''
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-files-impl-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 在一段正文上换一段，应当换得成：交回换好的正文（换行风格照这段正文为主的那种）。 */
function replaced(content: string, oldText: string, newText: string): string {
  const result = replaceOnce(content, splitLines(content).eol, oldText, newText)
  if ('problem' in result) throw new Error(`应当换得成，却被拒：${result.problem}`)
  return result.content
}

/** 在一段正文上换一段，应当被拒：交回那句说明。 */
function refused(content: string, oldText: string): string {
  const result = replaceOnce(content, splitLines(content).eol, oldText, 'x')
  if ('content' in result) throw new Error(`应当被拒，却换成了 ${JSON.stringify(result.content)}`)
  return result.problem
}

/** 一份底稿：缺省是一个还没写过的新文件。 */
function draftOf(overrides: Partial<FileEditDraft> = {}): FileEditDraft {
  return {
    step: 0,
    location: { path: 'a.txt', target: '/space/a.txt', linked: false },
    original: null,
    stamp: null,
    content: null,
    eol: '\n',
    ...overrides,
  }
}

/** 一个已有文件的底稿：原文按 UTF-8 读进来，还没改过，换行风格照它。 */
function existingDraft(content: string): FileEditDraft {
  return draftOf({
    original: { buffer: Buffer.from(content), content, encoding: 'utf8' },
    stamp: { mtimeMs: 1, size: Buffer.byteLength(content) },
    content,
    eol: splitLines(content).eol,
  })
}

/** 一份写入计划：缺省是一个已有的小文件，原文留着。 */
function planOf(overrides: Partial<FileEditPlan> = {}): FileEditPlan {
  return {
    step: 0,
    path: 'a.txt',
    target: '/space/a.txt',
    linked: false,
    created: false,
    previous: Buffer.from('old\n'),
    bytes: Buffer.from('new\n'),
    totalLines: 1,
    baseVersion: 'v-old',
    stamp: { mtimeMs: 1, size: 4 },
    ...overrides,
  }
}

describe('行：拆开、数行、取一段', () => {
  test('\\n 与 \\r\\n 都算换行，行文本不带换行符；结尾的换行不多出一行，最后一行没换行也算一行；单独的 \\r 不算换行', () => {
    const cases: Array<[string, Array<{ text: string; br: string }>]> = [
      ['', []],
      ['a', [{ text: 'a', br: '' }]],
      ['a\n', [{ text: 'a', br: '\n' }]],
      [
        'a\nb',
        [
          { text: 'a', br: '\n' },
          { text: 'b', br: '' },
        ],
      ],
      ['\n', [{ text: '', br: '\n' }]],
      [
        '\n\n',
        [
          { text: '', br: '\n' },
          { text: '', br: '\n' },
        ],
      ],
      ['\r\n', [{ text: '', br: '\r\n' }]],
      [
        'a\r\nb\r\n',
        [
          { text: 'a', br: '\r\n' },
          { text: 'b', br: '\r\n' },
        ],
      ],
      [
        'a\n\r\nb',
        [
          { text: 'a', br: '\n' },
          { text: '', br: '\r\n' },
          { text: 'b', br: '' },
        ],
      ],
      [
        'a\rb\n\r',
        [
          { text: 'a\rb', br: '\n' },
          { text: '\r', br: '' },
        ],
      ],
    ]
    for (const [content, lines] of cases)
      expect(`${JSON.stringify(content)} → ${JSON.stringify(splitLines(content).lines)}`).toBe(
        `${JSON.stringify(content)} → ${JSON.stringify(lines)}`
      )
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
    expect(['', 'a', 'a\n', 'a\nb', 'a\nb\n', '\n', '\n\n', 'a\r\nb\r\n'].map(lineCount)).toEqual([
      0, 1, 1, 2, 2, 1, 2, 2,
    ])
  })

  test('取一段连续的正文：行与行之间是 \\n，末行超过文件行数就到最后一行为止；读到了最后一行、文件又以换行结尾时带上结尾的换行', () => {
    const text = splitLines('a\nb\nc\n')
    expect(windowText(text, 1, 3)).toBe('a\nb\nc\n')
    expect(windowText(text, 2, 99)).toBe('b\nc\n')
    expect(windowText(text, 3, 3)).toBe('c\n')
    expect(windowText(text, 1, 1)).toBe('a')
    expect(windowText(text, 1, 2)).toBe('a\nb')
    expect(windowText(text, 4, 5)).toBe('')
    expect(windowText(splitLines('a\nb'), 1, 2)).toBe('a\nb')
    expect(windowText(splitLines('a\nb'), 2, 9)).toBe('b')
    expect(windowText(splitLines('a\r\nb\r\n'), 1, 2)).toBe('a\nb\n')
    expect(windowText(splitLines('a\r\nb\nc'), 1, 3)).toBe('a\nb\nc')
    expect(windowText(splitLines(''), 1, 1)).toBe('')
    // 全是空行：只取第一行是空串，取到最后一行才带上结尾的换行
    expect(windowText(splitLines('\n\n'), 1, 1)).toBe('')
    expect(windowText(splitLines('\n\n'), 2, 2)).toBe('\n')
    expect(windowText(splitLines('\n\n'), 1, 2)).toBe('\n\n')
    // 单独的 \r 不是换行，原样留在正文里
    expect(windowText(splitLines('x\ry\r\n'), 1, 1)).toBe('x\ry\n')
  })

  test('整份取出来再换回文件的换行风格，和原文一字不差（各行换行一致的文件）', () => {
    const whole = (content: string): string => {
      const text = splitLines(content)
      return toFileNewlines(windowText(text, 1, text.lines.length), text.eol)
    }
    for (const content of [
      '',
      'a',
      'a\n',
      'a\nb',
      'a\nb\n',
      '\n\n',
      'tail\n\n',
      'a\r\nb\r\n',
      'a\r\nb',
      '\r\n\r\n',
      'x\ry\r\n',
      '中文\r\n第二行',
    ])
      expect(JSON.stringify(whole(content))).toBe(JSON.stringify(content))
  })

  test('行号与区间：正整数、[n]、[首行, 末行]（末行不小于首行）；其余一律不认', () => {
    expect(lineSpan(3)).toEqual([3, 3])
    expect(lineSpan([3])).toEqual([3, 3])
    expect(lineSpan([2, 5])).toEqual([2, 5])
    expect(lineSpan([4, 4])).toEqual([4, 4])
    const invalid: unknown[] = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      '3',
      null,
      undefined,
      {},
      [],
      [0],
      [3, 2],
      [1, 2, 3],
      ['1', '2'],
      [1, 2.5],
      [0, 2],
    ]
    for (const range of invalid)
      expect(`${JSON.stringify(range)}:${JSON.stringify(lineSpan(range))}`).toBe(
        `${JSON.stringify(range)}:null`
      )
  })

  test('新内容换成文件的换行风格：先把 \\r\\n 统一成 \\n，单独的 \\r 不动', () => {
    expect(toFileNewlines('a\nb\r\nc', '\r\n')).toBe('a\r\nb\r\nc')
    expect(toFileNewlines('a\r\nb\n', '\n')).toBe('a\nb\n')
    expect(toFileNewlines('a\rb\n', '\r\n')).toBe('a\rb\r\n')
    expect(toFileNewlines('', '\r\n')).toBe('')
  })
})

describe('按原文换一段：replaceOnce', () => {
  test('换掉唯一的一段，没换到的地方一个字节都不动；newText 是空串就是删掉，里面的 \\r\\n 先统一成 \\n；单独的 \\r 照原样比', () => {
    expect(replaced('a\nb\nc\n', 'b', 'B')).toBe('a\nB\nc\n')
    expect(replaced('let a = 1', 'a = 1', 'a = 2')).toBe('let a = 2')
    expect(replaced('a\nb\nc\n', 'b\n', '')).toBe('a\nc\n')
    expect(replaced('a\nb\n', 'a', 'x\r\ny')).toBe('x\ny\nb\n')
    expect(replaced('a\rb\nc\n', 'a\rb', 'x')).toBe('x\nc\n')
  })

  test('CRLF 文件按 \\n 比：跨行的一段对得上，oldText 里写 \\r\\n 也行；换进去的新文用 \\r\\n', () => {
    expect(replaced('a\r\nb\r\nc\r\n', 'a\nb', 'A\nB')).toBe('A\r\nB\r\nc\r\n')
    expect(replaced('a\r\nb\r\nc\r\n', 'a\r\nb', 'x')).toBe('x\r\nc\r\n')
    expect(replaced('a\r\nb\r\n', 'b', 'B1\nB2')).toBe('a\r\nB1\r\nB2\r\n')
  })

  test('混合换行：没换到的行留着自己的换行符，被换掉的那段里的换行跟着走，换进去的新文用为主的那种', () => {
    expect(replaced('one\r\ntwo\nthree\r\n', 'three', 'THREE\nfour')).toBe(
      'one\r\ntwo\nTHREE\r\nfour\r\n'
    )
    expect(replaced('one\r\ntwo\nthree\r\n', 'two\nthree', '2\n3')).toBe('one\r\n2\r\n3\r\n')
    expect(replaced('one\ntwo\r\nthree\n', 'one', 'ONE\nnew')).toBe('ONE\nnew\ntwo\r\nthree\n')
  })

  test('段的两头落在 \\r\\n 上：从换行起头的连 \\r 一起换，以换行收尾的整个 \\r\\n 一起换；换掉结尾的换行，文件就不再以换行结尾', () => {
    expect(replaced('a\r\nb\r\n', '\nb', '')).toBe('a\r\n')
    expect(replaced('a\r\nb\r\n', 'a\n', 'A\n')).toBe('A\r\nb\r\n')
    expect(replaced('a\r\nb\r\n', 'b\n', 'b')).toBe('a\r\nb')
    expect(replaced('a\nb\n', 'b\n', 'b')).toBe('a\nb')
    expect(replaced('a\nb', '\nb', '')).toBe('a')
  })

  test('出现好几处就不换：说出现了几次、前几处在第几行（CRLF 文件也按行数），更多的写「等」', () => {
    expect(refused('x\ny\nx\n', 'x')).toBe(
      'oldText 在文件里出现了 2 次（第 1、3 行）；多带几行上下文让它只出现一次'
    )
    expect(refused('x\r\ny\r\nx\r\n', 'x')).toContain('出现了 2 次（第 1、3 行）')
    expect(refused('a\nb\nc\na\nb\n', 'a\nb')).toContain('出现了 2 次（第 1、4 行）')
    const shown = FileTuning.replace.shownMatches
    const lines = Array.from({ length: shown }, (_, index) => index + 1).join('、')
    expect(refused('k\n'.repeat(shown), 'k')).toContain(`出现了 ${shown} 次（第 ${lines} 行）`)
    expect(refused('k\n'.repeat(shown + 1), 'k')).toContain(
      `出现了 ${shown + 1} 次（第 ${lines} 行 等）`
    )
    // 同一行的几处只算一行；列满了之后还在列过的那一行上的，不算「等」
    expect(refused('x = x\ny = x\n', 'x')).toContain('出现了 3 次（第 1、2 行）；')
    expect(refused('k k\n'.repeat(shown), 'k')).toContain(
      `出现了 ${shown * 2} 次（第 ${lines} 行）；`
    )
  })

  test('一处都没有就不换：拿 oldText 第一行有内容的去找最像的行，去掉首尾空白后相同的优先，其次是包含它的，列的行数与每行长短有上限；一行都不像就说先 read', () => {
    expect(refused('  port = 80\n', 'port = 80\nhost = a')).toBe(
      'oldText 在文件里没有一模一样的原文，最像的是第 1 行「port = 80」；照那里的原文写 oldText（空白、引号、换行都要一样）'
    )
    // 开头的空行跳过，拿第一行有内容的去找
    expect(refused('a\n  debug=1\n', '\n\n  debug=1 \nzzz')).toContain(
      '最像的是第 2 行「debug=1」；'
    )
    // 有去掉空白后一模一样的行，就不列只是包含它的
    expect(refused('set debug=1\ndebug=1\n', 'debug=1\nzzz')).toContain(
      '最像的是第 2 行「debug=1」；'
    )
    // 只有包含它的：按行号顺序列，列到上限为止
    const near = FileTuning.replace.nearLines
    const rows = Array.from({ length: near + 1 }, (_, index) => `${index} debug=1`)
    expect(refused(rows.join('\n'), 'debug=1\nzzz')).toContain(
      `最像的是${rows
        .slice(0, near)
        .map((row, index) => `第 ${index + 1} 行「${row}」`)
        .join('、')}；`
    )
    const long = `debug=1 ${'x'.repeat(FileTuning.replace.nearLineChars * 2)}`
    expect(refused(long, 'debug=1\nzzz')).toContain(
      `「${long.slice(0, FileTuning.replace.nearLineChars)}」`
    )
    const nothing =
      'oldText 在文件里没有一模一样的原文，也找不到相近的行；先 read 要改的那一段，照读到的原文写 oldText（空白、引号、换行都要一样）'
    expect(refused('a\nb\n', 'nothing like it')).toBe(nothing)
    expect(refused('a\nb\n', '   \n  ')).toBe(nothing)
    expect(refused('', 'a')).toBe(nothing)
  })
})

describe('一步一步改：utils/plan.ts', () => {
  test('取出一步：合法的只留认得的字段；write 要字符串 text（空串也行），replace 要非空的 oldText 与字符串 newText（空串就是删掉）', () => {
    expect(parseStep({ action: 'write', path: 'a.txt', text: '', version: 'v1' })).toEqual({
      action: 'write',
      path: 'a.txt',
      text: '',
    })
    expect(
      parseStep({ action: 'replace', path: 'a.txt', oldText: 'x', newText: '', text: 'y' })
    ).toEqual({ action: 'replace', path: 'a.txt', oldText: 'x', newText: '' })
  })

  test('一步的形状不对交回一句说明：先看 action，再看 path，再看 text / oldText / newText；旧写法（没有 action）也在这里拦下', () => {
    const action = 'action 要 write（整份写）或 replace（把一段原文换掉），这里给的是'
    expect(parseStep({ action: 'insert', path: 'a.txt', text: 'x' })).toBe(`${action} "insert"`)
    expect(parseStep({ path: 'a.txt', newText: 'x' })).toBe(`${action} undefined`)
    expect(parseStep({ action: 'insert', path: 3 })).toBe(`${action} "insert"`)
    const path = '每一步都要有 path（字符串）'
    for (const missing of [undefined, 3, '', '  '])
      expect(parseStep({ action: 'write', path: missing, text: 'x' })).toBe(path)
    expect(parseStep({ action: 'replace', oldText: '', newText: 'x' })).toBe(path)
    const text = 'write 要 text（字符串）：这个文件的全部新内容'
    expect(parseStep({ action: 'write', path: 'a.txt' })).toBe(text)
    expect(parseStep({ action: 'write', path: 'a.txt', text: 3 })).toBe(text)
    const oldText =
      'replace 要 oldText（非空字符串）：照读到的原文写要换掉的那一段；要整份换掉就用 write'
    expect(parseStep({ action: 'replace', path: 'a.txt', oldText: '', newText: 'x' })).toBe(oldText)
    expect(parseStep({ action: 'replace', path: 'a.txt', newText: 'x' })).toBe(oldText)
    expect(parseStep({ action: 'replace', path: 'a.txt', oldText: 'x' })).toBe(
      'replace 要 newText（字符串）：换上去的新文，删掉就给空串'
    )
  })

  test('新文件的底稿：没写过就 replace 指向用 write 新建；write 照写，之后换进去的新文跟着它自己的换行风格', () => {
    const draft = draftOf()
    expect(applyStep(draft, { action: 'replace', path: 'a.txt', oldText: 'a', newText: 'b' })).toBe(
      '文件不存在：a.txt；新建文件用 write（同一次 edit 里先 write 再 replace 也行）'
    )
    expect(applyStep(draft, { action: 'write', path: 'a.txt', text: 'one\r\ntwo\r\n' })).toBeNull()
    expect([draft.content, draft.eol]).toEqual(['one\r\ntwo\r\n', '\r\n'])
    expect(
      applyStep(draft, { action: 'replace', path: 'a.txt', oldText: 'two', newText: '2\n3' })
    ).toBeNull()
    expect(draft.content).toBe('one\r\n2\r\n3\r\n')
  })

  test('已有文件的底稿：write 按它原来的换行风格存，风格不跟着新内容变；replace 按前一步改完的内容找原文，找不到时底稿不动', () => {
    const draft = existingDraft('a\r\nb\r\n')
    expect(applyStep(draft, { action: 'write', path: 'a.txt', text: 'x\ny\n' })).toBeNull()
    expect([draft.content, draft.eol]).toEqual(['x\r\ny\r\n', '\r\n'])
    expect(
      applyStep(draft, { action: 'replace', path: 'a.txt', oldText: 'a', newText: 'b' })
    ).toContain('没有一模一样的原文')
    expect(draft.content).toBe('x\r\ny\r\n')
    expect(
      applyStep(draft, { action: 'replace', path: 'a.txt', oldText: 'x\ny', newText: 'z' })
    ).toBeNull()
    expect(draft.content).toBe('z\r\n')
  })

  test('底稿编成写入计划：新建的原文记 null、没有版本；已有的留原文与计划时的版本和印记，原文超过 2 MB 就不留', () => {
    expect(finishDraft(draftOf({ content: 'a\nb\n' }))).toEqual({
      step: 0,
      path: 'a.txt',
      target: '/space/a.txt',
      linked: false,
      created: true,
      previous: null,
      bytes: Buffer.from('a\nb\n'),
      totalLines: 2,
      baseVersion: null,
      stamp: null,
    })
    const kept = existingDraft('old\r\n')
    kept.content = 'new\r\nline\r\n'
    expect(finishDraft(kept)).toEqual({
      step: 0,
      path: 'a.txt',
      target: '/space/a.txt',
      linked: false,
      created: false,
      previous: Buffer.from('old\r\n'),
      bytes: Buffer.from('new\r\nline\r\n'),
      totalLines: 2,
      baseVersion: fileVersionOf(Buffer.from('old\r\n')),
      stamp: { mtimeMs: 1, size: 5 },
    })
    const big = existingDraft('x'.repeat(FileLimits.undoBytes + 1))
    big.content = 'short\n'
    const plan = finishDraft(big)
    expect(plan).toMatchObject({ created: false, bytes: Buffer.from('short\n') })
    expect(plan).not.toHaveProperty('previous')
  })

  test('写不下去的底稿成了问题，记在第一次碰到这个文件的那一步：带 NUL 的、编不回原编码的、写出去超过 20 MB 的', () => {
    expect(finishDraft(draftOf({ step: 3, content: 'a\0b' }))).toEqual({
      step: 3,
      path: 'a.txt',
      reason: 'invalid',
      message: '新内容里有 NUL 字节，是二进制数据，不能当文本写入',
    })
    const gbk = draftOf({
      original: { buffer: Buffer.from([0xd6, 0xd0]), content: '中', encoding: 'gb18030' },
      content: '中\uD800',
    })
    expect(finishDraft(gbk)).toMatchObject({
      reason: 'invalid',
      message: expect.stringContaining('不能按 gb18030 无损写进这个文件'),
    })
    expect(finishDraft(draftOf({ content: 'x'.repeat(FileLimits.fileBytes + 1) }))).toMatchObject({
      reason: 'invalid',
      message: expect.stringContaining(`超过 ${FileLimits.fileBytes} 字节的上限`),
    })
  })
})

describe('改动账：FileChanges', () => {
  /** 一次改动里的一个文件。 */
  const entry = (path: string, before: Buffer | null | undefined) => ({
    path,
    target: `/space/${path}`,
    linked: false,
    before,
    after: `after-${path}`,
  })

  test('记一次交回号，按号取回；号每次都不一样；撤回过的记着撤回过', () => {
    const changes = new FileChanges()
    const first = changes.record([entry('a.txt', Buffer.from('a')), entry('new.txt', null)])
    const second = changes.record([entry('a.txt', Buffer.from('b'))])
    expect(first.changeId).not.toBe(second.changeId)
    expect(changes.recall(first.changeId)).toMatchObject({
      undoable: true,
      undone: false,
      bytes: 1,
      entries: [{ path: 'a.txt' }, { path: 'new.txt', before: null }],
    })
    changes.markUndone(first.changeId)
    expect(changes.recall(first.changeId)?.undone).toBe(true)
    expect(changes.recall(second.changeId)?.undone).toBe(false)
    expect(changes.recall('change-0-nothing')).toBeNull()
    changes.markUndone('change-0-nothing')
  })

  test('有文件的原文没留下来（缺席）这次改动就撤不回；新建的（null）不影响', () => {
    const changes = new FileChanges()
    expect(changes.record([entry('new.txt', null)]).undoable).toBe(true)
    expect(
      changes.record([entry('a.txt', Buffer.from('a')), entry('big.log', undefined)]).undoable
    ).toBe(false)
  })

  test(`只留最近 ${FileLimits.undoChanges} 次：多出来的从最早的丢起`, () => {
    const changes = new FileChanges()
    const ids = Array.from(
      { length: FileLimits.undoChanges + 2 },
      (_, index) => changes.record([entry(`${index}.txt`, Buffer.from('x'))]).changeId
    )
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
    expect([small, first, second].map((id) => changes.recall(id) !== null)).toEqual([
      false,
      true,
      true,
    ])
    const huge = changes.record([
      entry('c.bin', Buffer.alloc(FileTuning.changes.totalBytes + 1)),
    ]).changeId
    expect([first, second, huge].map((id) => changes.recall(id) !== null)).toEqual([
      false,
      false,
      true,
    ])
    // 撤不回的（原文缺席）不占预算
    const cheap = changes.record([entry('d.bin', undefined)]).changeId
    expect([huge, cheap].map((id) => changes.recall(id) !== null)).toEqual([false, true])
  })
})

describe('一批的小工具：utils/batch.ts', () => {
  test('取一批：files / steps 要是非空数组、每项是对象、不超过上限；说明里点名缺的是哪个键、例子怎么写', () => {
    const refusal = (run: () => unknown): string => {
      try {
        run()
      } catch (error) {
        return error instanceof AppError ? `${error.code} ${error.message}` : String(error)
      }
      return '没有拦住'
    }
    expect(refusal(() => batchItems(undefined, 20, 'read'))).toBe(
      'VALIDATION 缺少 files：read 要 { files: [...] }，每个文件一项'
    )
    expect(refusal(() => batchItems({ files: [{}] }, 20, 'edit'))).toBe(
      'VALIDATION 缺少 steps：edit 要 { steps: [...] }，每步一项'
    )
    expect(refusal(() => batchItems({ steps: [] }, 20, 'edit'))).toBe(
      'VALIDATION steps 是空的；至少给一项'
    )
    expect(refusal(() => batchItems({ steps: [{}, {}] }, 1, 'edit'))).toBe(
      'VALIDATION edit 一次最多 1 步，这里给了 2 步；分几次调用'
    )
    expect(refusal(() => batchItems({ files: [{}, {}, {}] }, 2, 'read'))).toBe(
      'VALIDATION read 一次最多 2 个文件，这里给了 3 个文件；分几次调用'
    )
    expect(refusal(() => batchItems({ steps: ['a.txt'] }, 20, 'edit'))).toBe(
      "VALIDATION edit 的 steps 每一项都要是对象，例如 { action: 'write', path: 'a.txt', text: '...' }"
    )
    const steps = [{ action: 'write' }]
    expect(batchItems({ steps }, 1, 'edit')).toBe(steps)
  })

  test('落盘时核对什么：留着原文的核对原字节，新建的核对仍不存在，原文没留的不核对（只靠计划后那次印记）', () => {
    expect(writeOfPlan(planOf())).toEqual({
      target: '/space/a.txt',
      bytes: Buffer.from('new\n'),
      expected: { exists: true, bytes: Buffer.from('old\n') },
    })
    expect(writeOfPlan(planOf({ previous: Buffer.alloc(0) }))).toEqual({
      target: '/space/a.txt',
      bytes: Buffer.from('new\n'),
      expected: { exists: true, bytes: Buffer.alloc(0) },
    })
    expect(writeOfPlan(planOf({ created: true, previous: null }))).toEqual({
      target: '/space/a.txt',
      bytes: Buffer.from('new\n'),
      expected: { exists: false },
    })
    expect(writeOfPlan(planOf({ previous: undefined }))).toEqual({
      target: '/space/a.txt',
      bytes: Buffer.from('new\n'),
    })
  })

  test('整次的失败：有一个被拒就是 FILES_EDIT_DENIED，否则 FILES_EDIT_UNRESOLVED；问题按第几步逐条进 message，完整清单进 context', () => {
    const stale = { step: 1, path: 'b.txt', reason: 'stale' as const, message: '被改过' }
    const unresolved = unresolvedEditFailure([
      { step: 0, path: 'a.txt', reason: 'invalid', message: '不是文本' },
      stale,
    ])
    expect(unresolved.code).toBe(FileErrorCodes.editUnresolved)
    expect(unresolved.message).toBe(
      '这次改动一个文件都没写，有 2 个问题。steps[0] a.txt：不是文本；steps[1] b.txt：被改过'
    )
    expect(unresolved.context).toEqual({
      executionOutcome: 'not-applied',
      problems: [{ step: 0, path: 'a.txt', reason: 'invalid', message: '不是文本' }, stale],
    })
    expect(
      unresolvedEditFailure([
        stale,
        { step: 2, path: 'c.pem', reason: 'denied', message: '越出了空间' },
      ]).code
    ).toBe(FileErrorCodes.editDenied)
  })

  test('落盘途中出错：空间点名写进去的换成模型认得的路径，另记成一次改动给出号；撤不回时直说；没点名就是什么都没写', () => {
    const plans = [planOf(), planOf({ step: 1, path: 'b.txt', target: '/space/b.txt' })]
    const recorded: string[][] = []
    const failure = new AppError('PLATFORM', '磁盘满了', undefined, { applied: ['/space/a.txt'] })
    const partial = commitFailure(failure, plans, (applied) => {
      recorded.push(applied.map((plan) => plan.path))
      return 'change-9-abc'
    })
    expect(partial.code).toBe('PLATFORM')
    expect(partial.message).toBe(
      "这次改动只写进去了一部分——已经写入的：a.txt；出错的原因：磁盘满了。要退回到改之前，就 undo({ changeId: 'change-9-abc' })；不要整次重发，先 read 一遍看现状"
    )
    expect(partial.context).toEqual({ applied: ['a.txt'] })
    expect(recorded).toEqual([['a.txt']])
    expect(commitFailure(failure, plans, () => null).message).toContain(
      '这几个文件改之前太大，没留原文，撤不回'
    )
    const nothing = commitFailure(new AppError('PLATFORM', '磁盘满了'), plans, () => {
      throw new Error('什么都没写时不该记改动')
    })
    expect(nothing.message).toBe('这次改动没有写进去：磁盘满了')
    expect(nothing.context).toEqual({ applied: [] })
  })

  test('路径是符号链接时回执里带上 target，不是就不带这个键', () => {
    expect(
      withLinkTarget<{ path: string; target?: string }>({ path: 'link' }, '/real', true)
    ).toEqual({ path: 'link', target: '/real' })
    expect(
      withLinkTarget<{ path: string; target?: string }>({ path: 'plain' }, '/plain', false)
    ).not.toHaveProperty('target')
  })

  test('认同一个文件的身份键：Windows 与 macOS 不分大小写，Linux 分；Windows 两种分隔符都认', () => {
    expect(fileIdentity('/a/B.txt', 'darwin')).toBe(fileIdentity('/a/b.txt', 'darwin'))
    expect(fileIdentity('/a/./x/../B.txt', 'darwin')).toBe('/a/b.txt')
    expect(fileIdentity('/a/B.txt', 'linux')).not.toBe(fileIdentity('/a/b.txt', 'linux'))
    expect(fileIdentity('C:\\Data\\A.txt', 'win32')).toBe(fileIdentity('c:/data/a.txt', 'win32'))
  })
})

describe('edit：按路径一步一步写', () => {
  test('一个文件出了问题，它后面的几步不再看、不再报；别的文件照样一步一步核对，问题一起报', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), 'a\n')
    await writeFile(join(root, 'b.txt'), 'b\n')
    const failure = await failureOf(
      fileOperations.edit(
        {
          steps: [
            { action: 'replace', path: 'a.txt', oldText: 'missing', newText: 'x' },
            { action: 'replace', path: 'a.txt', oldText: 'also missing', newText: 'y' },
            { action: 'write', path: 'b.txt', text: 'B\n' },
            // 前一步已经把 b 换成了 B：这一步按改完的内容找，找不到
            { action: 'replace', path: 'b.txt', oldText: 'b', newText: 'x' },
            { action: 'replace', path: 'c.txt', oldText: 'c', newText: 'x' },
          ],
        },
        space.context
      )
    )
    expect(failure.message).toContain('有 3 个问题')
    expect(failure.context).toMatchObject({
      problems: [
        { step: 0, path: join(root, 'a.txt') },
        { step: 3, path: join(root, 'b.txt') },
        { step: 4, path: join(root, 'c.txt') },
      ],
    })
    expect(space.commits).toHaveLength(0)
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('b\n')
  })

  test('同一个文件换个写法也是同一个文件：几步接着改，回执里只有一项、只落盘一次', async () => {
    await writeFile(join(root, 'a.pem'), 'a\n')
    const space = diskSpace({ root })
    const result = await fileOperations.edit(
      {
        steps: [
          { action: 'write', path: 'a.pem', text: 'x\n' },
          { action: 'replace', path: './sub/../a.pem', oldText: 'x', newText: 'y' },
          { action: 'replace', path: join(root, 'a.pem'), oldText: 'y', newText: 'z' },
        ],
      },
      space.context
    )
    expect(result.files).toEqual([{ path: join(root, 'a.pem'), created: false, totalLines: 1 }])
    expect(space.commits).toEqual([[expect.objectContaining({ target: join(root, 'a.pem') })]])
    expect(await readFile(join(root, 'a.pem'), 'utf8')).toBe('z\n')
  })

  test('replace 不存在的文件指向用 write 新建；同一次 edit 里先 write 再 replace 就行', async () => {
    const { context } = diskSpace({ root })
    const missing = await failureOf(
      fileOperations.edit(
        { steps: [{ action: 'replace', path: 'nope.txt', oldText: 'a', newText: 'b' }] },
        context
      )
    )
    expect(missing.message).toContain(
      `文件不存在：${join(root, 'nope.txt')}；新建文件用 write（同一次 edit 里先 write 再 replace 也行）`
    )
    await fileOperations.edit(
      {
        steps: [
          { action: 'write', path: 'nope.txt', text: 'a\n' },
          { action: 'replace', path: 'nope.txt', oldText: 'a', newText: 'b' },
        ],
      },
      context
    )
    expect(await readFile(join(root, 'nope.txt'), 'utf8')).toBe('b\n')
  })

  test('edit 回执里的行数就是写进去的那份：CRLF 文件按落盘的内容数', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'crlf.txt'), 'a\r\n')
    const result = await fileOperations.edit(
      { steps: [{ action: 'write', path: 'crlf.txt', text: 'x\ny\nz' }] },
      space.context
    )
    const [file] = (await fileOperations.read({ files: [{ path: 'crlf.txt' }] }, space.context))
      .files
    expect(result.files[0]?.totalLines).toBe(3)
    expect(file && 'totalLines' in file ? file.totalLines : 0).toBe(3)
    expect(await readFile(join(root, 'crlf.txt'), 'utf8')).toBe('x\r\ny\r\nz')
  })
})

describe('读写的边角', () => {
  test('UTF-16 解码后正文里的换行是 \\n，编码照实报', async () => {
    await writeFile(
      join(root, 'utf16.txt'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\r\nb', 'utf16le')])
    )
    const [file] = (
      await fileOperations.read({ files: [{ path: 'utf16.txt' }] }, diskSpace({ root }).context)
    ).files
    expect(file).toMatchObject({ encoding: 'utf16le', totalLines: 2, startLine: 1, text: 'a\nb' })
  })

  test('目录、其他二进制、设备文件、不存在的文件都算失败；全部失败时整个调用抛第一个失败', async () => {
    const { context } = diskSpace({ root })
    await writeFile(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]))
    const paths = [
      '.',
      'blob.bin',
      'missing.txt',
      ...(process.platform === 'win32' ? [] : ['/dev/null']),
    ]
    const failures = await Promise.all(
      paths.map((path) => failureOf(fileOperations.read({ files: [{ path }] }, context)))
    )
    expect(failures.map((failure) => `${failure.code} ${failure.message}`)).toEqual([
      expect.stringMatching(/^VALIDATION 路径是目录/),
      expect.stringMatching(/^VALIDATION 文件是二进制的/),
      expect.stringMatching(/^NOT_FOUND 文件不存在/),
      ...(process.platform === 'win32'
        ? []
        : [expect.stringMatching(/^VALIDATION 路径不是普通文件/)]),
    ])
    const all = await failureOf(
      fileOperations.read({ files: paths.map((path) => ({ path })) }, context)
    )
    expect(all.message).toContain('路径是目录')
  })

  test('预算用完之后的文件不定位、不读盘，那一项是失败条目', async () => {
    await writeFile(join(root, 'big.txt'), 'a'.repeat(FileLimits.readChars))
    await writeFile(join(root, 'note.txt'), 'here')
    const space = diskSpace({ root })
    const budget = await fileOperations.read(
      { files: [{ path: 'big.txt' }, { path: 'note.txt' }] },
      space.context
    )
    expect(budget.files[1]).toEqual({
      path: 'note.txt',
      error: { code: 'VALIDATION', message: expect.stringContaining('预算已被前面的文件用完') },
    })
    expect(space.located).toEqual(['big.txt'])
  }, 30_000)

  test('读越界只是那一项失败；只有这一项时整个调用报出拒绝原因', async () => {
    await writeFile(join(root, 'note.txt'), 'here')
    const space = diskSpace({ root, clamp: true })
    const refusedRead = await fileOperations.read(
      { files: [{ path: 'note.txt' }, { path: '/etc/hosts' }] },
      space.context
    )
    expect(
      refusedRead.files.map((entry) => ('error' in entry ? entry.error.code : entry.text))
    ).toEqual(['here', 'PERMISSION'])
    await expect(
      fileOperations.read({ files: [{ path: '/etc/hosts' }] }, space.context)
    ).rejects.toThrow('在这个空间之外')
  })

  test.skipIf(process.platform === 'win32')(
    '已有文件的权限位原样保留（整份写、换一段都是），新文件的权限由 umask 定',
    async () => {
      const mask = process.umask(0o077)
      try {
        const { context } = diskSpace({ root })
        await writeFile(join(root, 'shared.sh'), 'echo one\n')
        await chmod(join(root, 'shared.sh'), 0o777)
        await fileOperations.edit(
          { steps: [{ action: 'write', path: 'shared.sh', text: 'echo two\n' }] },
          context
        )
        expect((await stat(join(root, 'shared.sh'))).mode & 0o777).toBe(0o777)
        await fileOperations.edit(
          { steps: [{ action: 'replace', path: 'shared.sh', oldText: 'two', newText: 'three' }] },
          context
        )
        expect((await stat(join(root, 'shared.sh'))).mode & 0o777).toBe(0o777)
        await fileOperations.edit(
          { steps: [{ action: 'write', path: 'fresh.txt', text: 'new\n' }] },
          context
        )
        expect((await stat(join(root, 'fresh.txt'))).mode & 0o777).toBe(0o600)
      } finally {
        process.umask(mask)
      }
    }
  )

  test.skipIf(process.platform === 'win32')(
    '命名管道不当文本改，也不会被换成普通文件',
    async () => {
      const pipe = join(root, 'pipe')
      expect(spawnSync('mkfifo', [pipe]).status).toBe(0)
      const { context } = diskSpace({ root })
      for (const step of [
        { action: 'write' as const, path: 'pipe', text: 'x' },
        { action: 'replace' as const, path: 'pipe', oldText: 'x', newText: 'y' },
      ]) {
        const failure = await failureOf(fileOperations.edit({ steps: [step] }, context))
        expect(failure.message).toContain('不是普通文件')
      }
      expect((await lstat(pipe)).isFIFO()).toBe(true)
    }
  )

  test('多个硬链接的文件不碰；上级路径是文件时在计划期就报出来；路径是目录不当文件改', async () => {
    const { context } = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), 'a\n')
    spawnSync('ln', [join(root, 'a.txt'), join(root, 'b.txt')])
    const messageOf = async (path: string): Promise<string> =>
      (
        await failureOf(
          fileOperations.edit({ steps: [{ action: 'write', path, text: 'x' }] }, context)
        )
      ).message
    expect(await messageOf('a.txt')).toContain('2 个硬链接')
    expect(await messageOf('a.txt/child.txt')).toContain('上级路径不是目录')
    expect(await messageOf('.')).toContain('路径是目录，不是文件')
    expect(
      (
        await failureOf(
          fileOperations.edit(
            { steps: [{ action: 'replace', path: 'b.txt', oldText: 'a', newText: 'x' }] },
            context
          )
        )
      ).message
    ).toContain('2 个硬链接')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('a\n')
  })
})

describe('这一轮修的几处', () => {
  test('GB18030 换一段：没换到的地方沿用原字节（同一个字的另一种写法不被改写）', async () => {
    // 0x80 在 GB18030 里解成 €，重新编码却写成 A2 E3：没换到的第一行必须原样留着 0x80。
    await writeFile(join(root, 'gb.txt'), Buffer.from([0x80, 0x0a, 0x61, 0x0a]))
    const space = diskSpace({ root })
    const [file] = (await fileOperations.read({ files: [{ path: 'gb.txt' }] }, space.context)).files
    if (!file || 'error' in file) throw new Error('应当读得到')
    expect(file.encoding).toBe('gb18030')
    await fileOperations.edit(
      { steps: [{ action: 'replace', path: 'gb.txt', oldText: 'a', newText: 'b' }] },
      space.context
    )
    expect([...(await readFile(join(root, 'gb.txt')))]).toEqual([0x80, 0x0a, 0x62, 0x0a])
  })

  test('撤回做到一半出错：点名已经退回去的；再撤一次接着撤剩下的，不算冲突', async () => {
    await writeFile(join(root, 'a.txt'), 'a\n')
    await writeFile(join(root, 'b.txt'), 'b\n')
    let broken = false
    const space = diskSpace({ root, failOn: (target) => broken && target.endsWith('b.txt') })
    const change = await fileOperations.edit(
      {
        steps: [
          { action: 'write', path: 'a.txt', text: 'A\n' },
          { action: 'write', path: 'b.txt', text: 'B\n' },
        ],
      },
      space.context
    )
    broken = true
    const failure = await failureOf(
      fileOperations.undo({ changeId: change.changeId }, space.context)
    )
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
    const change = await fileOperations.edit(
      { steps: [{ action: 'write', path: 'a.txt', text: 'A\n' }] },
      space.context
    )
    broken = true
    const failure = await failureOf(
      fileOperations.undo({ changeId: change.changeId }, space.context)
    )
    expect(failure.message).toContain('一个文件都没动')
    expect(failure.message).not.toContain('做到一半')
  })

  test('第一步越界：整次不写，后面那一步也不写', async () => {
    await writeFile(join(root, 'k.pem'), 'k\n')
    const space = diskSpace({ root, clamp: true })
    const failure = await failureOf(
      fileOperations.edit(
        {
          steps: [
            { action: 'write', path: '/etc/hosts', text: 'x' },
            { action: 'write', path: 'k.pem', text: 'y\n' },
          ],
        },
        space.context
      )
    )
    expect(failure.code).toBe(FileErrorCodes.editDenied)
    expect(space.commits).toEqual([])
    expect(await readFile(join(root, 'k.pem'), 'utf8')).toBe('k\n')
  })

  test('写出去超过 20 MB 的不写：那样的文件之后读不了也改不了', async () => {
    const space = diskSpace({ root })
    const failure = await failureOf(
      fileOperations.edit(
        {
          steps: [
            { action: 'write', path: 'huge.txt', text: 'x'.repeat(FileLimits.fileBytes + 1) },
          ],
        },
        space.context
      )
    )
    expect(failure.code).toBe(FileErrorCodes.editUnresolved)
    expect(failure.message).toContain('超过')
    expect(space.commits).toEqual([])
  })
})

describe('媒体类型与印记：utils/text-file.ts', () => {
  test('按文件头认出 PNG、JPEG、GIF、WebP 与 PDF，别的不认', () => {
    expect(
      detectMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))
    ).toEqual({ kind: 'image', mediaType: 'image/png' })
    expect(detectMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xdb]))).toEqual({
      kind: 'image',
      mediaType: 'image/jpeg',
    })
    expect(detectMediaType(Buffer.from('GIF89a\x01\x00', 'latin1'))).toEqual({
      kind: 'image',
      mediaType: 'image/gif',
    })
    const webp = Buffer.alloc(16)
    webp.write('RIFF', 0, 'ascii')
    webp.write('WEBPVP8 ', 8, 'ascii')
    expect(detectMediaType(webp)).toEqual({ kind: 'image', mediaType: 'image/webp' })
    expect(detectMediaType(Buffer.from('%PDF-1.7\n'))).toEqual({
      kind: 'document',
      mediaType: 'application/pdf',
    })
    const riffWave = Buffer.alloc(16)
    riffWave.write('RIFF', 0, 'ascii')
    riffWave.write('WAVE', 8, 'ascii')
    for (const other of [
      Buffer.alloc(0),
      Buffer.from('plain text\n'),
      Buffer.from([0x89, 0x50]),
      riffWave,
    ])
      expect(detectMediaType(other)).toBeNull()
  })

  test('印记只替大文件作证：两边都在、完全相同、且超过重读的阈值才算没变', () => {
    const big = FileTuning.io.alwaysRehashBytes + 1
    expect(stampProvesUnchanged({ mtimeMs: 1, size: big }, { mtimeMs: 1, size: big })).toBe(true)
    expect(
      stampProvesUnchanged(
        { mtimeMs: 1, size: FileTuning.io.alwaysRehashBytes },
        { mtimeMs: 1, size: FileTuning.io.alwaysRehashBytes }
      )
    ).toBe(false)
    expect(stampProvesUnchanged({ mtimeMs: 1, size: big }, { mtimeMs: 2, size: big })).toBe(false)
    expect(stampProvesUnchanged({ mtimeMs: 1, size: big }, { mtimeMs: 1, size: big + 1 })).toBe(
      false
    )
    expect(stampProvesUnchanged(null, { mtimeMs: 1, size: big })).toBe(false)
    expect(stampProvesUnchanged({ mtimeMs: 1, size: big }, null)).toBe(false)
  })
})
