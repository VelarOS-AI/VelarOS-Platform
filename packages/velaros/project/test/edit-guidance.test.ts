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
  const imports = "import { commit, inspect, undo } from 'velaros:project'"
  expect(source.split(imports)).toHaveLength(2)
  const bindings = Object.fromEntries(
    ['commit', 'inspect', 'undo'].map((operation) => [
      operation,
      (input: unknown) => {
        calls.push(operation)
        return call('project', operation, input)
      },
    ])
  )
  const api = runInNewContext(
    `${source.replace(imports, '')}\n({replaceOnce, commitFiles, inspectLatest})`,
    bindings
  )
  return { api, calls, source }
}

test('局部删除与多处替换仅提交一次 commit，回执包含差量', async () => {
  await writeFile(join(root, 'a.txt'), 'note\nold\nkeep\n')
  const { api, calls } = await template()
  const result = await api.commitFiles([
    { path: 'a.txt', oldText: 'note\n', newText: '' },
    { path: 'a.txt', oldText: 'old', newText: 'new' },
  ])
  expect(calls).toEqual(['commit'])
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
  expect(calls).toEqual(['commit', 'commit'])
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('left new\nright old\n')
})

test('最近事务的差量来自提交时刻，无需重读已改变的文件', async () => {
  await writeFile(join(root, 'a.txt'), 'before')
  const { api, calls } = await template()
  await api.replaceOnce('a.txt', 'before', 'after')
  await writeFile(join(root, 'a.txt'), 'external')
  expect((await api.inspectLatest()).diff).toContain('+after')
  expect(calls).toEqual(['commit', 'inspect'])
})

test('计算生成保留原文冲突保护，模板禁止提交后重放及重复全文校验', async () => {
  await writeFile(join(root, 'a.txt'), 'external\n')
  const { api, calls } = await template()
  await expect(
    api.commitFiles([{ path: 'a.txt', before: 'old\n', after: 'generated\n' }])
  ).rejects.toMatchObject({
    code: 'BASE_REVISION_MISMATCH',
  })
  expect(calls).toEqual(['commit'])
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('external\n')
  expect(
    await api.inspectLatest().then(
      () => true,
      () => false
    )
  ).toBe(false)
})
