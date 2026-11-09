import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { resolveRealPath } from '../src/utils/RealPath'

let root = ''

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-real-path-')))
  await mkdir(join(root, 'inside'))
  await mkdir(join(root, 'outside'))
  await writeFile(join(root, 'outside', 'file.txt'), 'x')
  await symlink(join(root, 'outside'), join(root, 'inside', 'escape'))
  await symlink(join(root, 'outside', 'missing.txt'), join(root, 'inside', 'dangling'))
  await symlink(join(root, 'inside', 'dangling'), join(root, 'inside', 'chain'))
  await symlink(join(root, 'inside', 'loop-b'), join(root, 'inside', 'loop-a'))
  await symlink(join(root, 'inside', 'loop-a'), join(root, 'inside', 'loop-b'))
})

afterAll(async () => {
  // 只删本测试自己在系统临时目录下建的目录
  if (root.startsWith(await realpath(tmpdir()))) await rm(root, { recursive: true, force: true })
})

describe('resolveRealPath', () => {
  test.skipIf(process.platform !== 'win32')(
    '真实盘根保持绝对路径，未创建的尾段不吸附盘符当前目录',
    async () => {
      const driveRoot = parse(root).root
      const missing = join(driveRoot, basename(root), 'not-created', 'file.txt')
      const expected = [driveRoot, missing]
      const values = await Promise.all(expected.map(resolveRealPath))
      expect(values).toEqual(expected)
      expect(values.every(isAbsolute)).toBe(true)

      const node = spawnSync(
        'node',
        [
          '--input-type=module',
          '-e',
          "import {resolveRealPath} from '@velaros-ai/core/utils/RealPath';process.stdout.write(JSON.stringify(await Promise.all(process.argv.slice(1).map(resolveRealPath))))",
          ...expected,
        ],
        {
          cwd: fileURLToPath(new URL('../', import.meta.url)),
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        }
      )
      expect(node.error).toBeUndefined()
      expect(node.status).toBe(0)
      expect(JSON.parse(node.stdout)).toEqual(expected)
    }
  )

  test('存在的路径解开符号链接', async () => {
    expect(await resolveRealPath(join(root, 'inside', 'escape', 'file.txt'))).toBe(
      join(root, 'outside', 'file.txt')
    )
  })

  test('还不存在的尾巴接在最近一个存在的祖先后面', async () => {
    expect(await resolveRealPath(join(root, 'inside', 'new', 'deep', 'a.txt'))).toBe(
      join(root, 'inside', 'new', 'deep', 'a.txt')
    )
    expect(await resolveRealPath(join(root, 'inside', 'escape', 'new.txt'))).toBe(
      join(root, 'outside', 'new.txt')
    )
  })

  test('悬空的符号链接照它指向的路径解，链式的也追到底', async () => {
    expect(await resolveRealPath(join(root, 'inside', 'dangling'))).toBe(
      join(root, 'outside', 'missing.txt')
    )
    expect(await resolveRealPath(join(root, 'inside', 'chain'))).toBe(
      join(root, 'outside', 'missing.txt')
    )
  })

  test('链接成环时返回字面路径，不死循环', async () => {
    expect(await resolveRealPath(join(root, 'inside', 'loop-a'))).toBe(
      join(root, 'inside', 'loop-a')
    )
  })

  test('相对路径先按当前目录规整', async () => {
    expect(await resolveRealPath('.')).toBe(await realpath(process.cwd()))
  })
})
