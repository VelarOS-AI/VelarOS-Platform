import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { projectToolFixture } from './support/tools'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'edit-guidance-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 在所有平台执行真实模板函数，端口仍走项目操作，不启动 POSIX 子进程。 */
async function template() {
  const { call } = await projectToolFixture({ root })
  const calls: string[] = []
  const source = await readFile(new URL('../template.js', import.meta.url), 'utf8')
  const imports = "import { edit, inspect, patch, select, undo } from 'velaros:project'"
  expect(source.split(imports)).toHaveLength(2)
  const bindings = Object.fromEntries(
    ['edit', 'inspect', 'patch', 'select', 'undo'].map((operation) => [
      operation,
      (input: unknown) => {
        calls.push(operation)
        return call('project', operation, input)
      },
    ])
  )
  const api = runInNewContext(
    `${source.replace(imports, '')}\n({replaceOnce, replaceMany, rewriteSymbol, commitFiles})`,
    bindings
  )
  return { api, calls, source }
}

test('局部删除与多处替换仅提交一次 edit，回执包含差量', async () => {
  await writeFile(join(root, 'a.txt'), 'note\nold\nkeep\n')
  const { api, calls } = await template()
  const result = await api.replaceMany([
    { path: 'a.txt', oldText: 'note\n', newText: '' },
    { path: 'a.txt', oldText: 'old', newText: 'new' },
  ])
  expect(calls).toEqual(['edit'])
  expect(result.changedFiles).toEqual(['a.txt'])
  expect(result.diff).toContain('+new')
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new\nkeep\n')
})

test('歧义替换不降级为全文覆盖，补上下文后才提交', async () => {
  await writeFile(join(root, 'a.txt'), 'left old\nright old\n')
  const { api, calls } = await template()
  await expect(api.replaceOnce('a.txt', 'old', 'new')).rejects.toMatchObject({
    code: 'AMBIGUOUS_TARGET',
  })
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('left old\nright old\n')
  await api.replaceOnce('a.txt', 'left old', 'left new')
  expect(calls).toEqual(['edit', 'edit'])
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('left new\nright old\n')
})

test('结构模板仅调用 select 和 patch', async () => {
  await writeFile(
    join(root, 'cache.py'),
    'class Cache:\n    def load(self, key):\n        return "old"\n'
  )
  const { api, calls } = await template()
  const result = await api.rewriteSymbol(
    'cache.py',
    'Cache.load',
    '    def load(self, key):\n        return "new"'
  )
  expect(calls).toEqual(['select', 'patch'])
  expect(result.status).toBe('applied')
  expect(await readFile(join(root, 'cache.py'), 'utf8')).toContain('return "new"')
})

test('计算生成保留原文冲突保护，模板禁止提交后重放及重复全文校验', async () => {
  await writeFile(join(root, 'a.txt'), 'external\n')
  const { api, calls, source } = await template()
  await expect(
    api.commitFiles([{ path: 'a.txt', before: 'old\n', after: 'generated\n' }])
  ).rejects.toMatchObject({
    code: 'BASE_REVISION_MISMATCH',
  })
  expect(calls).toEqual(['edit'])
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('external\n')
  expect(source).toContain('事务已提交后外层程序失败不能重放')
  expect(source).toContain('不重复写后全文校验')
})
