/**
 * office 空间的不变量验收：`spec/invariants.md` 里每一条「测试」档的检验器。
 * 用例名以 INV-<编号> 开头，`check:module-ownership` 按这个前缀核对登记表与实现对得上。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import JSZip from 'jszip'
import { z } from 'zod'

import type { OfficeNativeCommand, OfficeToolContext } from '../src/index'
import { OfficeErrorCodes, officeTools } from '../src/index'
import { sanitizePreviewHtml } from '../src/utils/preview/sanitize'

const createdRoots: string[] = []

afterEach(async () => {
  for (const root of createdRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface Harness {
  root: string
  context: OfficeToolContext
  /** 本包交给宿主执行过的原生命令，按顺序记下来。 */
  commands: OfficeNativeCommand[]
  /** 授权申请的次数与内容。 */
  mutations: Array<{ operation: string; targetPath?: Nullable<string> }>
}

/** 造一个工作区加一份宿主端口替身；approve=false 时所有写入授权都被拒。 */
async function createHarness(
  options: { approve?: boolean; availableCommands?: string[] } = {}
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'velaros-office-spec-'))
  createdRoots.push(root)
  const approve = options.approve ?? true
  const available = new Set(options.availableCommands ?? [])
  const commands: OfficeNativeCommand[] = []
  const mutations: Harness['mutations'] = []
  const context: OfficeToolContext = {
    abortSignal: new AbortController().signal,
    office: {
      getRootPath: () => root,
      prepareMutation: async (input) => {
        mutations.push({ operation: input.operation, targetPath: input.targetPath })
        return {
          approved: approve,
          rootPath: root,
          rejectionMessage: approve ? null : '用户不允许写这个目录。',
          message: approve ? '已批准' : '已拒绝',
        }
      },
      inspectEnvironment: async (names) => ({
        commands: (names ?? []).map((name) => ({
          name,
          available: available.has(name),
          path: available.has(name) ? `/usr/bin/${name}` : null,
        })),
      }),
      runCommand: async (command, commandOptions) => {
        commands.push(command)
        return {
          command: command.file,
          cwd: commandOptions.cwd,
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: '',
          durationMs: 1,
          timedOut: false,
          aborted: false,
          truncated: false,
          success: true,
          verification: { kind: 'unknown' as const, status: 'unknown' as const, issues: [] },
        }
      },
      // 替身一律回答「没装」：本机装没装 MarkItDown 不该影响验收结果。
      locateMarkItDown: () => null,
    },
  }
  return { root, context, commands, mutations }
}

/** 读出 OOXML 产物里的 docProps 文本，用来核对元数据里有没有产品名。 */
async function readDocumentProperties(path: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(path))
  const parts = await Promise.all(
    Object.keys(zip.files)
      .filter((name) => name.startsWith('docProps/'))
      .map(async (name) => zip.file(name)?.async('string') ?? '')
  )
  return parts.join('\n')
}

describe('office 不变量验收', () => {
  test('INV-1 读写目标按真实路径都在工作区根内', async () => {
    const harness = await createHarness()

    await expect(
      officeTools['office:create_spreadsheet'].execute(
        { outputPath: '../escaped.xlsx', content: 'a,b\n1,2' },
        harness.context
      )
    ).rejects.toMatchObject({ code: 'PERMISSION' })
    await expect(
      officeTools['office:extract_pdf_text'].execute(
        { inputPath: '../outside.pdf' },
        harness.context
      )
    ).rejects.toMatchObject({ code: 'PERMISSION' })
  })

  test('INV-2 十个工具的入参里没有换执行目录的字段', () => {
    for (const [name, tool] of Object.entries(officeTools)) {
      const rendered = z.toJSONSchema(tool.schema as z.ZodType, { io: 'input' }) as {
        properties?: Record<string, unknown>
      }
      const keys = Object.keys(rendered.properties ?? {})
      const offenders = keys.filter((key) => ['cwd', 'workingDirectory', 'rootPath'].includes(key))
      expect(`${name}:${offenders.join(',')}`).toBe(`${name}:`)
    }
  })

  test('INV-3 写盘前拿不到授权就一个字节都不写', async () => {
    const harness = await createHarness({ approve: false })

    const result = (await officeTools['office:create_spreadsheet'].execute(
      { outputPath: 'denied.xlsx', content: 'a,b\n1,2' },
      harness.context
    )) as { approved: boolean; skipped: boolean; changed: boolean; rejectionMessage: string }

    expect(result).toMatchObject({ approved: false, skipped: true, changed: false })
    expect(result.rejectionMessage).toContain('不允许')
    expect(harness.mutations).toHaveLength(1)
    await expect(readFile(join(harness.root, 'denied.xlsx'))).rejects.toBeDefined()
  })

  test('INV-4 已存在的文件不带 overwrite 不覆盖，Word 追加是例外', async () => {
    const harness = await createHarness()
    await officeTools['office:create_spreadsheet'].execute(
      { outputPath: 'book.xlsx', content: 'a,b\n1,2' },
      harness.context
    )
    const firstSize = (await readFile(join(harness.root, 'book.xlsx'))).byteLength

    await expect(
      officeTools['office:create_spreadsheet'].execute(
        { outputPath: 'book.xlsx', content: 'a,b\n3,4' },
        harness.context
      )
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await readFile(join(harness.root, 'book.xlsx'))).byteLength).toBe(firstSize)

    await officeTools['office:create_word_document'].execute(
      { outputPath: 'notes.docx', content: '第一段' },
      harness.context
    )
    const appended = (await officeTools['office:create_word_document'].execute(
      { outputPath: 'notes.docx', content: '第二段', appendMode: true },
      harness.context
    )) as { created: boolean; changed: boolean }
    expect(appended).toMatchObject({ created: false, changed: true })
  })

  test('INV-5 外部转换器只经宿主端口按原生 argv 执行', async () => {
    const harness = await createHarness({ availableCommands: ['soffice'] })
    await officeTools['office:create_word_document'].execute(
      { outputPath: 'source.docx', content: '正文' },
      harness.context
    )

    await officeTools['office:convert_word_to_pdf'].execute(
      { inputPath: 'source.docx', outputPath: 'source.pdf' },
      harness.context
    ).catch(() => undefined /* 替身不会真的产出 PDF，这里只看命令形状 */)

    expect(harness.commands.length).toBeGreaterThan(0)
    for (const command of harness.commands) {
      expect(typeof command.file).toBe('string')
      expect(Array.isArray(command.args)).toBe(true)
      // 拼 shell 串的标志：可执行文件名里带空格或 shell 元字符。
      expect(command.file).not.toMatch(/[\s|&;><]/u)
    }
  })

  test('INV-6 缺转换器返回结构化回执而不是抛通用执行错误', async () => {
    const harness = await createHarness()
    await officeTools['office:create_word_document'].execute(
      { outputPath: 'doc.docx', content: '正文' },
      harness.context
    )

    const pdf = (await officeTools['office:convert_word_to_pdf'].execute(
      { inputPath: 'doc.docx', outputPath: 'doc.pdf' },
      harness.context
    )) as { skipped: boolean; errorCode: string; missingCommand: string; reason: string }
    expect(pdf).toMatchObject({
      skipped: true,
      errorCode: OfficeErrorCodes.converterMissing,
      missingCommand: 'soffice',
    })
    expect(pdf.reason.length).toBeGreaterThan(0)

    await writeFile(join(harness.root, 'note.md'), '# 标题', 'utf8')
    const markdown = (await officeTools['office:convert_document_to_markdown'].execute(
      { inputPath: 'note.md' },
      harness.context
    )) as { skipped: boolean; errorCode: string }
    expect(markdown).toMatchObject({
      skipped: true,
      errorCode: OfficeErrorCodes.markItDownUnavailable,
    })
  })

  test('INV-7 预览 HTML 经白名单净化', async () => {
    expect(
      sanitizePreviewHtml('<p onclick="alert(1)">正文<script>alert(2)</script></p>')
    ).not.toMatch(/script|onclick/iu)

    const harness = await createHarness()
    await officeTools['office:create_word_document'].execute(
      { outputPath: 'doc.docx', content: '<script>alert(3)</script> 正文' },
      harness.context
    )
    await officeTools['office:preview_document'].execute(
      { inputPath: 'doc.docx', outputPath: 'preview.html' },
      harness.context
    )

    const html = await readFile(join(harness.root, 'preview.html'), 'utf8')
    expect(html).not.toMatch(/<script/iu)
    expect(html).not.toMatch(/\son[a-z]+=/iu)
  })

  test('INV-8 预览缺省不写自动刷新脚本', async () => {
    const harness = await createHarness()
    await officeTools['office:create_word_document'].execute(
      { outputPath: 'doc.docx', content: '正文' },
      harness.context
    )

    await officeTools['office:preview_document'].execute(
      { inputPath: 'doc.docx', outputPath: 'quiet.html' },
      harness.context
    )
    expect(await readFile(join(harness.root, 'quiet.html'), 'utf8')).not.toContain('location.reload')

    await officeTools['office:preview_document'].execute(
      { inputPath: 'doc.docx', outputPath: 'live.html', autoRefresh: true },
      harness.context
    )
    expect(await readFile(join(harness.root, 'live.html'), 'utf8')).toContain('location.reload')
  })

  test('INV-9 生成的文档不带产品名', async () => {
    const harness = await createHarness()
    await officeTools['office:create_word_document'].execute(
      { outputPath: 'doc.docx', content: '正文' },
      harness.context
    )
    await officeTools['office:create_spreadsheet'].execute(
      { outputPath: 'book.xlsx', content: 'a,b\n1,2' },
      harness.context
    )
    await officeTools['office:create_presentation'].execute(
      { outputPath: 'deck.pptx', content: '# 第一页\n正文' },
      harness.context
    )

    for (const name of ['doc.docx', 'book.xlsx', 'deck.pptx']) {
      const properties = await readDocumentProperties(join(harness.root, name))
      expect(`${name}:${/velaros/iu.test(properties)}`).toBe(`${name}:false`)
    }
  })

  test('INV-10 截断如实标记', async () => {
    const harness = await createHarness()
    await officeTools['office:create_presentation'].execute(
      {
        outputPath: 'deck.pptx',
        content: ['# 一\n正文', '# 二\n正文', '# 三\n正文', '# 四\n正文', '# 五\n正文'].join('\n'),
      },
      harness.context
    )

    const preview = (await officeTools['office:preview_document'].execute(
      { inputPath: 'deck.pptx', maxItems: 2 },
      harness.context
    )) as { preview: { summary: Record<string, unknown>; slides?: unknown[] } }

    expect(preview.preview.summary.slides).toBe(5)
    expect(preview.preview.summary.previewedSlides).toBe(2)
    expect(preview.preview.slides).toHaveLength(2)
  })
})
