import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { defaultDenyApprovalPort } from '@velaros-ai/agent/tool-contract'

import { projectTools } from '../src/agent/Project.tool'
import type { ProjectToolContext } from '../src/agent/Types'
import { createProjectKernel, type ProjectKernel } from '../src/index'
import { ProjectToolNames } from '../src/project-tool-names'
import { createNodeCommandProvider } from '../src/providers/index'
import type { CommandRunResult } from '../src/types/provider'

// 根 .gitignore 忽略任意层级的 dist/；中间目录 pkg 的 .gitignore 再忽略 *.log。
const Fixture: Record<string, string> = {
  '.gitignore': 'dist/\n',
  'dist/root.js': 'root build\n',
  'pkg/.gitignore': '*.log\n',
  'pkg/dist/x.js': 'package build\n',
  'pkg/src/y.ts': 'export const y = 1\n',
  'pkg/src/debug.log': 'noise\n',
}

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'velaros-file-store-gitignore-'))
  for (const [relative, content] of Object.entries(Fixture)) {
    await mkdir(dirname(join(root, relative)), { recursive: true })
    await writeFile(join(root, relative), content)
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 记录每次 git check-ignore 的退出码，确认本轮走的是 git 引擎还是本地解析回退。 */
function kernelRecordingCheckIgnore(exitCodes: number[]): Promise<ProjectKernel> {
  const node = createNodeCommandProvider()
  return createProjectKernel({
    root,
    providers: {
      command: {
        async run(input): Promise<CommandRunResult> {
          const result = await node.run(input)
          if (input.command === 'git' && input.args?.[0] === 'check-ignore') exitCodes.push(result.exitCode)
          return result
        },
      },
    },
  })
}

async function listedPaths(project: ProjectKernel, input: Parameters<ProjectKernel['listFiles']>[0]): Promise<string[]> {
  return (await project.listFiles(input)).map((entry) => entry.path).sort()
}

const engines = [
  { name: 'git 仓库（git check-ignore）', gitRepository: true, expectedExitCodes: [0, 1] },
  { name: '非 git 目录（本地解析回退）', gitRepository: false, expectedExitCodes: [128] },
]

for (const engine of engines) {
  describe(`listFiles 的 gitignore 过滤：${engine.name}`, () => {
    let project: ProjectKernel
    let exitCodes: number[]

    beforeEach(async () => {
      if (engine.gitRepository) execFileSync('git', ['init', '-q'], { cwd: root })
      exitCodes = []
      project = await kernelRecordingCheckIgnore(exitCodes)
    })

    afterEach(() => {
      // 两种引擎各自被真正走到：git 分支只出现 0/1，回退分支是 git 报「不是仓库」后不再重试。
      expect(exitCodes.length).toBeGreaterThan(0)
      expect(exitCodes.every((code) => engine.expectedExitCodes.includes(code))).toBe(true)
    })

    test('从显式子目录开始列举时继承根目录与中间目录的规则', async () => {
      expect(await listedPaths(project, { path: 'pkg', recursive: true })).toEqual([
        'pkg/.gitignore',
        'pkg/src',
        'pkg/src/y.ts',
      ])
      expect(await listedPaths(project, { path: 'pkg/src' })).toEqual(['pkg/src/y.ts'])
    })

    test('从根目录遍历与从子目录开始对同一路径给出同一判定', async () => {
      const fromRoot = await listedPaths(project, { recursive: true })
      expect(fromRoot).not.toContain('dist')
      expect(fromRoot).not.toContain('pkg/dist')
      expect(fromRoot).not.toContain('pkg/src/debug.log')
      expect(fromRoot.filter((path) => path.startsWith('pkg/'))).toEqual(
        await listedPaths(project, { path: 'pkg', recursive: true }),
      )
    })

    test('忽略判定按层批量：一次递归列举的 git 调用数不超过层数', async () => {
      await project.listFiles({ recursive: true, maxDepth: 3 })
      expect(exitCodes.length).toBeLessThanOrEqual(3)
    })

    test('显式指向被忽略目录：缺省照常列出其内容，显式要求排除时为空', async () => {
      expect(await listedPaths(project, { path: 'pkg/dist' })).toEqual(['pkg/dist/x.js'])
      expect(await listedPaths(project, { path: 'pkg/dist', excludeGitignored: true })).toEqual([])
      expect(await listedPaths(project, { path: 'pkg', recursive: true, excludeGitignored: false })).toContain(
        'pkg/dist/x.js',
      )
    })
  })
}

test('project:list 显式子目录不列出被根 .gitignore 忽略的构建产物', async () => {
  execFileSync('git', ['init', '-q'], { cwd: root })
  const context = {
    abortSignal: new AbortController().signal,
    project: {
      getRootPath: () => root,
      kernel: async () => createProjectKernel({ root }),
    },
    system: { canStartBackgroundCommands: () => false },
    approval: defaultDenyApprovalPort,
  } as unknown as ProjectToolContext
  const result = await projectTools[ProjectToolNames.list].execute({ path: 'pkg', recursive: true }, context) as {
    entries: Array<{ path: string }>
  }

  expect(result.entries.map((entry) => entry.path)).not.toContain('pkg/dist/x.js')
  expect(result.entries.map((entry) => entry.path)).toContain('pkg/src/y.ts')
})
