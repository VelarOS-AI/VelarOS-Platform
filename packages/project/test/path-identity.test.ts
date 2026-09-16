/**
 * 路径身份的回归：同一个物理文件的项目内别名（符号链接、大小写变体）不能当成两个文件，
 * 策略名单与宿主过滤器按身份判、按字面写法绕不过去，沙箱的源出不了项目，`.git` 缺省不许写。
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:process'

import { describe, expect, test } from 'bun:test'

import { createProjectKernel, type EditIntent, type ProjectKernel } from '../src/exports/index'
import type { CorePolicy } from '../src/types/policy'
import type { FileFilterInput } from '../src/types/provider'
import { resolveSourceInsideProject } from '../src/utils/agent/sandbox'

/** 盘区不区分大小写（macOS、Windows）：`.ENV` 和 `.env` 是同一个文件。 */
const caseInsensitiveVolume = platform === 'darwin' || platform === 'win32'

/** 建一个临时项目根，跑完删掉。 */
async function withRoot(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
  links: Record<string, string> = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'velaros-project-path-identity-'))
  try {
    for (const [relative, content] of Object.entries(files)) {
      await mkdir(join(root, relative, '..'), { recursive: true })
      await writeFile(join(root, relative), content)
    }
    for (const [link, target] of Object.entries(links)) await symlink(target, join(root, link))
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** 一条整行替换的编辑意图；行号要绑定当前磁盘 revision。 */
function replaceLine(path: string, baseRevision: string, line: number, text: string): EditIntent {
  return { operation: { type: 'replace_lines', path, baseRevision, startLine: line, endLine: line, newLines: [text] } }
}

/** 读出一个路径当前的 revision。 */
async function revisionOf(project: ProjectKernel, path: string): Promise<string> {
  return (await project.read({ path })).snapshot.revision
}

describe('同一个文件的项目内别名', () => {
  test('一次事务里两个入参指向同一个物理文件时，在写任何东西之前拒绝', async () => {
    await withRoot(
      { 'real.ts': 'L1\nL2\nL3\n' },
      async (root) => {
        const project = await createProjectKernel({ root })
        // 两条路径的 revision 都绑好：唯一该被拒的理由就是它们是同一个文件。
        await expect(
          project.prepareEdit({
            operations: [
              replaceLine('link.ts', await revisionOf(project, 'link.ts'), 1, 'A'),
              replaceLine('real.ts', await revisionOf(project, 'real.ts'), 3, 'B'),
            ],
          }),
        ).rejects.toMatchObject({
          reason: 'INVALID_INPUT',
          details: { paths: ['link.ts', 'real.ts'] },
          suggestedNextAction: expect.stringContaining('link.ts'),
        })
        expect(await readFile(join(root, 'real.ts'), 'utf8')).toBe('L1\nL2\nL3\n')
      },
      { 'link.ts': 'real.ts' },
    )
  })

  test('两个不同的文件照常一起改（别名判定不误伤）', async () => {
    await withRoot({ 'a.ts': 'L1\n', 'b.ts': 'L1\n' }, async (root) => {
      const project = await createProjectKernel({ root })
      const transaction = await project.prepareEdit({
        operations: [
          replaceLine('a.ts', await revisionOf(project, 'a.ts'), 1, 'X'),
          replaceLine('b.ts', await revisionOf(project, 'b.ts'), 1, 'Y'),
        ],
      })
      await project.applyEdit({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('X\n')
      expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe('Y\n')
    })
  })
})

describe('拒读拒写名单按路径身份判', () => {
  const policy: Partial<CorePolicy> = { readDeny: ['.env', 'secrets/**'], writeDeny: ['.env'] }

  test('经项目内的符号链接读被拒的文件同样被拒', async () => {
    await withRoot(
      { '.env': 'API_KEY=sk-live-SECRET\n', 'secrets/prod.key': 'PRIVATE-KEY\n' },
      async (root) => {
        const project = await createProjectKernel({ root, corePolicy: policy })
        await expect(project.read({ path: 'secrets/prod.key' })).rejects.toMatchObject({ reason: 'PERMISSION_DENIED' })
        await expect(project.read({ path: 'cfg/prod.key' })).rejects.toMatchObject({ reason: 'PERMISSION_DENIED' })
        await expect(project.read({ path: 'env.sample' })).rejects.toMatchObject({ reason: 'PERMISSION_DENIED' })
      },
      { cfg: 'secrets', 'env.sample': '.env' },
    )
  })

  test('大小写不敏感的盘上大小写变体同样被拒', async () => {
    if (!caseInsensitiveVolume) return
    await withRoot({ '.env': 'API_KEY=sk-live-SECRET\n', 'secrets/prod.key': 'PRIVATE-KEY\n' }, async (root) => {
      const project = await createProjectKernel({ root, corePolicy: policy })
      await expect(project.read({ path: '.ENV' })).rejects.toMatchObject({ reason: 'PERMISSION_DENIED' })
      await expect(project.read({ path: 'SECRETS/prod.key' })).rejects.toMatchObject({ reason: 'PERMISSION_DENIED' })
    })
  })

  test('宿主的可见性过滤器遮住的文件，经链接与大小写变体也读不出来', async () => {
    await withRoot(
      { 'secrets/prod.key': 'PRIVATE-KEY\n' },
      async (root) => {
        const hidden = (input: FileFilterInput): boolean => !input.path.startsWith('secrets/')
        const project = await createProjectKernel({
          root,
          providers: { fileFilter: { shouldInclude: hidden } },
        })
        await expect(project.read({ path: 'secrets/prod.key' })).rejects.toMatchObject({ reason: 'PERMISSION_DENIED' })
        await expect(project.read({ path: 'cfg/prod.key' })).rejects.toMatchObject({ reason: 'PERMISSION_DENIED' })
      },
      { cfg: 'secrets' },
    )
  })

  test('没有 deny 名单时不会误拒项目内的普通链接', async () => {
    await withRoot(
      { 'src/a.ts': 'export const a = 1\n' },
      async (root) => {
        const project = await createProjectKernel({ root })
        expect((await project.read({ path: 'alias/a.ts' })).content).toBe('export const a = 1\n')
      },
      { alias: 'src' },
    )
  })
})

describe('演练沙箱的源目录', () => {
  test('经项目内的符号链接指到项目外时按 PERMISSION_DENIED 拒绝', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'velaros-project-outside-'))
    try {
      await writeFile(join(outside, 'data.txt'), 'outside\n')
      await withRoot(
        { 'src/a.ts': 'export const a = 1\n' },
        async (root) => {
          await expect(resolveSourceInsideProject(root, 'link')).rejects.toMatchObject({
            reason: 'PERMISSION_DENIED',
          })
          // 项目之内的目录（含经链接指到项目内的）照常接受。
          expect(await resolveSourceInsideProject(root, 'src')).toBe(join(root, 'src'))
          expect(await resolveSourceInsideProject(root, 'inside')).toBe(join(root, 'inside'))
        },
        { link: outside, inside: 'src' },
      )
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('版本库内部缺省不许写', () => {
  test('改 .git 里的配置与钩子一律被拒，并说清楚该走 project:run', async () => {
    await withRoot({ '.git/config': '[core]\n', 'pkg/.git/config': '[core]\n' }, async (root) => {
      const project = await createProjectKernel({ root })
      for (const path of ['.git/config', '.git/hooks/pre-commit', 'pkg/.git/config']) {
        const transaction = await project.prepareEdit({
          operations: [{ operation: { type: 'create_file', path, content: 'x\n', overwrite: true } }],
        })
        await expect(project.applyEdit({ transactionId: transaction.transactionId })).rejects.toMatchObject({
          reason: 'PERMISSION_DENIED',
          suggestedNextAction: expect.stringContaining('project:run'),
        })
      }
      expect(await readFile(join(root, '.git/config'), 'utf8')).toBe('[core]\n')
      // 读不受影响：缺省只挡写。
      expect((await project.read({ path: '.git/config' })).content).toBe('[core]\n')
    })
  })

  test('缺省写策略就是合同常量表里那四条', async () => {
    await withRoot({ 'a.ts': 'a\n' }, async (root) => {
      const project = await createProjectKernel({ root })
      expect(project.policy.writeDeny).toEqual(['.git', '.git/**', '**/.git', '**/.git/**'])
    })
  })
})
