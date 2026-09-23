/**
 * 代码模版是给模型看的日常用法示例：只过类型检查不够，结果取错一个键、写法跑不通，模型照着写就跟着错。
 * 这里把模版的每个函数接在真的临时工作区上，经真的代码面会话调一遍——和模型交程序是同一条路。
 * 外部转换器由空间端口替身扮演（像 LibreOffice、tectonic 那样在输出目录里产出 PDF），MarkItDown 当作没装，走模版里的退路。
 */
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { VelarOfficeModule } from '../index.js'
import type { OfficeHarness } from '../spec/support.js'
import {
  createHarness,
  officeSpace,
  pdfWithPages,
  putFile,
  runModelProgram,
} from '../spec/support.js'

const harnesses: OfficeHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
})

describe('代码模版', () => {
  test('每个函数照写法跑通：写 Word、追加、做演示文稿与表格、读 PDF、PDF 变 Word、导出 PDF、编 LaTeX、剪 PDF、预览、转 Markdown', async () => {
    const harness = await createHarness({
      availableCommands: ['soffice', 'tectonic'],
      converters: 'working',
    })
    harnesses.push(harness)
    await putFile(
      harness.root,
      'papers/paper.pdf',
      await pdfWithPages(['first page text', 'second page text', 'third page text'])
    )
    await putFile(harness.root, 'docs/manual.pdf', await pdfWithPages(['manual text']))

    const outcome = await runModelProgram(
      officeSpace(harness.context),
      `${VelarOfficeModule.template}
export const reportPath = await report()
export const word = await structuredWord()
export const appended = await appendToWord()
export const slides = await deck()
export const sheet = await table()
export const pages = await readPages()
export const converted = await pdfToWord()
export const exported = await exportPdf()
export const compiled = await compileLatex()
export const excerpt = await excerptPdf()
export const checked = await check()
export const markdown = await asMarkdown()
`,
      180_000
    )
    expect(outcome.failed).toBeUndefined()
    const values = outcome.value as Record<string, any>
    expect(values.reportPath).toBe(join(harness.root, 'reports/weekly.docx'))
    expect(values.word).toMatchObject({ path: join(harness.root, 'docs/spec.docx'), created: true })
    expect(values.appended).toMatchObject({
      path: join(harness.root, 'reports/weekly.docx'),
      created: false,
    })
    expect(values.slides).toMatchObject({
      path: join(harness.root, 'slides/review.pptx'),
      created: true,
    })
    expect(values.sheet).toMatchObject({
      path: join(harness.root, 'data/sales.xlsx'),
      created: true,
    })
    expect(values.pages).toEqual({ pageCount: 3, firstPage: 'first page text', hasMore: true })
    expect(values.converted).toMatchObject({
      path: join(harness.root, 'papers/paper.docx'),
      created: true,
    })
    expect(values.exported).toMatchObject({
      path: join(harness.root, 'reports/weekly.pdf'),
      created: true,
    })
    expect(values.compiled).toEqual({
      pdf: join(harness.root, 'papers/formula.pdf'),
      tex: join(harness.root, 'papers/formula.tex'),
      compiler: 'tectonic',
    })
    expect(values.excerpt).toMatchObject({
      path: join(harness.root, 'papers/excerpt.pdf'),
      created: true,
    })
    expect(values.checked).toMatchObject({
      title: '季度回顾',
      summary: { slides: 2 },
      slides: ['季度回顾', '下季度计划'],
    })
    expect(values.markdown).toEqual({ truncated: false, head: 'manual text' })
  }, 240_000)
})
