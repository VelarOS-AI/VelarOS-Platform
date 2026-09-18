/**
 * 路径身份的回归：同一个物理文件的项目内别名（符号链接、大小写变体）不能当成两个文件，
 * 宿主的列举过滤器按身份判（经链接的别名也列不出来）、点名读写从不问它，沙箱的源出不了项目，内核没有读写名单。
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createProjectKernel, type EditIntent, type ProjectKernel } from '../index'
import type { FileFilterInput } from '../types/provider'
import { insideProject } from '../utils/agent/ports'

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

describe('宿主的列举过滤器只管列举', () => {
  /** 宿主不想列 secrets 目录：它本身和它下面的都不列。 */
  const hidden = (input: FileFilterInput): boolean => input.path !== 'secrets' && !input.path.startsWith('secrets/')

  test('列举与搜索略过它遮住的条目，经项目内链接的别名也略过；点名读照常读得到', async () => {
    await withRoot(
      { 'secrets/prod.key': 'PRIVATE-KEY\n', 'src/a.ts': 'export const a = 1\n' },
      async (root) => {
        const project = await createProjectKernel({ root, providers: { fileFilter: { shouldInclude: hidden } } })
        const listed = (await project.listFiles({ recursive: true })).map((entry) => entry.path)
        expect(listed).toContain('src/a.ts')
        expect(listed.some((path) => path.startsWith('secrets') || path.startsWith('cfg'))).toBe(false)
        const found = await project.search({ query: 'PRIVATE-KEY', useRipgrep: false })
        expect(found.hits).toEqual([])
        expect((await project.read({ path: 'secrets/prod.key' })).content).toBe('PRIVATE-KEY\n')
        expect((await project.read({ path: 'cfg/prod.key' })).content).toBe('PRIVATE-KEY\n')
        // 点名列那个目录：点名的起点下面不问过滤器。
        expect((await project.listFiles({ path: 'secrets' })).map((entry) => entry.path)).toEqual(['secrets/prod.key'])
      },
      { cfg: 'secrets' },
    )
  })

  test('没有过滤器时不会误拒项目内的普通链接', async () => {
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
          // 端口这一层说的是能力那边认的码：项目内的链接指到项目外，一律 PERMISSION。
          await expect(insideProject(root, 'link', '沙箱的源目录')).rejects.toMatchObject({ code: 'PERMISSION' })
          // 项目之内的目录（含经链接指到项目内的）照常接受。
          expect((await insideProject(root, 'src', '沙箱的源目录')).resolved).toBe(join(root, 'src'))
          expect((await insideProject(root, 'inside', '沙箱的源目录')).resolved).toBe(join(root, 'inside'))
        },
        { link: outside, inside: 'src' },
      )
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('内核没有读写名单', () => {
  test('.git 里的文件、.env 这类照常能读能写：只受根内约束', async () => {
    await withRoot({ '.git/info/exclude': '# local\n', '.env': 'API_KEY=local\n' }, async (root) => {
      const project = await createProjectKernel({ root })
      expect((await project.read({ path: '.env' })).content).toBe('API_KEY=local\n')
      const transaction = await project.prepareEdit({
        operations: [{ operation: { type: 'create_file', path: '.git/info/exclude', content: '# local\nscratch/\n', overwrite: true } }],
      })
      await project.applyEdit({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, '.git/info/exclude'), 'utf8')).toBe('# local\nscratch/\n')
    })
  })
})
