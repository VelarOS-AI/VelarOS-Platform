/**
 * 语言查询的结果语义与重复解析：
 * - `find_symbols` / `list_exports` 每个文件只解析一次导出名（不再逐个未导出符号整文件重解析）；
 * - `find_references` 提前停扫时如实标「至少」。
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'

import { createProjectKernel } from '@velaros-ai/velaros/project'

import { LanguageQueries } from '../impl/language/LanguageQueries'
import { LanguageServiceRegistry } from '../impl/language/LanguageServiceRegistry'
import { typeScriptProjectPool } from '../impl/language/TypeScriptProjectPool'
import { languageQueries, type LanguageToolContext, typeScriptProjects } from '../index'
import type { LanguageNavigationService } from '../types/language'

setDefaultTimeout(30_000)

let root = ''

/** 一个导出两个函数、另有若干非导出声明的文件：非导出符号是「每个都重解析一次」的触发点。 */
const SampleSource = `export function exportedOne(): number {
  return helperOne() + helperTwo()
}

function helperOne(): number {
  return 1
}

function helperTwo(): number {
  return 2
}

const privateValue = helperOne()

export const exportedTwo = privateValue
`

async function createContext(): Promise<LanguageToolContext> {
  const kernel = await createProjectKernel({ root, plugins: [] })
  return {
    abortSignal: new AbortController().signal,
    project: {
      getRootPath: () => root,
      kernel: async () => ({
        listFiles: kernel.listFiles.bind(kernel),
        read: kernel.read.bind(kernel),
        listSymbols: kernel.listSymbols.bind(kernel),
      }),
    },
  }
}

async function run(input: Record<string, unknown>): Promise<Record<string, any>> {
  return (await languageQueries.run(input as never, await createContext())) as Record<string, any>
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-development-semantics-')))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }))
  await writeFile(join(root, 'src', 'sample.ts'), SampleSource)
  // 引用扫描要越过 limit 才会提前停扫：多写几个文件，每个都提到同一个名字。
  for (let index = 0; index < 6; index += 1) {
    await writeFile(
      join(root, 'src', `user-${index}.ts`),
      `import { exportedOne } from './sample'\nexport const value${index} = exportedOne()\n`
    )
  }
})

afterAll(async () => {
  typeScriptProjects.release()
  const temporaryRoot = await realpath(tmpdir())
  if (root.startsWith(temporaryRoot)) await rm(root, { recursive: true, force: true })
})

describe('find_symbols / list_exports', () => {
  test('导出与非导出的判定不变', async () => {
    const result = await run({ action: 'find_symbols', path: 'src/sample.ts', limit: 100 })
    const byName = new Map<string, boolean>(
      result.symbols.map((symbol: { name: string; exported: boolean }) => [
        symbol.name,
        symbol.exported,
      ])
    )

    expect(byName.get('exportedOne')).toBe(true)
    expect(byName.get('exportedTwo')).toBe(true)
    expect(byName.get('helperOne')).toBe(false)
    expect(byName.get('helperTwo')).toBe(false)
    expect(byName.get('privateValue')).toBe(false)
  })

  test('list_exports 只列导出名，不把非导出声明也算进去', async () => {
    const result = await run({ action: 'list_exports', path: 'src/sample.ts', limit: 100 })
    const names = new Set(result.exports.map((record: { name: string }) => record.name))

    expect(names.has('exportedOne')).toBe(true)
    expect(names.has('exportedTwo')).toBe(true)
    expect(names.has('helperOne')).toBe(false)
    expect(names.has('privateValue')).toBe(false)
  })
})

describe('TypeScript 语言服务池', () => {
  test('超过上限时淘汰最久未用的项目，池不再只增不减', async () => {
    typeScriptProjects.release()
    const roots: string[] = []
    const temporaryRoot = await realpath(tmpdir())

    try {
      for (let index = 0; index < 10; index += 1) {
        const projectRoot = await realpath(
          await mkdtemp(join(tmpdir(), 'velaros-development-pool-'))
        )
        roots.push(projectRoot)
        await writeFile(
          join(projectRoot, 'tsconfig.json'),
          JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2022'] }, include: ['.'] })
        )
        await writeFile(join(projectRoot, 'main.ts'), `export const value${index} = ${index}\n`)
      }

      const first = typeScriptProjectPool.acquire(
        roots[0],
        join(roots[0], 'main.ts'),
        [join(roots[0], 'main.ts')],
        new Map()
      )
      expect(first.isCurrent()).toBe(true)

      for (const projectRoot of roots.slice(1)) {
        typeScriptProjectPool.acquire(
          projectRoot,
          join(projectRoot, 'main.ts'),
          [join(projectRoot, 'main.ts')],
          new Map()
        )
      }

      // 第一个项目已经被挤出池子：调用方本来就按 isCurrent() 处理服务被回收的情况。
      expect(first.isCurrent()).toBe(false)
    } finally {
      typeScriptProjects.release()
      await Promise.all(
        roots
          .filter((path) => path.startsWith(temporaryRoot))
          .map((path) => rm(path, { recursive: true, force: true }))
      )
    }
  })
})

describe('find_references 的引用数口径', () => {
  test('扫完全部文件时不标下限', async () => {
    const result = await run({ action: 'find_references', symbol: 'exportedOne', limit: 100 })

    expect(result.referenceCount).toBeGreaterThan(0)
    expect(result.referenceCountIsLowerBound).toBeUndefined()
    expect(result.note).toBeUndefined()
  })

  test('凑够 limit 就停扫时，引用数标成「至少」并写明原因', async () => {
    const result = await run({ action: 'find_references', symbol: 'exportedOne', limit: 2 })

    expect(result.referenceCountIsLowerBound).toBe(true)
    expect(result.note).toContain('引用数是下限')
    expect(result.referenceCount).toBeGreaterThan(2)
  })
})

test('影响分析保留 importer 截断事实，多个完整语言结果合并截断也如实标记', async () => {
  const unused = async () => {
    throw new Error('纯 stub 影响分析不应调用其他端口')
  }
  const context: LanguageToolContext = {
    abortSignal: new AbortController().signal,
    project: { getRootPath: () => '/unused', kernel: unused },
  }
  let importerCoverage = { truncated: false, fileListTruncated: false }
  const services: LanguageNavigationService[] = ['stub-ts', 'stub-py'].map((language) => ({
    id: language,
    label: language,
    extensions: [],
    findSymbols: async () => ({
      symbols: [
        {
          language,
          path: `${language}.ts`,
          name: 'value',
          kind: 'const',
          line: 1,
          column: 1,
          exported: true,
        },
      ],
      symbolCount: 1,
      scannedFiles: 1,
      scannedSymbols: 1,
      fileListTruncated: false,
      truncated: false,
    }),
    findReferences: async () => ({
      references: [{ language, path: `${language}.ts`, line: 2, column: 1, excerpt: 'value' }],
      referenceCount: 1,
      scannedFiles: 1,
      truncated: false,
    }),
    findImporters: async () => ({
      importers: [
        {
          language,
          path: `${language}.test.ts`,
          line: 1,
          column: 1,
          specifier: './value',
          isRelative: true,
          isTypeOnly: false,
          importedNames: ['value'],
          raw: "import { value } from './value'",
        },
      ],
      importerCount: 1,
      scannedFiles: 1,
      ...importerCoverage,
    }),
    listExports: unused,
    findImports: unused,
  }))
  const selected = spyOn(
    LanguageServiceRegistry.prototype,
    'selectLanguageServices'
  ).mockReturnValue(services)
  try {
    const queries = new LanguageQueries()
    const input = { action: 'analyze_symbol_impact', symbol: 'value', limit: 1 } as const
    const merged = (await queries.run(input, context)) as PlainObject
    expect(merged.references).toHaveLength(1)
    expect(merged.importers).toHaveLength(1)
    expect(merged.languages).toMatchObject([{ truncated: false }, { truncated: false }])
    expect(merged.truncated).toBe(true)

    selected.mockReturnValue([services[0]!])
    for (const coverage of [
      { truncated: true, fileListTruncated: false },
      { truncated: false, fileListTruncated: true },
      { truncated: false, fileListTruncated: false },
    ]) {
      importerCoverage = coverage
      const single = (await queries.run(input, context)) as PlainObject
      expect(single.truncated).toBe(coverage.truncated || coverage.fileListTruncated)
    }
  } finally {
    selected.mockRestore()
  }
})
