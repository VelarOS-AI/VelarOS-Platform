/**
 * 办公文档单元的不变量验收：`spec/invariants.md` 里每一条「测试」档的检验器。
 * 用例名以 INV-<编号> 开头，`check:module-ownership` 按这个前缀核对登记表与实现对得上。
 * 大多经真的能力端口像模型的程序那样调，入参与回执都过一遍 JSON；落盘在临时工作区里，外部命令由空间端口替身接住。
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  OfficeErrorCodes,
  OfficeInputLimits,
  OfficeMarkdownLimits,
  OfficeMarkItDownInputExtensions,
  OfficePdfLimits,
  OfficePreviewLimits,
  VelarOfficeModule,
} from '../index.js'
import { sanitizePreviewHtml } from '../utils/preview/sanitize.js'
import { OfficeTuning } from '../utils/tuning.js'

import type { OfficeHarness } from './support.js'
import {
  createHarness,
  failureOf,
  OfficeDeclarations,
  officeSpace,
  pdfWithPages,
  putFile,
  readDocumentProperties,
  runModelProgram,
  typecheckTemplate,
} from './support.js'

const harnesses: OfficeHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
})

/** 造一个工作区与挂着 `velaros:office` 的空间，测完自动删。 */
async function workspace(options: Parameters<typeof createHarness>[0] = {}) {
  const harness = await createHarness(options)
  harnesses.push(harness)
  return { harness, office: officeSpace(harness.context) }
}

describe('办公文档不变量验收', () => {
  test('INV-1 读写目标按真实路径都在工作区根内', async () => {
    const { office } = await workspace()
    expect(
      await failureOf(
        office.call('createSpreadsheet', { outputPath: '../escaped.xlsx', content: 'a,b\n1,2' })
      )
    ).toMatchObject({
      code: OfficeErrorCodes.pathOutsideProject,
    })
    expect(await failureOf(office.call('readPdf', { inputPath: '../outside.pdf' }))).toMatchObject({
      code: OfficeErrorCodes.pathOutsideProject,
    })
  })

  test('INV-2 入参里没有换执行目录的字段，多给了当场拒绝', async () => {
    for (const field of ['cwd', 'workingDirectory', 'rootPath'])
      expect(OfficeDeclarations).not.toContain(`${field}?:`)
    const { harness, office } = await workspace()
    const failure = await failureOf(
      office.call('createSpreadsheet', {
        outputPath: 'book.xlsx',
        content: 'a,b\n1,2',
        cwd: '/tmp',
      })
    )
    expect(failure.code).toBe('VALIDATION')
    expect(failure.message).toContain('cwd')
    await expect(stat(join(harness.root, 'book.xlsx'))).rejects.toBeDefined()
  })

  test('INV-4 已存在的文件不带 overwrite 不覆盖，Word 追加是例外', async () => {
    const { harness, office } = await workspace()
    await office.call('createSpreadsheet', { outputPath: 'book.xlsx', content: 'a,b\n1,2' })
    const before = await readFile(join(harness.root, 'book.xlsx'))

    expect(
      await failureOf(
        office.call('createSpreadsheet', { outputPath: 'book.xlsx', content: 'a,b\n3,4' })
      )
    ).toMatchObject({
      code: OfficeErrorCodes.outputExists,
    })
    expect(await readFile(join(harness.root, 'book.xlsx'))).toEqual(before)
    expect(
      await office.call('createSpreadsheet', {
        outputPath: 'book.xlsx',
        content: 'a,b\n3,4',
        overwrite: true,
      })
    ).toMatchObject({ created: false })

    await office.call('createWord', { outputPath: 'notes.docx', content: '第一段' })
    expect(
      await office.call('createWord', {
        outputPath: 'notes.docx',
        content: '第二段',
        appendMode: true,
      })
    ).toMatchObject({ created: false })
  })

  test('INV-5 外部转换器只经空间端口按原生 argv 执行', async () => {
    const { harness, office } = await workspace({
      availableCommands: ['soffice'],
      converters: 'working',
    })
    await office.call('createWord', { outputPath: 'source.docx', content: '正文' })
    const written = await office.call('wordToPdf', {
      inputPath: 'source.docx',
      outputPath: 'source.pdf',
    })
    expect(written).toMatchObject({ path: join(harness.root, 'source.pdf'), created: true })

    expect(harness.commands.length).toBeGreaterThan(0)
    for (const command of harness.commands) {
      expect(Array.isArray(command.args)).toBe(true)
      // 拼 shell 串的标志：可执行文件名里带空格或 shell 元字符。
      expect(command.file).not.toMatch(/[\s|&;><]/u)
    }
  })

  test('INV-7 预览 HTML 经白名单净化', async () => {
    expect(
      sanitizePreviewHtml('<p onclick="alert(1)">正文<script>alert(2)</script></p>')
    ).not.toMatch(/script|onclick/iu)

    const { harness, office } = await workspace()
    await office.call('createWord', {
      outputPath: 'doc.docx',
      content: '<script>alert(3)</script> 正文',
    })
    await office.call('preview', { inputPath: 'doc.docx', outputPath: 'preview.html' })
    const html = await readFile(join(harness.root, 'preview.html'), 'utf8')
    expect(html).not.toMatch(/<script/iu)
    expect(html).not.toMatch(/\son[a-z]+=/iu)
  })

  test('INV-8 预览缺省不写自动刷新脚本', async () => {
    const { harness, office } = await workspace()
    await office.call('createWord', { outputPath: 'doc.docx', content: '正文' })
    await office.call('preview', { inputPath: 'doc.docx', outputPath: 'quiet.html' })
    expect(await readFile(join(harness.root, 'quiet.html'), 'utf8')).not.toContain(
      'location.reload'
    )
    await office.call('preview', {
      inputPath: 'doc.docx',
      outputPath: 'live.html',
      autoRefresh: true,
    })
    expect(await readFile(join(harness.root, 'live.html'), 'utf8')).toContain('location.reload')
  })

  test('INV-9 生成的文档不带产品名', async () => {
    const { harness, office } = await workspace()
    await office.call('createWord', { outputPath: 'doc.docx', content: '正文' })
    await office.call('createSpreadsheet', { outputPath: 'book.xlsx', content: 'a,b\n1,2' })
    await office.call('createPresentation', { outputPath: 'deck.pptx', content: '# 第一页\n正文' })
    for (const name of ['doc.docx', 'book.xlsx', 'deck.pptx']) {
      const properties = await readDocumentProperties(join(harness.root, name))
      expect(`${name}:${/velaros/iu.test(properties)}`).toBe(`${name}:false`)
    }
  })

  test('INV-10 截断如实标记：摘要报文档里的真实数量', async () => {
    const { office } = await workspace()
    await office.call('createPresentation', {
      outputPath: 'deck.pptx',
      content: ['# 一\n正文', '# 二\n正文', '# 三\n正文', '# 四\n正文', '# 五\n正文'].join('\n'),
    })
    const preview = await office.call('preview', { inputPath: 'deck.pptx', maxItems: 2 })
    expect(preview.summary).toMatchObject({ slides: 5, previewedSlides: 2 })
    expect(preview.slides).toHaveLength(2)
  })

  test('INV-13 缺转换器与转换失败抛带专属码的错误，message 说清缺什么、日志的结尾', async () => {
    const missing = await workspace()
    await missing.office.call('createWord', { outputPath: 'doc.docx', content: '正文' })
    const noLibreOffice = await failureOf(
      missing.office.call('wordToPdf', { inputPath: 'doc.docx', outputPath: 'doc.pdf' })
    )
    expect(noLibreOffice.code).toBe(OfficeErrorCodes.converterMissing)
    expect(noLibreOffice.message).toContain('LibreOffice')
    expect(noLibreOffice.message).toContain('不要自己去装')
    expect(
      await failureOf(
        missing.office.call('latexToPdf', {
          outputPath: 'paper.pdf',
          latexSource: '\\documentclass{article}',
        })
      )
    ).toMatchObject({
      code: OfficeErrorCodes.converterMissing,
    })
    await putFile(missing.harness.root, 'note.md', '# 标题')
    expect(
      await failureOf(missing.office.call('toMarkdown', { inputPath: 'note.md' }))
    ).toMatchObject({ code: OfficeErrorCodes.markItDownUnavailable })

    const failing = await workspace({ availableCommands: ['tectonic'], converters: 'failing' })
    const compileError = await failureOf(
      failing.office.call('latexToPdf', {
        outputPath: 'paper.pdf',
        latexSource: '\\documentclass{article}\n\\badmacro',
      })
    )
    expect(compileError.code).toBe(OfficeErrorCodes.conversionFailed)
    expect(compileError.message).toContain('Undefined control sequence')
    expect(await readFile(join(failing.harness.root, 'paper.tex'), 'utf8')).toContain('\\badmacro')
  })

  test('INV-14 入参在做事之前核对，不合法一步都不做', async () => {
    const { harness, office } = await workspace({
      availableCommands: ['soffice', 'tectonic'],
      converters: 'working',
    })
    const neither = await failureOf(office.call('createWord', { outputPath: 'a.docx' }))
    expect(neither.code).toBe('VALIDATION')
    expect(neither.message).toContain('content')
    expect(
      (
        await failureOf(
          office.call('createWord', {
            outputPath: 'b.docx',
            content: '正文',
            blocks: [{ kind: 'pageBreak' }],
          })
        )
      ).code
    ).toBe('VALIDATION')
    expect(
      (await failureOf(office.call('readPdf', { inputPath: 'x.pdf', pages: [1], maxPages: 2 })))
        .code
    ).toBe('VALIDATION')
    expect(
      (
        await failureOf(
          office.call('latexToPdf', {
            outputPath: 'c.pdf',
            latexSource: 'x',
            runs: OfficePdfLimits.compileRuns + 1,
          })
        )
      ).code
    ).toBe('VALIDATION')
    const tooLong = await failureOf(
      office.call('createWord', {
        outputPath: 'd.docx',
        title: 'x'.repeat(OfficeInputLimits.titleChars + 1),
        content: '正文',
      })
    )
    expect(tooLong.code).toBe('VALIDATION')
    expect(tooLong.message).toContain('title')
    await putFile(harness.root, 'paper.pdf', await pdfWithPages(['page']))
    const cjkStamp = await failureOf(
      office.call('editPdf', {
        inputPath: 'paper.pdf',
        outputPath: 'e.pdf',
        textStamps: [{ text: 'OK' }, { text: '内部资料' }],
      })
    )
    expect(cjkStamp.code).toBe('VALIDATION')
    expect(cjkStamp.message).toContain('textStamps[1].text')
    expect(harness.commands).toEqual([])
    for (const name of ['a.docx', 'b.docx', 'c.pdf', 'c.tex', 'd.docx', 'e.pdf'])
      await expect(stat(join(harness.root, name))).rejects.toBeDefined()
  })

  test('INV-15 模型面是 velaros:office：声明从源码生成，模型的程序照它调到真实操作', async () => {
    expect(VelarOfficeModule.specifier).toBe('velaros:office')
    expect([...VelarOfficeModule.methods].sort()).toEqual(
      [
        'createPresentation',
        'createSpreadsheet',
        'createWord',
        'editPdf',
        'latexToPdf',
        'preview',
        'readPdf',
        'toMarkdown',
        'wordToPdf',
      ].sort()
    )
    expect(VelarOfficeModule.declarations).toBe(OfficeDeclarations)
    for (const hidden of [
      'OfficeOperationContext',
      'OfficeSpacePort',
      'prepareMutation',
      'pdfToWord',
      'convertPdfToWord',
    ])
      expect(OfficeDeclarations).not.toContain(hidden)

    const { harness, office } = await workspace()
    await putFile(
      harness.root,
      'paper.pdf',
      await pdfWithPages(['first page text', 'second page text'])
    )
    const result = await runModelProgram(
      office,
      `import { createWord, readPdf } from 'velaros:office'
const pdf = await readPdf({ inputPath: 'paper.pdf' })
const written = await createWord({ outputPath: 'paper.docx', blocks: pdf.pages.map((page) => ({ kind: 'paragraph', text: page.text })) })
export const pages = pdf.pageCount
export const bytes = written.bytes
`
    )
    expect(result.failed).toBeUndefined()
    expect(result.value).toMatchObject({ pages: 2 })
    expect((result.value as { bytes: number }).bytes).toBeGreaterThan(0)
  }, 120_000)

  test('INV-16 声明里写给模型的数字就是常量表里的', () => {
    const expected = [
      `最多 ${OfficeInputLimits.pathChars} 个字符`,
      `title 最多 ${OfficeInputLimits.titleChars} 个字符`,
      `author 最多 ${OfficeInputLimits.shortFieldChars} 个字符`,
      `最多 ${OfficeInputLimits.word.blocks} 块`,
      `摘要，最多 ${OfficeInputLimits.word.abstractChars} 个字符`,
      `最多 ${OfficeInputLimits.keywords} 个，每个最多 ${OfficeInputLimits.tinyFieldChars} 个字符`,
      `最多 ${OfficeInputLimits.presentation.slides} 页，每页最多 ${OfficeInputLimits.presentation.elements} 个元素`,
      `最多 ${OfficeInputLimits.spreadsheet.sheets} 张`,
      `name 最多 ${OfficeInputLimits.spreadsheet.sheetNameChars} 个字符`,
      `最多 ${OfficeInputLimits.spreadsheet.rows} 行、每行最多 ${OfficeInputLimits.spreadsheet.columns} 格`,
      `从 1 起，最多 ${OfficePdfLimits.readPages} 个`,
      `都不给就读前 ${OfficePdfLimits.defaultReadPages} 页`,
      `缺省 ${OfficeTuning.pdf.latexRuns}，最多 ${OfficePdfLimits.compileRuns}`,
      `三个列表各最多 ${OfficePdfLimits.pageList} 项`,
      `最多 ${OfficePdfLimits.textStamps} 条`,
      `text 最多 ${OfficePdfLimits.textStampChars} 个字符`,
      `字号（${OfficePdfLimits.minFontSize} 到 ${OfficePdfLimits.maxFontSize}`,
      `缺省 ${OfficeTuning.preview.items}，最多 ${OfficePreviewLimits.maxItems}`,
      `缺省 ${OfficeTuning.markdown.returnChars}，${OfficeMarkdownLimits.minReturnChars} 到 ${OfficeMarkdownLimits.maxReturnChars}`,
      OfficeMarkItDownInputExtensions.slice(0, -1).join('、'),
    ]
    for (const text of expected) expect(OfficeDeclarations).toContain(text)
  })

  test('INV-17 代码模版照真实声明过类型检查，不嵌进声明', () => {
    const template = VelarOfficeModule.template
    expect(typecheckTemplate(template)).toEqual([])
    expect(template.match(/^import .* from 'velaros:office'$/gmu)).toHaveLength(1)
    expect(OfficeDeclarations).not.toContain('代码模版')
    expect(template).toContain('只是示例')
  })
})
