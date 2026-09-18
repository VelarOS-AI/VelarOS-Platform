import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createProjectSpace } from '../src/index'

/** 空间包的源码根。 */
const SourceRoot = resolve(import.meta.dir, '../src')

describe('项目空间的边界', () => {
  test('操作表只有五个命名空间，各自只有声明里的那几个操作', () => {
    const { operations } = createProjectSpace({ resolveCall: () => { throw new Error('只看操作表，不调用') } })
    expect(Object.fromEntries(Object.entries(operations).map(([namespace, table]) => [namespace, Object.keys(table)]))).toEqual({
      project: ['read', 'list', 'search', 'edit', 'inspect', 'undo'],
      code: ['query', 'analyze'],
      shell: ['run', 'listTasks', 'refreshEnvironment'],
      sandbox: ['create', 'run', 'diff', 'apply', 'discard'],
      images: ['view'],
    })
  })

  test('宿主端口在工具的空间端口之上只加共用能力要的东西', () => {
    const source = readFileSync(resolve(SourceRoot, 'contract/requires.ts'), 'utf8')
    const port = source.slice(source.indexOf('export interface ProjectHostPort'), source.indexOf('export interface ProjectSandboxPort'))
    expect(port).toContain('extends ProjectSpacePort')
    for (const field of ['runCommand', 'listBackgroundTasks', 'refreshShellEnvironment', 'sandbox?', 'resizeImage?']) expect(port).toContain(`${field}:`)
  })
})
