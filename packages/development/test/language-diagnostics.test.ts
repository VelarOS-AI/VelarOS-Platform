import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import * as ts from 'typescript'

import { typescriptPlugin } from '@velaros-ai/project/changes'
import { createProjectKernel } from '@velaros-ai/project/runtime'

import {
  configureTypeScriptLibraryDirectory,
  executeProjectCodeLanguageQuery,
  type LanguageToolContext,
} from '../src'
import {
  clearTypeScriptProjectCache,
  groupFilesByTypeScriptProject,
} from '../src/runtime/TypeScriptProjectHost'

// 用例跑的是真实类型检查与数百个文件的夹具，机器繁忙时会超过默认的 5 秒。
setDefaultTimeout(30_000)

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
let workspace = ''
let scratch = ''

type KernelAssembly = 'core' | 'typescript-plugin'

async function createContext(
  assembly: KernelAssembly,
  projectRoot = root
): Promise<LanguageToolContext> {
  // Workbench 只装 corePlugin，Desktop 额外装 TS 插件；两种装配都必须能列出目录源文件。
  const kernel = await createProjectKernel({
    root: projectRoot,
    plugins: assembly === 'typescript-plugin' ? [typescriptPlugin()] : [],
  })
  return {
    abortSignal: new AbortController().signal,
    project: {
      getRootPath: () => projectRoot,
      runInDirectory: async (_path, action) => action(),
      kernel: async () => ({
        listFiles: kernel.listFiles.bind(kernel),
        read: kernel.read.bind(kernel),
        listSymbols: kernel.listSymbols.bind(kernel),
      }),
    },
  }
}

interface DiagnosticsInput {
  path: string
  extensions?: string[]
  limit?: number
  language?: string
}

async function diagnoseWith(
  context: LanguageToolContext,
  input: DiagnosticsInput
): Promise<DiagnosticsPayload> {
  return (await executeProjectCodeLanguageQuery(
    { action: 'language_diagnostics', ...input },
    context
  )) as unknown as DiagnosticsPayload
}

async function diagnose(
  input: DiagnosticsInput,
  assembly: KernelAssembly = 'core',
  projectRoot = root
): Promise<DiagnosticsPayload> {
  return diagnoseWith(await createContext(assembly, projectRoot), input)
}

/** 内核列完文件后执行 onListed：把动作排进事件循环，恰好落在目录诊断的第一个文件之前。 */
async function createWorkspaceContextWithListHook(
  onListed: () => void,
  abortSignal = new AbortController().signal
): Promise<LanguageToolContext> {
  const base = await createContext('core', workspace)
  const kernel = await base.project.kernel()
  return {
    abortSignal,
    project: {
      ...base.project,
      kernel: async () => ({
        ...kernel,
        listFiles: async (input) => {
          const entries = await kernel.listFiles(input)
          onListed()
          return entries
        },
      }),
    },
  }
}

function errorCodes(result: DiagnosticsPayload): Array<[string, LooseOptional<number>]> {
  return result.diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => [diagnostic.path, diagnostic.code])
}

async function writeFiles(baseDirectory: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(baseDirectory, path)), { recursive: true })
    await writeFile(join(baseDirectory, path), content)
  }
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

  // 多配置工作区：根配置把 pkg/src 也拉进自己的程序（非 strict），pkg 自己的配置是 strict；
  // pkg/tests 不属于任何配置的 include，按最近的 pkg 配置诊断。
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'velaros-language-diagnostics-ws-')))
  const baseOptions = { target: 'ES2022', lib: ['ES2022'], module: 'ESNext' }
  await writeFiles(workspace, {
    'package.json': JSON.stringify({ name: 'workspace', type: 'module' }),
    'tsconfig.json': JSON.stringify({
      compilerOptions: baseOptions,
      include: ['app.ts', 'pkg/src'],
    }),
    'app.ts': 'export const app = 1\n',
    'pkg/tsconfig.json': JSON.stringify({
      compilerOptions: { ...baseOptions, strict: true },
      include: ['src'],
    }),
    'pkg/src/b.ts': 'export function f(x) { return x }\n',
    'pkg/tests/t0.ts': TypedSource,
    'pkg/tests/t1.ts': "import { f } from '../src/b'\nexport const same = f(1)\n",
    'pkg/tests/t2.ts': 'export const size = new Set<string>().size\n',
    'pkg/tests/helper.js': 'export const helper = () => 1\n',
    'pkg/.gitignore': 'dist/\n',
    'pkg/dist/index.d.ts': 'export declare const built: MissingBuildType\n',
  })
})

afterEach(() => {
  ts.sys.getExecutingFilePath = originalExecutingFilePath
  // Electron 的类型把 resourcesPath 声明为只读必选，delete 运算符过不了类型检查。
  Reflect.deleteProperty(process, 'resourcesPath')
  configureTypeScriptLibraryDirectory(null)
})

afterAll(async () => {
  clearTypeScriptProjectCache()
  await Promise.all(
    [root, workspace, scratch].map((path) => rm(path, { recursive: true, force: true }))
  )
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

  test('候选目录缺少标准库引用闭包中的文件时不算命中', async () => {
    // 夹具 tsconfig 的 lib 是 ES2022：目录里有默认库与 lib.es2022.d.ts，却缺它们经
    // `/// <reference lib>` 引用的 es2021/es2015.collection 等文件，Record/Set 照样会缺席。
    const partialLibraryDirectory = join(scratch, 'partial-lib')
    await mkdir(partialLibraryDirectory, { recursive: true })
    for (const fileName of ['lib.es2022.full.d.ts', 'lib.es2022.d.ts']) {
      await symlink(join(bundledLibraryDirectory, fileName), join(partialLibraryDirectory, fileName))
    }
    simulatePackagedTypeScript()
    configureTypeScriptLibraryDirectory(partialLibraryDirectory)

    const result = await diagnose({ path: 'src/typed.ts' })

    expect(result.degraded).toContain('未找到 TypeScript 标准库声明')
    expect(result.diagnostics).toEqual([])
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
    expect(filtered.note).toContain('没有扩展名为 tsx')

    const unsupported = await diagnose({ path: 'src', extensions: ['vue'] })
    expect(unsupported.scannedFiles).toBe(0)
    expect(unsupported.note).toContain('extensions: vue')

    const markdown = await diagnose({ path: 'docs/README.md' })
    expect(markdown.scannedFiles).toBe(0)
    expect(markdown.note).toBeString()
  })

  test('extensions 混入非 JS/TS 扩展名时只诊断 JS/TS 文件，并说明被忽略的扩展名', async () => {
    await writeFiles(root, {
      'src/comp.vue': '<template><div /></template>\n',
      'src/data.json': '{ "answer": 42 }\n',
    })
    try {
      for (const extension of ['vue', 'json']) {
        const result = await diagnose({ path: 'src', extensions: ['ts', extension] })
        expect(result.scannedFiles).toBe(3)
        expect(errorCodes(result)).toEqual([
          ['src/nested/deep.ts', 2322],
          ['src/typed.ts', 2322],
        ])
        expect(result.note).toContain(`不处理扩展名 ${extension}`)
      }

      // 显式指定 jsts 服务时，extensions 里一个 JS/TS 扩展名都没有也要说明，而不是退回全部扩展名。
      const onlyVue = await diagnose({ path: 'src', extensions: ['vue'], language: 'jsts' })
      expect(onlyVue.scannedFiles).toBe(0)
      expect(onlyVue.note).toContain('extensions 里没有 JavaScript/TypeScript 扩展名')
    } finally {
      await rm(join(root, 'src', 'comp.vue'), { force: true })
      await rm(join(root, 'src', 'data.json'), { force: true })
    }
  })

  test('没有 .gitignore 时也跳过依赖与构建目录，显式指向其中时照常诊断', async () => {
    // 夹具根目录不在 git 仓库里、也没有 .gitignore：只能靠目录名剪枝挡住依赖与构建产物。
    await writeFiles(root, {
      'app/src/a.ts': "export const a: number = 'a'\n",
      'app/node_modules/dep/index.js': 'export const = 1\n',
      'app/dist/bundle.js': 'export const = 1\n',
    })
    try {
      const app = await diagnose({ path: 'app' })
      expect(app.scannedFiles).toBe(1)
      expect(app.note).toBeUndefined()
      expect(errorCodes(app)).toEqual([['app/src/a.ts', 2322]])

      const dependency = await diagnose({ path: 'app/node_modules/dep' })
      expect(dependency.scannedFiles).toBe(1)
      expect(dependency.diagnostics.map((diagnostic) => diagnostic.path)).toContain(
        'app/node_modules/dep/index.js'
      )

      // 只剩剪枝目录里的 JS 文件时，0 文件说明要点明跳过了哪些目录。
      const pruned = await diagnose({ path: 'app', extensions: ['js'] })
      expect(pruned.scannedFiles).toBe(0)
      expect(pruned.note).toContain('node_modules')
    } finally {
      await rm(join(root, 'app'), { recursive: true, force: true })
    }
  })

  test('不存在的路径显式失败', async () => {
    await expect(diagnose({ path: 'src/missing' })).rejects.toThrow('诊断路径不存在')
  })

  test('目录与非源文件不挤占文件名额，深处的真错误照样报出', async () => {
    const nested = join(root, 'src', 'modules')
    try {
      // 150 个子目录各带 index.ts 与 README.md：目录 + 文件条目远超 200，源文件只有 150 个。
      for (let index = 0; index < 150; index += 1) {
        const directory = join(nested, `m${String(index).padStart(3, '0')}`)
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'README.md'), '# module\n')
        await writeFile(
          join(directory, 'index.ts'),
          index === 149 ? 'export const x: number = "bad"\n' : `export const v${index} = ${index}\n`
        )
      }

      const result = await diagnose({ path: 'src/modules' })

      expect(result.scannedFiles).toBe(150)
      expect(result.truncated).toBe(false)
      expect(result.note).toBeUndefined()
      expect(errorCodes(result)).toEqual([['src/modules/m149/index.ts', 2322]])
    } finally {
      await rm(nested, { recursive: true, force: true })
    }
  })

  test('源文件超过上限时截断并说明，错误排在提示之前', async () => {
    const bulk = join(root, 'src', 'bulk')
    try {
      // 41 个子目录 × 5 个文件 = 205 个源文件，外加每个目录一份非源文件。每个目录的 file4 带真错误，
      // 其余文件各带一条「声明未使用」提示：按路径排序提示在前，验证结果按严重度优先。
      for (let group = 0; group < 41; group += 1) {
        const directory = join(bulk, `g${String(group).padStart(2, '0')}`)
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'notes.txt'), 'not source\n')
        for (let index = 0; index < 5; index += 1) {
          await writeFile(
            join(directory, `file${index}.ts`),
            index === 4
              ? 'export const wrong: boolean = 0\n'
              : `export function f${index}(): void {\n  const unused = ${index}\n}\n`
          )
        }
      }

      const result = await diagnose({ path: 'src/bulk', limit: 5 })

      expect(result.scannedFiles).toBe(200)
      expect(result.truncated).toBe(true)
      expect(result.note).toContain('源文件超过 200 个')
      expect(result.note).toContain('缩小 path')
      expect(result.diagnosticCount).toBeGreaterThan(5)
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        2322, 2322, 2322, 2322, 2322,
      ])
    } finally {
      await rm(bulk, { recursive: true, force: true })
    }
  })

  test('跳过 .gitignore 忽略的构建产物', async () => {
    const result = await diagnose({ path: 'pkg' }, 'core', workspace)

    expect(result.diagnostics.map((diagnostic) => diagnostic.path)).not.toContain(
      'pkg/dist/index.d.ts'
    )
    expect(result.scannedFiles).toBe(5)
  })
})

describe('language_diagnostics 多配置与并发', () => {
  test('文件按所属配置诊断，单文件与目录模式结果一致', async () => {
    for (const path of ['pkg/src/b.ts', 'pkg', '.']) {
      const result = await diagnose({ path }, 'core', workspace)
      expect([path, errorCodes(result)]).toEqual([
        path,
        expect.arrayContaining([['pkg/src/b.ts', 7006]]),
      ])
    }
  })

  test('同一配置的文件合为一组，JS 与 TS 分组', () => {
    const paths = [
      'app.ts',
      'pkg/src/b.ts',
      'pkg/tests/t0.ts',
      'pkg/tests/helper.js',
      'pkg/tests/t1.ts',
    ]
    const groups = groupFilesByTypeScriptProject(
      workspace,
      paths.map((path) => join(workspace, path))
    )

    expect(groups.map((group) => group.map((path) => path.slice(workspace.length + 1)))).toEqual([
      ['app.ts'],
      ['pkg/src/b.ts', 'pkg/tests/t0.ts', 'pkg/tests/t1.ts'],
      ['pkg/tests/helper.js'],
    ])
  })

  test('配置之外的文件在所属配置下整组诊断', async () => {
    const result = await diagnose({ path: 'pkg/tests' }, 'core', workspace)

    expect(result.scannedFiles).toBe(4)
    expect(result.degraded).toBeUndefined()
    expect(errorCodes(result)).toEqual([['pkg/tests/t0.ts', 2322]])
    expectNoStandardLibraryNoise(result)
  })

  test('文件之间让出事件循环，中止信号在扫描中途生效', async () => {
    const controller = new AbortController()
    // 同步跑完整个目录的实现只会在返回结果之后才执行这个宏任务。
    const context = await createWorkspaceContextWithListHook(
      () => setImmediate(() => controller.abort()),
      controller.signal
    )

    await expect(diagnoseWith(context, { path: 'pkg' })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  // 在目录诊断的第一个文件之前插入一次单文件查询：b.ts 与本组同池，会把本组不在磁盘快照里的
  // overlay 回收掉；helper.js 强制 allowJs、改变配置指纹，会 dispose 本组持有的服务。
  const interferences: Array<[string, string, Array<[string, number]>]> = [
    ['回收本组 overlay', 'pkg/src/b.ts', [['pkg/src/b.ts', 7006]]],
    ['dispose 本组服务', 'pkg/tests/helper.js', []],
  ]
  for (const [interference, path, expectedErrors] of interferences) {
    test(`让出期间并发查询${interference}后，目录诊断仍然完整`, async () => {
      // 先由只拥有 src 的请求建池：tests 文件只作为 overlay 进入程序，而不在磁盘快照里。
      clearTypeScriptProjectCache()
      await diagnose({ path: 'pkg/src/b.ts' }, 'core', workspace)
      const concurrentContext = await createContext('core', workspace)
      let concurrent: Nullable<Promise<DiagnosticsPayload>> = null
      const context = await createWorkspaceContextWithListHook(() =>
        setImmediate(() => {
          concurrent = diagnoseWith(concurrentContext, { path })
        })
      )

      // 只选 TS 文件让整个目录成为一组，干扰恰好落在本组 acquire 之后、第一个文件诊断之前。
      const tests = await diagnoseWith(context, { path: 'pkg/tests', extensions: ['ts'] })

      expect(tests.scannedFiles).toBe(3)
      expect(errorCodes(tests)).toEqual([['pkg/tests/t0.ts', 2322]])
      expectNoStandardLibraryNoise(tests)
      const interfering = await concurrent!
      expect(interfering.scannedFiles).toBe(1)
      expect(errorCodes(interfering)).toEqual(expectedErrors)
    })
  }
})
