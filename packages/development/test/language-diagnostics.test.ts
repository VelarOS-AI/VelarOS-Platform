import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import * as ts from 'typescript'

import { typescriptPlugin } from '@velaros-ai/project/changes'
import { createProjectKernel } from '@velaros-ai/project/runtime'

import {
  configureTypeScriptLibraryDirectory,
  executeProjectCodeLanguageQuery,
  type LanguageToolContext,
} from '../src'
import { clearTypeScriptProjectCache } from '../src/runtime/TypeScriptProjectHost'

interface DiagnosticsPayload {
  diagnostics: Array<{ path: string; severity: string; message: string; code?: number }>
  diagnosticCount: number
  scannedFiles: number
  truncated: boolean
  degraded?: string
  note?: string
}

const TypedSource = `export const counts: Record<string, number> = {}
export const seen = new Set<string>()
export const label = '  padded  '.trim()
export const broken: number = 'not a number'
`

const bundledLibraryDirectory = dirname(ts.getDefaultLibFilePath({}))
const originalExecutingFilePath = ts.sys.getExecutingFilePath
const electronProcess = process as NodeJS.Process & { resourcesPath?: string }
let root = ''
let scratch = ''

type KernelAssembly = 'core' | 'typescript-plugin'

async function createContext(assembly: KernelAssembly): Promise<LanguageToolContext> {
  // Workbench 只装 corePlugin，Desktop 额外装 TS 插件；两种装配都必须能列出目录源文件。
  const kernel = await createProjectKernel({
    root,
    plugins: assembly === 'typescript-plugin' ? [typescriptPlugin()] : [],
  })
  return {
    abortSignal: new AbortController().signal,
    project: {
      getRootPath: () => root,
      runInDirectory: async (_path, action) => action(),
      kernel: async () => ({
        listFiles: kernel.listFiles.bind(kernel),
        read: kernel.read.bind(kernel),
        listSymbols: kernel.listSymbols.bind(kernel),
      }),
    },
  }
}

async function diagnose(
  input: { path: string; extensions?: string[]; limit?: number },
  assembly: KernelAssembly = 'core'
): Promise<DiagnosticsPayload> {
  const context = await createContext(assembly)
  return (await executeProjectCodeLanguageQuery(
    { action: 'language_diagnostics', ...input },
    context
  )) as unknown as DiagnosticsPayload
}

function expectNoStandardLibraryNoise(result: DiagnosticsPayload): void {
  const messages = result.diagnostics.map((diagnostic) => diagnostic.message).join('\n')
  expect(messages).not.toContain("Cannot find name 'Record'")
  expect(messages).not.toContain("Cannot find name 'Set'")
  expect(messages).not.toContain("Property 'trim' does not exist")
}

/** 模拟 Electron 打包：`typescript.js` 所在目录没有任何 `lib.*.d.ts`。 */
function simulatePackagedTypeScript(): void {
  const packagedTypeScript = join(scratch, 'app.asar', 'node_modules', 'typescript', 'lib')
  ts.sys.getExecutingFilePath = () => join(packagedTypeScript, 'typescript.js')
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-language-diagnostics-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'velaros-language-diagnostics-host-')))
  await mkdir(join(root, 'src', 'nested'), { recursive: true })
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }))
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', lib: ['ES2022'], module: 'ESNext', strict: true },
      include: ['src'],
    })
  )
  await writeFile(join(root, 'src', 'typed.ts'), TypedSource)
  await writeFile(join(root, 'src', 'clean.ts'), 'export const answer = 42\n')
  await writeFile(join(root, 'src', 'nested', 'deep.ts'), 'export const deep: string = 1\n')
  await writeFile(join(root, 'docs', 'README.md'), '# fixture\n')
})

afterEach(() => {
  ts.sys.getExecutingFilePath = originalExecutingFilePath
  delete electronProcess.resourcesPath
  configureTypeScriptLibraryDirectory(null)
})

afterAll(async () => {
  clearTypeScriptProjectCache()
  await Promise.all([root, scratch].map((path) => rm(path, { recursive: true, force: true })))
})

describe('language_diagnostics 标准库定位', () => {
  test('报出真实类型错误，且不误报标准库全局名', async () => {
    const result = await diagnose({ path: 'src/typed.ts' })

    expect(result.scannedFiles).toBe(1)
    expect(result.degraded).toBeUndefined()
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([
      expect.objectContaining({ path: 'src/typed.ts', code: 2322 }),
    ])
    expectNoStandardLibraryNoise(result)
  })

  test('typescript 包旁缺标准库时回退到宿主声明的目录', async () => {
    simulatePackagedTypeScript()
    configureTypeScriptLibraryDirectory(bundledLibraryDirectory)

    const result = await diagnose({ path: 'src/typed.ts' })

    expect(result.degraded).toBeUndefined()
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(2322)
    expectNoStandardLibraryNoise(result)
  })

  test('未声明目录时回退到 <resourcesPath>/typescript/lib 约定', async () => {
    const resourcesPath = join(scratch, 'Resources')
    await mkdir(join(resourcesPath, 'typescript'), { recursive: true })
    await symlink(bundledLibraryDirectory, join(resourcesPath, 'typescript', 'lib'))
    simulatePackagedTypeScript()
    electronProcess.resourcesPath = resourcesPath
    clearTypeScriptProjectCache()

    const result = await diagnose({ path: 'src/typed.ts' })

    expect(result.degraded).toBeUndefined()
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(2322)
    expectNoStandardLibraryNoise(result)
  })

  test('处处都找不到标准库时显式降级，只返回语法诊断', async () => {
    await writeFile(join(root, 'src', 'syntax.ts'), 'export const value = (1\n')
    try {
      simulatePackagedTypeScript()
      clearTypeScriptProjectCache()

      const typed = await diagnose({ path: 'src/typed.ts' })
      expect(typed.degraded).toContain('未找到 TypeScript 标准库声明')
      expect(typed.scannedFiles).toBe(1)
      expect(typed.diagnostics).toEqual([])

      const syntax = await diagnose({ path: 'src/syntax.ts' })
      expect(syntax.degraded).toContain('类型诊断不可用')
      expect(syntax.diagnostics).toEqual([
        expect.objectContaining({ path: 'src/syntax.ts', severity: 'error' }),
      ])
    } finally {
      await rm(join(root, 'src', 'syntax.ts'), { force: true })
    }
  })

  test('宿主声明的标准库目录必须是绝对路径', () => {
    expect(() => configureTypeScriptLibraryDirectory('typescript/lib')).toThrow('绝对路径')
  })
})

describe('language_diagnostics 目录扫描', () => {
  for (const assembly of ['core', 'typescript-plugin'] as const) {
    test(`目录路径扫描其下全部源文件（${assembly}）`, async () => {
      const result = await diagnose({ path: 'src' }, assembly)

      expect(result.scannedFiles).toBe(3)
      expect(result.note).toBeUndefined()
      expect(result.degraded).toBeUndefined()
      const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
      expect(errors.map((diagnostic) => [diagnostic.path, diagnostic.code])).toEqual([
        ['src/nested/deep.ts', 2322],
        ['src/typed.ts', 2322],
      ])
      expectNoStandardLibraryNoise(result)
    })
  }

  test('项目根目录与带点的扩展名过滤都能选中文件', async () => {
    const result = await diagnose({ path: '.', extensions: ['.ts'] })

    expect(result.scannedFiles).toBe(3)
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(2322)
  })

  test('没有可诊断源文件时明确说明，而不是看起来像全部通过', async () => {
    const docs = await diagnose({ path: 'docs' })
    expect(docs.scannedFiles).toBe(0)
    expect(docs.note).toContain('未找到可诊断的源文件')
    expect(docs.note).toContain('不代表代码没有错误')

    const filtered = await diagnose({ path: 'src', extensions: ['tsx'] })
    expect(filtered.scannedFiles).toBe(0)
    expect(filtered.note).toContain('没有扩展名为 tsx 的文件')

    const unsupported = await diagnose({ path: 'src', extensions: ['vue'] })
    expect(unsupported.scannedFiles).toBe(0)
    expect(unsupported.note).toContain('extensions: vue')

    const markdown = await diagnose({ path: 'docs/README.md' })
    expect(markdown.scannedFiles).toBe(0)
    expect(markdown.note).toBeString()
  })

  test('不存在的路径显式失败', async () => {
    await expect(diagnose({ path: 'src/missing' })).rejects.toThrow('诊断路径不存在')
  })

  test('超过文件上限时截断并说明，错误排在提示之前', async () => {
    const bulk = join(root, 'src', 'bulk')
    await mkdir(bulk, { recursive: true })
    try {
      await Promise.all(
        Array.from({ length: 205 }, (_, index) =>
          writeFile(
            join(bulk, `file-${String(index).padStart(3, '0')}.ts`),
            // 其余文件各带一条「声明未使用」提示：按路径排序它们都在错误之前，验证严重度优先。
            index === 150
              ? 'export const wrong: boolean = 0\n'
              : `export function f${index}(): void {\n  const unused = ${index}\n}\n`
          )
        )
      )

      const result = await diagnose({ path: 'src/bulk', limit: 5 })

      expect(result.scannedFiles).toBe(200)
      expect(result.truncated).toBe(true)
      expect(result.note).toContain('只诊断了')
      expect(result.diagnosticCount).toBeGreaterThan(5)
      expect(result.diagnostics[0]).toMatchObject({ path: 'src/bulk/file-150.ts', code: 2322 })
      expect(result.diagnostics[1]).toMatchObject({ severity: 'info' })
    } finally {
      await rm(bulk, { recursive: true, force: true })
    }
  })
})
