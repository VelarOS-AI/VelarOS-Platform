/**
 * 语言查询的路径准入：项目里名叫 `..xxx` 的目录不算越界，经符号链接指向项目外的路径要拒。
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'

import { createProjectKernel } from '@velaros-ai/velaros/project'

import { languageQueries, type LanguageToolContext, typeScriptProjects } from '../src/index'

setDefaultTimeout(30_000)

let root = ''
let outside = ''

async function createContext(projectRoot: string): Promise<LanguageToolContext> {
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

async function diagnose(path: string): Promise<{ scannedFiles: number; note?: string }> {
  return (await languageQueries.run(
    { action: 'language_diagnostics', path },
    await createContext(root)
  )) as unknown as { scannedFiles: number; note?: string }
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-development-boundary-')))
  outside = await realpath(await mkdtemp(join(tmpdir(), 'velaros-development-outside-')))

  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }))
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', lib: ['ES2022'], module: 'ESNext', strict: true },
      include: ['.'],
    })
  )
  // 名字以 `..` 开头的真实目录：老写法的 `relative().startsWith('..')` 会把它误判成越界。
  await mkdir(join(root, '..cache'), { recursive: true })
  await writeFile(join(root, '..cache', 'cached.ts'), 'export const cached = 1\n')
  await writeFile(join(outside, 'secret.ts'), 'export const secret = 1\n')
  await symlink(outside, join(root, 'escape'))
})

afterAll(async () => {
  typeScriptProjects.release()
  // 只删本测试自己在系统临时目录下建的目录
  const temporaryRoot = await realpath(tmpdir())
  await Promise.all(
    [root, outside]
      .filter((path) => path.startsWith(temporaryRoot))
      .map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('语言查询的项目边界', () => {
  test('项目里名叫 ..xxx 的目录照常诊断，不被当成越界', async () => {
    const result = await diagnose('..cache/cached.ts')

    expect(result.scannedFiles).toBe(1)
  })

  test('经符号链接指向项目外的路径被拒', async () => {
    await expect(diagnose('escape/secret.ts')).rejects.toThrow(/路径在项目之外/u)
  })

  test('字面越界的路径同样被拒', async () => {
    await expect(diagnose('../secret.ts')).rejects.toThrow(/路径在项目之外/u)
  })
})
