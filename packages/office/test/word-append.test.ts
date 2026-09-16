import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import JSZip from 'jszip'

import type { OfficeToolContext } from '../src'
import { officeTools } from '../src'

// 部件路径在测试里写字面量：这样这组用例对着修复前的实现也能跑（只会红，不会加载失败）。
const WordContentTypesXmlPath = '[Content_Types].xml'
const WordDocumentXmlPath = 'word/document.xml'
const WordDocumentRelsPath = 'word/_rels/document.xml.rels'
const WordNumberingXmlPath = 'word/numbering.xml'
const WordStylesXmlPath = 'word/styles.xml'

const createdRoots: string[] = []

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'velaros-office-append-'))
  createdRoots.push(root)
  return root
}

function createContext(root: string): OfficeToolContext {
  return {
    abortSignal: new AbortController().signal,
    office: {
      hasProjectRoot: () => true,
      project: {
        getRootPath: () => root,
        runInDirectory: async <T>(_cwd: string, action: () => Promise<T>) => action(),
        prepareMutation: async () => ({
          approved: true,
          rootPath: root,
          switched: false,
          alreadyAuthorized: true,
          rejectionMessage: null,
          message: 'approved',
        }),
      },
      system: {} as OfficeToolContext['office']['system'],
    },
  }
}

/** 造一个「只有 document.xml，没有编号也没有样式部件」的最小 docx——别的产出方的常见形状。 */
async function writeBareDocx(path: string): Promise<void> {
  const zip = new JSZip()
  zip.file(
    WordContentTypesXmlPath,
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default ContentType="application/vnd.openxmlformats-package.relationships+xml" Extension="rels"/><Default ContentType="application/xml" Extension="xml"/><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" PartName="/word/document.xml"/></Types>'
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  )
  zip.file(
    WordDocumentXmlPath,
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>原文</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'
  )
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
}

/** 造一个「已有编号部件，且 numId=1 被别的列表占着」的 docx。 */
async function writeDocxWithNumbering(path: string): Promise<void> {
  const zip = new JSZip()
  zip.file(
    WordContentTypesXmlPath,
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default ContentType="application/vnd.openxmlformats-package.relationships+xml" Extension="rels"/><Default ContentType="application/xml" Extension="xml"/><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" PartName="/word/document.xml"/><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml" PartName="/word/numbering.xml"/></Types>'
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  )
  zip.file(
    WordDocumentRelsPath,
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>'
  )
  zip.file(
    WordDocumentXmlPath,
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>原有列表</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'
  )
  zip.file(
    WordNumberingXmlPath,
    '<?xml version="1.0" encoding="UTF-8"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>'
  )
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
}

async function readDocxPart(path: string, part: string): Promise<Nullable<string>> {
  const zip = await JSZip.loadAsync(await readFile(path))
  const file = zip.file(part)
  return file ? file.async('string') : null
}

async function appendBullets(context: OfficeToolContext, outputPath: string): Promise<unknown> {
  return officeTools['office:create_word_document'].execute(
    {
      outputPath,
      appendMode: true,
      blocks: [
        { kind: 'heading', text: '追加标题', level: 1 },
        { kind: 'bullets', items: ['第一项', '第二项'] },
      ],
    },
    context
  )
}

describe('Word 追加模式的编号与样式定义', () => {
  test('目标没有编号部件时，把片段的编号与样式定义一并带过去', async () => {
    const root = await createRoot()
    const target = join(root, 'report.docx')
    await writeBareDocx(target)

    await appendBullets(createContext(root), 'report.docx')

    const documentXml = (await readDocxPart(target, WordDocumentXmlPath)) ?? ''
    const numberingXml = await readDocxPart(target, WordNumberingXmlPath)
    const stylesXml = await readDocxPart(target, WordStylesXmlPath)
    const referencedNumIds = [...documentXml.matchAll(/<w:numId\b[^>]*w:val="([^"]+)"/g)].map(
      (match) => match[1]
    )
    expect(referencedNumIds).not.toHaveLength(0)
    // 每一个引用都必须在编号部件里找得到定义，否则 Word 里项目符号直接消失。
    for (const numId of referencedNumIds) {
      expect(numberingXml).toContain(`<w:num w:numId="${numId}">`)
    }
    expect(stylesXml).toContain('w:styleId="Heading1"')
    // 新部件要同时登记内容类型与文档关系，否则 Word 判定文档损坏。
    expect(await readDocxPart(target, WordContentTypesXmlPath)).toContain(
      'PartName="/word/numbering.xml"'
    )
    expect(await readDocxPart(target, WordDocumentRelsPath)).toContain('Target="numbering.xml"')
  })

  test('目标已占用 numId=1 时，追加的列表重发号，不串到原有列表上', async () => {
    const root = await createRoot()
    const target = join(root, 'list.docx')
    await writeDocxWithNumbering(target)

    await appendBullets(createContext(root), 'list.docx')

    const documentXml = (await readDocxPart(target, WordDocumentXmlPath)) ?? ''
    const numberingXml = (await readDocxPart(target, WordNumberingXmlPath)) ?? ''
    const referencedNumIds = [...documentXml.matchAll(/<w:numId\b[^>]*w:val="([^"]+)"/g)].map(
      (match) => match[1]
    )
    // 原文那条列表仍是 1，追加进来的那条必须换号。
    expect(referencedNumIds[0]).toBe('1')
    expect(new Set(referencedNumIds).size).toBe(2)
    for (const numId of referencedNumIds) {
      expect(numberingXml).toContain(`<w:num w:numId="${numId}">`)
    }
    // 原有的 decimal 定义不许被片段的 bullet 定义顶掉。
    expect(numberingXml).toContain('<w:abstractNum w:abstractNumId="1">')
    expect(numberingXml).toContain('<w:numFmt w:val="decimal"/>')
    // abstractNum 必须全部排在 num 之前（OOXML 次序要求）。
    expect(numberingXml.lastIndexOf('<w:abstractNum ')).toBeLessThan(
      numberingXml.indexOf('<w:num ')
    )
  })
})
