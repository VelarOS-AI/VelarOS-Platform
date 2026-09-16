import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import type { OfficeToolContext } from '../src/exports'
import { officeTools } from '../src/exports'

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

function createContext(root: string, command?: CommandStub): OfficeToolContext {
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
      system: {
        inspectEnvironment: async () => ({ commands: [] }),
        createSystemToolInstallSuggestion: () => null,
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
    },
  }
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'velaros-office-truncation-'))
  createdRoots.push(root)
  return root
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
  test('pptx 预览的 slides 报文档总页数，previewedSlides 才是本次预览页数', async () => {
    const root = await createRoot()
    const context = createContext(root)
    await officeTools['office:create_presentation'].execute(
      {
        outputPath: 'deck.pptx',
        content: ['# 第一页\n正文一', '# 第二页\n正文二', '# 第三页\n正文三', '# 第四页\n正文四', '# 第五页\n正文五'].join('\n'),
      },
      context
    )

    const preview = (await officeTools['office:preview_document'].execute(
      { inputPath: 'deck.pptx', maxItems: 2 },
      context
    )) as { preview: { summary: Record<string, unknown>; slides?: unknown[] } }

    expect(preview.preview.summary.slides).toBe(5)
    expect(preview.preview.summary.previewedSlides).toBe(2)
    expect(preview.preview.slides).toHaveLength(2)
  })

  test('命令输出窗口截掉开头时，结果如实标 truncated 并说明返回的是结尾', async () => {
    const root = await createRoot()
    await installFakeMarkItDown()
    await writeFile(join(root, 'long.md'), '原始文档', 'utf8')
    const context = createContext(root, { stdout: '文档的结尾部分', truncated: true })

    const result = (await officeTools['office:convert_document_to_markdown'].execute(
      { inputPath: 'long.md' },
      context
    )) as { truncated: boolean; markdown: string; message?: string }

    expect(result.truncated).toBe(true)
    expect(result.markdown).toContain('结尾部分')
    expect(result.markdown).toContain('开头已被丢弃')
    expect(result.message).toContain('outputPath')
  })

  test('输出没有被截断时不虚报', async () => {
    const root = await createRoot()
    await installFakeMarkItDown()
    await writeFile(join(root, 'short.md'), '原始文档', 'utf8')
    const context = createContext(root, { stdout: '# 标题\n正文', truncated: false })

    const result = (await officeTools['office:convert_document_to_markdown'].execute(
      { inputPath: 'short.md' },
      context
    )) as { truncated: boolean; markdown: string; message?: string }

    expect(result.truncated).toBe(false)
    expect(result.markdown).toBe('# 标题\n正文')
    expect(result.message).toBeUndefined()
  })
})
