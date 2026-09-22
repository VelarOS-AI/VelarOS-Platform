/**
 * 验收：`spec/invariants.md` 里每条「测试」档不变量各一个用例，用例名以编号开头。
 * 用真实的项目内核与真实的 TypeScript 程序跑，不做假替身。
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'

import { createProjectKernel } from '@velaros-ai/velaros/project'

import { typeScriptProjectPool } from '../impl/language/TypeScriptProjectPool'
import {
  createExternalLanguageService,
  createProjectCodeQuery,
  languageQueries,
  type LanguageReadPort,
  type LanguageToolContext,
  typeScriptProjects,
} from '../index'

// 用例跑真实类型检查，机器繁忙时会超过默认的 5 秒。
setDefaultTimeout(30_000)

/** 只读端口允许的三个方法；多一个都不给，借到别的能力就会当场崩。 */
const ReadPortMethods = ['listFiles', 'read', 'listSymbols']

let root = ''
let outside = ''

/** 一个导出两个函数、另有若干非导出声明的文件。 */
const SampleSource = `export function exportedOne(): number {
  return helperOne()
}

function helperOne(): number {
  return 1
}

export const exportedTwo: string = 'ok'
`

/** 带一个真实类型错误的文件：诊断要报得出来。 */
const BrokenSource = `export const counts: Record<string, number> = {}
export const broken: number = 'not a number'
`

async function createContext(projectRoot = root): Promise<LanguageToolContext> {
  const kernel = await createProjectKernel({ root: projectRoot, plugins: [] })
  return {
    abortSignal: new AbortController().signal,
    project: {
      getRootPath: () => projectRoot,
      kernel: async () => ({
        listFiles: kernel.listFiles.bind(kernel),
        read: kernel.read.bind(kernel),
        listSymbols: kernel.listSymbols.bind(kernel),
      }),
    },
  }
}

async function run(input: Record<string, unknown>, projectRoot = root): Promise<PlainObject> {
  return (await languageQueries.run(input as never, await createContext(projectRoot))) as PlainObject
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-development-acceptance-')))
  outside = await realpath(await mkdtemp(join(tmpdir(), 'velaros-development-acceptance-out-')))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(join(root, '..cache'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }))
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', lib: ['ES2022'], module: 'ESNext', strict: true },
      include: ['.'],
    })
  )
  await writeFile(join(root, 'src', 'sample.ts'), SampleSource)
  await writeFile(join(root, 'src', 'broken.ts'), BrokenSource)
  await writeFile(join(root, '..cache', 'cached.ts'), 'export const cached = 1\n')
  await writeFile(join(root, 'docs', 'guide.md'), '# fixture\n')
  // 引用扫描要越过 limit 才会提前停扫：多写几个文件，每个都提到同一个名字。
  for (let index = 0; index < 6; index += 1) {
    await writeFile(
      join(root, 'src', `user-${index}.ts`),
      `import { exportedOne } from './sample'\nexport const value${index} = exportedOne()\n`
    )
  }
  await writeFile(join(outside, 'secret.ts'), 'export const secret = 1\n')
  await symlink(outside, join(root, 'escape'))
})

afterAll(async () => {
  typeScriptProjects.release()
  const temporaryRoot = await realpath(tmpdir())
  await Promise.all(
    [root, outside]
      .filter((path) => path.startsWith(temporaryRoot))
      .map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('@velaros-ai/velaros/project 验收', () => {
  test('INV-30 语言查询只借读源码端口，别的能力一个都够不着', async () => {
    const kernel = await createProjectKernel({ root, plugins: [] })
    const touched = new Set<string>()
    // 端口上只有这三个方法，其余属性一律 undefined：借别的能力会当场崩。
    const readPort = new Proxy({} as LanguageReadPort, {
      get(_target, key) {
        if (typeof key !== 'string' || !ReadPortMethods.includes(key)) return undefined
        touched.add(key)
        return (kernel as unknown as Record<string, (...args: never[]) => unknown>)[key]!.bind(
          kernel
        )
      },
    })
    const context: LanguageToolContext = {
      abortSignal: new AbortController().signal,
      project: { getRootPath: () => root, kernel: async () => readPort },
    }

    const result = (await languageQueries.run(
      { action: 'find_symbols', query: 'exportedOne', exact: true },
      context
    )) as PlainObject

    expect(result.symbolCount).toBe(1)
    expect([...touched].sort()).toEqual(['listFiles', 'listSymbols', 'read'])
  })

  test('INV-31 代码图谱不可用时内置动作照常，图谱类动作抛 UNAVAILABLE', async () => {
    const queryCode = createProjectCodeQuery({ isAvailable: () => false, query: async () => null })
    const context = await createContext()

    const language = await queryCode(
      { action: 'find_symbols', query: 'exportedOne', exact: true },
      context as never
    )
    expect(language).toMatchObject({ source: 'language-service', symbolCount: 1 })

    const failure = await queryCode({ action: 'explore', nodeIds: ['n1'] }, context as never).then(
      () => null,
      (error: unknown) => error as { code?: string; message: string }
    )
    expect(failure?.code).toBe('UNAVAILABLE')
    expect(failure?.message).toContain('CodeGraph')
  })

  test('INV-32 没扫到文件时明说原因，空结果不伪装成全部通过', async () => {
    const result = await run({ action: 'language_diagnostics', path: 'docs' })

    expect(result.diagnosticCount).toBe(0)
    expect(result.scannedFiles).toBe(0)
    expect(String(result.note)).toContain('这不代表代码没有错误')
  })

  test('INV-33 目录诊断与单文件诊断给出同一份结果', async () => {
    const single = await run({ action: 'language_diagnostics', path: 'src/broken.ts', limit: 50 })
    const directory = await run({ action: 'language_diagnostics', path: 'src', limit: 50 })
    const codesOf = (payload: PlainObject): unknown[] =>
      (payload.diagnostics as Array<{ path: string; severity: string; code?: number }>)
        .filter((entry) => entry.path === 'src/broken.ts' && entry.severity === 'error')
        .map((entry) => entry.code)

    expect(codesOf(single)).toEqual([2322])
    expect(codesOf(directory)).toEqual([2322])
    expect(single.degraded).toBeUndefined()
    expect(directory.degraded).toBeUndefined()
  })

  test('INV-34 外部语言服务只启动规格里的命令，越界路径一律拒', async () => {
    const service = createExternalLanguageService(root, [
      {
        id: 'missing-test-server',
        command: 'velaros-definitely-missing-language-server',
        args: [],
        extensions: ['.foo'],
        languageId: 'foo',
      },
    ])
    await writeFile(join(root, 'sample.foo'), 'example\n')

    expect(service.supports('sample.foo')).toBe(true)
    expect(service.supports('src/sample.ts')).toBe(false)
    expect(await service.diagnostics(['sample.foo'])).toEqual([])
    // 命令没装不算「等到超时」：这次结果仍然完整，只是没有诊断能力。
    expect(service.status()).toMatchObject({
      state: 'unavailable',
      diagnosticsComplete: true,
      diagnosticsTimedOutFiles: 0,
    })
    await expect(service.hover(join(outside, 'secret.ts'), 1, 1)).rejects.toThrow('越出了项目边界')
    await service.stop()
  })

  test('INV-35 项目里的 ..cache 目录照常查询，符号链接指到项目外的路径被拒', async () => {
    const inside = await run({ action: 'language_diagnostics', path: '..cache/cached.ts' })
    expect(inside.scannedFiles).toBe(1)

    await expect(run({ action: 'language_diagnostics', path: 'escape/secret.ts' })).rejects.toThrow(
      '路径在项目之外'
    )
    await expect(run({ action: 'language_diagnostics', path: '../secret.ts' })).rejects.toThrow(
      '路径在项目之外'
    )
  })

  test('INV-36 提前停扫时引用数标成「至少」并写明原因', async () => {
    const complete = await run({ action: 'find_references', symbol: 'exportedOne', limit: 100 })
    expect(complete.referenceCount).toBeGreaterThan(0)
    expect(complete.referenceCountIsLowerBound).toBeUndefined()
    expect(complete.note).toBeUndefined()

    const stopped = await run({ action: 'find_references', symbol: 'exportedOne', limit: 2 })
    expect(stopped.referenceCountIsLowerBound).toBe(true)
    expect(String(stopped.note)).toContain('引用数是下限')
  })

  test('INV-37 认不出的 language 当场失败并列出可用值', async () => {
    await expect(run({ action: 'find_symbols', language: 'cobol' })).rejects.toThrow(
      /没有对应的语言服务，可用：.*jsts.*python/u
    )
    const resolved = await run({ action: 'find_symbols', language: 'typescript', limit: 1 })
    expect(resolved.services).toEqual([{ id: 'jsts', label: 'JavaScript / TypeScript' }])
  })

  test('INV-38 宿主释放语言服务池后旧凭据自报失效', async () => {
    const requestPath = join(root, 'src', 'broken.ts')
    const lease = typeScriptProjectPool.acquire(root, requestPath, [requestPath], new Map())
    expect(lease.isCurrent()).toBe(true)

    typeScriptProjects.release(root)
    expect(lease.isCurrent()).toBe(false)

    const next = typeScriptProjectPool.acquire(root, requestPath, [requestPath], new Map())
    expect(next.isCurrent()).toBe(true)
    typeScriptProjects.release()
    expect(next.isCurrent()).toBe(false)
  })
})
