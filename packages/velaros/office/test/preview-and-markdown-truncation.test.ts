import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import JSZip from 'jszip'

import type { OfficeOperationContext } from '../index.js'
import { officeOperations } from '../index.js'

const createdRoots: string[] = []
let restoreMarkItDownRoot: Nullable<string | undefined> = null

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
  if (restoreMarkItDownRoot !== null) {
    if (restoreMarkItDownRoot === undefined) delete process.env.VELAROS_MARKITDOWN_RESOURCE_ROOT
    else process.env.VELAROS_MARKITDOWN_RESOURCE_ROOT = restoreMarkItDownRoot
    restoreMarkItDownRoot = null
  }
})

interface CommandStub {
  stdout: string
  truncated: boolean
}

function createContext(root: string, command?: CommandStub): OfficeOperationContext {
  return {
    abortSignal: new AbortController().signal,
    office: {
      getRootPath: () => root,
      inspectEnvironment: async () => ({ commands: [] }),
      // 按宿主语义扮演：命令输出窗口**保留结尾**，截断事实只写在 commandResult.truncated 上。
      runCommand: async () => ({
        command: 'markitdown',
        cwd: root,
        exitCode: 0,
        signal: null,
        stdout: command?.stdout ?? '',
        stderr: '',
        durationMs: 1,
        timedOut: false,
        aborted: false,
        truncated: command?.truncated ?? false,
        success: true,
        verification: { kind: 'unknown' as const, status: 'unknown' as const, issues: [] },
      }),
    },
  }
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'velaros-office-truncation-'))
  createdRoots.push(root)
  return root
}

/** 从真实生成产物改包清单，保留普通部件名字，模拟编辑器重排与合法命名空间写法。 */
async function createPptxFixture(root: string): Promise<JSZip> {
  const written = await officeOperations.createPresentation(
    {
      outputPath: 'source.pptx',
      content: '# 第一页\n正文一 & 证据\n# 第二页\n正文二\n# 第三页\n正文三',
    },
    createContext(root)
  )
  return JSZip.loadAsync(await readFile(written.path))
}

/** 只改真实夹具的标准 URI 和前缀；生产解析器不参与夹具构造。 */
function remapPptxFixtureNamespaces(xml: string, strict: boolean): string {
  const namespaces = strict
    ? xml
        .replaceAll(
          'http://schemas.openxmlformats.org/presentationml/2006/main',
          'http://purl.oclc.org/ooxml/presentationml/main'
        )
        .replaceAll(
          'http://schemas.openxmlformats.org/drawingml/2006/main',
          'http://purl.oclc.org/ooxml/drawingml/main'
        )
        .replaceAll(
          'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
          'http://purl.oclc.org/ooxml/officeDocument/relationships'
        )
    : xml
  return namespaces
    .replaceAll('xmlns:p=', 'xmlns=')
    .replace(/(<\/?)(?:p):/g, '$1')
    .replaceAll('xmlns:a=', 'xmlns:draw=')
    .replace(/(<\/?)a:/g, '$1draw:')
    .replaceAll('xmlns:r=', 'xmlns:link=')
    .replaceAll(' r:', ' link:')
    .replace(
      'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"',
      'xmlns:pkg="http://schemas.openxmlformats.org/package/2006/relationships"'
    )
    .replace(/(<\/?)(Relationships?)(?=[\s/>])/g, '$1pkg:$2')
}

/** 造一份「已安装」的 MarkItDown 资源包；命令本身不会被执行（runCommand 是替身）。 */
async function installFakeMarkItDown(): Promise<void> {
  const resourceRoot = await mkdtemp(join(tmpdir(), 'velaros-office-markitdown-'))
  createdRoots.push(resourceRoot)
  const packageRoot = join(resourceRoot, `markitdown-${process.platform}-${process.arch}`)
  await mkdir(join(packageRoot, 'bin'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: '1.0.0' }))
  for (const name of ['markitdown', 'markitdown.cmd', 'markitdown.exe']) {
    await writeFile(join(packageRoot, 'bin', name), '')
    await chmod(join(packageRoot, 'bin', name), 0o755)
  }
  restoreMarkItDownRoot = process.env.VELAROS_MARKITDOWN_RESOURCE_ROOT
  process.env.VELAROS_MARKITDOWN_RESOURCE_ROOT = resourceRoot
}

describe('预览页数与 Markdown 截断的如实上报', () => {
  test.each([false, true])(
    '返回长度将所有截断提示计入 maxChars（宿主截断=%s）',
    async (truncated) => {
      const root = await createRoot()
      await writeFile(join(root, 'long.md'), 'source')
      const context = createContext(root, { stdout: '正文'.repeat(2000), truncated })
      context.office.locateMarkItDown = () => ({
        command: 'markitdown',
        packageRoot: root,
        version: 'test',
      })
      const result = await officeOperations.toMarkdown(
        { inputPath: 'long.md', maxChars: 1000 },
        context
      )
      expect(result.markdown.length).toBeLessThanOrEqual(1000)
      expect(result.truncated).toBe(true)
      expect(result.markdown).toContain('maxChars 截断')
      if (truncated) expect(result.markdown).toContain('开头已被丢弃')
    }
  )

  test.each([false, true])(
    'Markdown 取消传给宿主，命令收尾后不再交付或发布文件（outputPath=%s）',
    async (write) => {
      const root = await createRoot()
      await writeFile(join(root, 'source.md'), 'source')
      const abort = new AbortController()
      const context = createContext(root)
      context.abortSignal = abort.signal
      context.office.locateMarkItDown = () => ({
        command: 'markitdown',
        packageRoot: root,
        version: 'test',
      })
      const resultOf = context.office.runCommand
      let directory = ''
      context.office.runCommand = async (command, options, signal) => {
        expect(signal).toBe(abort.signal)
        if (write) {
          const output = command.args[command.args.indexOf('-o') + 1]!
          directory = output
          await writeFile(output, 'converted')
        }
        abort.abort(new Error('cancelled conversion'))
        return resultOf(command, options)
      }
      await expect(
        officeOperations.toMarkdown(
          { inputPath: 'source.md', ...(write ? { outputPath: 'result.md' } : {}) },
          context
        )
      ).rejects.toThrow('cancelled conversion')
      if (write) {
        await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(join(root, 'result.md'))).rejects.toMatchObject({ code: 'ENOENT' })
      }
    }
  )

  test('Word 摘要计入全部标题，maxItems 只截取大纲', async () => {
    const root = await createRoot()
    const context = createContext(root)
    await officeOperations.createWord(
      {
        outputPath: 'headings.docx',
        blocks: Array.from({ length: 5 }, (_, index) => ({
          kind: 'heading',
          text: `标题 ${index + 1}`,
          level: 1,
        })),
      },
      context
    )
    const preview = await officeOperations.preview(
      { inputPath: 'headings.docx', maxItems: 2 },
      context
    )
    expect(preview.summary.headings).toBe(5)
    expect(preview.outline).toHaveLength(2)
  })

  test('pptx 预览的 slides 报文档总页数，previewedSlides 才是本次预览页数', async () => {
    const root = await createRoot()
    const context = createContext(root)
    await officeOperations.createPresentation(
      {
        outputPath: 'deck.pptx',
        content: [
          '# 第一页\n正文一',
          '# 第二页\n正文二',
          '# 第三页\n正文三',
          '# 第四页\n正文四',
          '# 第五页\n正文五',
        ].join('\n'),
      },
      context
    )

    const preview = await officeOperations.preview({ inputPath: 'deck.pptx', maxItems: 2 }, context)

    expect(preview.summary.slides).toBe(5)
    expect(preview.summary.previewedSlides).toBe(2)
    expect(preview.slides).toHaveLength(2)
  })

  test('pptx 预览按清单重排并排除孤立页，空演示文稿如实报零页', async () => {
    const root = await createRoot()
    const context = createContext(root)
    const zip = await createPptxFixture(root)
    const presentation = await zip.file('ppt/presentation.xml')!.async('string')
    const slideIds = [...presentation.matchAll(/<p:sldId\s[^>]*\/>/g)].map((match) => match[0])
    expect(slideIds).toHaveLength(3)
    zip.file(
      'ppt/presentation.xml',
      presentation.replace(
        /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
        `<p:sldIdLst>${slideIds[2]}${slideIds[0]}${slideIds[1]}</p:sldIdLst>`
      )
    )
    zip.file('ppt/slides/slide99.xml', await zip.file('ppt/slides/slide2.xml')!.async('string'))
    zip.file(
      'ppt/slides/_rels/slide99.xml.rels',
      await zip.file('ppt/slides/_rels/slide2.xml.rels')!.async('string')
    )
    zip.file(
      '[Content_Types].xml',
      (await zip.file('[Content_Types].xml')!.async('string')).replace(
        '</Types>',
        '<Override PartName="/ppt/slides/slide99.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'
      )
    )
    await writeFile(join(root, 'reordered.pptx'), await zip.generateAsync({ type: 'nodebuffer' }))
    const preview = await officeOperations.preview(
      { inputPath: 'reordered.pptx', maxItems: 2 },
      context
    )
    expect(preview.summary).toMatchObject({ slides: 3, previewedSlides: 2 })
    expect(preview.title).toBe('第三页')
    expect(preview.slides?.map(({ index, title }) => ({ index, title }))).toEqual([
      { index: 1, title: '第三页' },
      { index: 2, title: '第一页' },
    ])

    zip.remove('ppt/_rels/presentation.xml.rels')
    for (const list of ['', '<p:sldIdLst/>']) {
      zip.file(
        'ppt/presentation.xml',
        `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">${list}<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
      )
      await writeFile(join(root, 'empty.pptx'), await zip.generateAsync({ type: 'nodebuffer' }))
      const empty = await officeOperations.preview({ inputPath: 'empty.pptx' }, context)
      expect(empty.summary).toMatchObject({ slides: 0, previewedSlides: 0 })
      expect(empty.slides).toEqual([])
    }
  })

  test('pptx 预览通过包级关系读取改名主部件，兼容两套标准命名空间与任意前缀', async () => {
    for (const strict of [false, true]) {
      const root = await createRoot()
      const zip = await createPptxFixture(root)
      const presentation = await zip.file('ppt/presentation.xml')!.async('string')
      const relationships = (
        await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
      ).replace(/Target="([^"]+)"/g, 'Target="../../ppt/$1"')
      zip.remove('ppt/presentation.xml')
      zip.remove('ppt/_rels/presentation.xml.rels')
      zip.file('custom/presentation/show.xml', presentation)
      zip.file('custom/presentation/_rels/show.xml.rels', relationships)
      zip.file(
        '_rels/.rels',
        (await zip.file('_rels/.rels')!.async('string')).replace(
          'Target="ppt/presentation.xml"',
          'Target="/custom/presentation/show.xml"'
        )
      )
      zip.file(
        '[Content_Types].xml',
        (await zip.file('[Content_Types].xml')!.async('string')).replace(
          'PartName="/ppt/presentation.xml"',
          'PartName="/custom/presentation/show.xml"'
        )
      )
      for (const part of Object.values(zip.files)) {
        if (part.dir || (!part.name.endsWith('.xml') && !part.name.endsWith('.rels'))) continue
        const xml = remapPptxFixtureNamespaces(await part.async('string'), strict)
        zip.file(
          part.name,
          xml.replace('<draw:t>第一页</draw:t>', '<draw:t><![CDATA[第一<页>]]></draw:t>')
        )
      }
      await writeFile(
        join(root, 'namespaced.pptx'),
        await zip.generateAsync({ type: 'nodebuffer' })
      )
      const preview = await officeOperations.preview(
        { inputPath: 'namespaced.pptx', maxItems: 1 },
        createContext(root)
      )
      expect(preview.summary).toMatchObject({ slides: 3, previewedSlides: 1 })
      expect(preview.title).toBe('第一<页>')
      expect(preview.slides?.[0]?.bullets).toContain('正文一 & 证据')
    }
  })

  test('pptx 预览拒绝损坏关系、DOCTYPE 与 XML 诊断且不发布预览', async () => {
    const root = await createRoot()
    const context = createContext(root)
    const source = await (await createPptxFixture(root)).generateAsync({ type: 'nodebuffer' })
    for (const broken of [
      'package',
      'relationship',
      'external',
      'part',
      'rels',
      'doctype',
      'xml',
    ]) {
      const zip = await JSZip.loadAsync(source)
      if (broken === 'package') zip.remove('_rels/.rels')
      else if (broken === 'relationship') {
        const xml = await zip.file('ppt/presentation.xml')!.async('string')
        zip.file(
          'ppt/presentation.xml',
          xml.replace(/(<p:sldId\s[^>]*r:id=")[^"]+("[^>]*\/?>)/, '$1missing$2')
        )
      } else if (broken === 'external') {
        const xml = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
        zip.file(
          'ppt/_rels/presentation.xml.rels',
          xml.replace(
            'Target="slides/slide1.xml"',
            'Target="https://example.invalid/slide.xml" TargetMode="External"'
          )
        )
      } else if (broken === 'part') zip.remove('ppt/slides/slide3.xml')
      else if (broken === 'rels') zip.remove('ppt/_rels/presentation.xml.rels')
      else if (broken === 'doctype') {
        const xml = await zip.file('_rels/.rels')!.async('string')
        zip.file(
          '_rels/.rels',
          xml.replace(
            /(<\?xml[^?]*\?>)/,
            '$1<!DOCTYPE Relationships SYSTEM "https://example.invalid/external.dtd">'
          )
        )
      } else {
        const xml = await zip.file('ppt/slides/slide1.xml')!.async('string')
        zip.file('ppt/slides/slide1.xml', xml.replace('第一页', '&unknown;'))
      }
      await writeFile(join(root, 'broken.pptx'), await zip.generateAsync({ type: 'nodebuffer' }))
      await expect(
        officeOperations.preview(
          { inputPath: 'broken.pptx', maxItems: 1, outputPath: 'broken.html' },
          context
        )
      ).rejects.toMatchObject({ code: 'VALIDATION', context: { executionOutcome: 'not-applied' } })
      await expect(stat(join(root, 'broken.html'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  test('命令输出窗口截掉开头时，结果如实标 truncated 并说明返回的是结尾', async () => {
    const root = await createRoot()
    await installFakeMarkItDown()
    await writeFile(join(root, 'long.md'), '原始文档', 'utf8')
    const context = createContext(root, { stdout: '文档的结尾部分', truncated: true })

    const result = await officeOperations.toMarkdown({ inputPath: 'long.md' }, context)

    expect(result.truncated).toBe(true)
    expect(result.markdown).toContain('结尾部分')
    expect(result.markdown).toContain('开头已被丢弃')
    expect(result.markdown).toContain('outputPath')
  })

  test('宿主停用 MarkItDown 时，即使默认目录已安装也不执行命令', async () => {
    const root = await createRoot()
    await installFakeMarkItDown()
    await writeFile(join(root, 'short.md'), '原始文档', 'utf8')
    const context = createContext(root)
    let commands = 0
    context.office.locateMarkItDown = () => null
    context.office.runCommand = async () => {
      commands += 1
      throw new Error('disabled converter must not run')
    }

    await expect(
      officeOperations.toMarkdown({ inputPath: 'short.md' }, context)
    ).rejects.toMatchObject({ code: 'OFFICE_MARKITDOWN_UNAVAILABLE' })
    expect(commands).toBe(0)
  })

  test('输出没有被截断时不虚报', async () => {
    const root = await createRoot()
    await installFakeMarkItDown()
    await writeFile(join(root, 'short.md'), '原始文档', 'utf8')
    const context = createContext(root, { stdout: '# 标题\n正文', truncated: false })

    const result = await officeOperations.toMarkdown({ inputPath: 'short.md' }, context)

    expect(result).toEqual({
      path: join(root, 'short.md'),
      markdown: '# 标题\n正文',
      truncated: false,
    })
  })
})
