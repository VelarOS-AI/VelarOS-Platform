/** Word 正文解析：Markdown 与纯文本里的标题、有序列表、项目符号，以及抬头标题不重复。 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import JSZip from 'jszip'

import type { OfficeOperationContext } from '../index.js'
import { officeOperations } from '../index.js'
import { parseWordContentToBlocks, withoutRepeatedTitle } from '../utils/word/content.js'

const createdRoots: string[] = []

afterEach(async () => {
  for (const root of createdRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function createContext(): Promise<{ root: string; ctx: OfficeOperationContext }> {
  const root = await mkdtemp(join(tmpdir(), 'velaros-office-word-'))
  createdRoots.push(root)
  return {
    root,
    ctx: {
      abortSignal: new AbortController().signal,
      office: {
        getRootPath: () => root,
        inspectEnvironment: async () => ({ commands: [] }),
        runCommand: async () => {
          throw new Error('生成 Word 不跑外部命令')
        },
        locateMarkItDown: () => null,
      },
    },
  }
}

/** 块的种类与文字，列表写成 ordered/bullets 加各项。 */
function outline(content: string): string[] {
  return parseWordContentToBlocks(content).map((block) => {
    if (block.kind === 'heading') return `h${block.level ?? 1} ${block.text}`
    if (block.kind === 'bullets')
      return `${block.ordered ? 'ol' : 'ul'} ${block.items.map((item) => (typeof item === 'string' ? item : item.text)).join(' / ')}`
    if (block.kind === 'paragraph') return `p ${block.text}`
    return block.kind
  })
}

describe('Word 正文解析', () => {
  test('用了 # 标题的内容按 Markdown 读：「1. 」开头的行是有序列表，不是标题', () => {
    expect(
      outline(
        '# 季度报告\n\n## 下季度计划\n\n1. 上线自助客服\n2. 低端机性能专项\n\n- 风险一\n- 风险二'
      )
    ).toEqual([
      'h1 季度报告',
      'h2 下季度计划',
      'ol 上线自助客服 / 低端机性能专项',
      'ul 风险一 / 风险二',
    ])
    // 中文常写的「1、」也是编号
    expect(outline('# 计划\n\n1、上线\n2、优化')).toEqual(['h1 计划', 'ol 上线 / 优化'])
  })

  test('有序列表项之间隔着空行仍是同一个列表；中间隔了段落就是两个列表', () => {
    expect(outline('# 步骤\n\n1. 打开\n\n2. 保存')).toEqual(['h1 步骤', 'ol 打开 / 保存'])
    expect(outline('# 步骤\n\n1. 打开\n2. 保存\n\n说明一句。\n\n1. 关闭')).toEqual([
      'h1 步骤',
      'ol 打开 / 保存',
      'p 说明一句。',
      'ol 关闭',
    ])
  })

  test('纯文本里单独一行的编号照旧认作章节标题，连成一串的编号是列表', () => {
    expect(outline('1 引言\n本文研究……\n\n1.1 研究背景\n近年来……')).toEqual([
      'h1 1 引言',
      'p 本文研究……',
      'h2 1.1 研究背景',
      'p 近年来……',
    ])
    expect(outline('操作步骤：\n1. 打开\n2. 点击保存\n3. 关闭')).toEqual([
      'p 操作步骤：',
      'ol 打开 / 点击保存 / 关闭',
    ])
  })

  test('正文开头跟 title 同名的一级标题去掉，别的标题留着', () => {
    const blocks = parseWordContentToBlocks('# 季度报告\n\n正文')
    expect(withoutRepeatedTitle(blocks, '季度报告').map((block) => block.kind)).toEqual([
      'paragraph',
    ])
    expect(withoutRepeatedTitle(blocks, '别的标题')).toBe(blocks)
    expect(withoutRepeatedTitle(blocks, undefined)).toBe(blocks)
    const second = parseWordContentToBlocks('## 季度报告\n\n正文')
    expect(withoutRepeatedTitle(second, '季度报告')).toBe(second)
  })

  test('生成的 docx：标题只写一次，有序列表是编号列表，两个列表各自从 1 编号', async () => {
    const { root, ctx } = await createContext()
    await officeOperations.createWord(
      {
        outputPath: 'plan.docx',
        title: '季度报告',
        content: '# 季度报告\n\n## 计划\n\n1. 甲\n2. 乙\n\n说明。\n\n1. 丙',
      },
      ctx
    )
    const zip = await JSZip.loadAsync(await readFile(join(root, 'plan.docx')))
    const document = (await zip.file('word/document.xml')?.async('string')) ?? ''
    const numbering = (await zip.file('word/numbering.xml')?.async('string')) ?? ''
    expect(document.match(/季度报告/g)?.length).toBe(1)
    const numIds = [...document.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((match) => match[1])
    expect(numIds).toHaveLength(3)
    expect(numIds[0]).toBe(numIds[1])
    expect(numIds[2]).not.toBe(numIds[0])
    expect(numbering).toContain('w:val="decimal"')
    expect(numbering).toContain('startOverride')

    const preview = await officeOperations.preview({ inputPath: 'plan.docx' }, ctx)
    expect(preview.outline?.map((item) => item.title)).toEqual(['季度报告', '计划'])
  })
})
