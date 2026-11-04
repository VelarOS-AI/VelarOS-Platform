import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { searchFiles } from '../utils/agent/file-reads'

import { failureOf, projectToolFixture } from './support/tools'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-search-page-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('定位页多文件计数、稳定翻页和按行续读；默认仍返回全部正文', async () => {
  await writeFile(join(root, 'a.txt'), 'needle\nneedle\n')
  await writeFile(join(root, 'b.txt'), 'other\nneedle\n')
  const { call } = await projectToolFixture({ root })
  const first = await call('project', 'search', { query: 'needle', page: { limit: 2 } })
  expect(first.files).toEqual([])
  expect(first.page).toEqual({
    offset: 0,
    limit: 2,
    total: 3,
    totalFiles: 2,
    hasMore: true,
    nextOffset: 2,
    consistency: 'live',
    groups: [{ path: 'a.txt', count: 2, returned: 2 }],
  })
  const last = await call('project', 'search', {
    query: 'needle',
    page: { offset: first.page.nextOffset, limit: 2 },
  })
  expect(last.hits.map((hit) => [hit.path, hit.range.startLine])).toEqual([['b.txt', 2]])
  expect(last.page.hasMore).toBe(false)
  expect(last.page.nextOffset).toBeUndefined()
  const hit = last.hits[0]
  const read = await call('project', 'read', {
    files: [{ path: hit.path, range: [hit.range.startLine, hit.range.endLine] }],
  })
  expect(read.files[0].text).toBe('needle\n')
  expect(read.files[0].revision).toBe(hit.revision)
  const full = await call('project', 'search', { query: 'needle' })
  expect(full.hits).toHaveLength(3)
  expect(full.files.length).toBeGreaterThan(0)
  expect(full.page).toBeUndefined()
})

test('密集命中只交回有界位置，长行没有正文或 snippet，也不额外取窗口', async () => {
  await writeFile(join(root, 'dense.txt'), 'needle\n'.repeat(250))
  await writeFile(join(root, 'long.txt'), `${'x'.repeat(100000)}needle\n`)
  const { context, kernel } = await projectToolFixture({ root })
  let reads = 0
  const read = kernel.read.bind(kernel)
  kernel.read = async (input) => {
    reads++
    return read(input)
  }
  const dense = await searchFiles({ query: 'needle', page: {} }, context, 1)
  expect(dense.hits).toHaveLength(50)
  expect(dense.page?.total).toBe(251)
  const long = await searchFiles({ path: 'long.txt', query: 'needle', page: {} }, context, 1)
  expect(long.hits[0].range?.startColumn).toBe(100001)
  expect(long.hits[0].snippet).toBeUndefined()
  expect(long.files).toEqual([])
  expect(reads).toBe(0)
})

test('无匹配和越过末页准确返回空页', async () => {
  await writeFile(join(root, 'a.txt'), 'needle\n')
  const { call } = await projectToolFixture({ root })
  const none = await call('project', 'search', { query: 'absent', page: {} })
  expect(none.page).toMatchObject({ total: 0, totalFiles: 0, hasMore: false, groups: [] })
  const beyond = await call('project', 'search', { query: 'needle', page: { offset: 5 } })
  expect(beyond.hits).toEqual([])
  expect(beyond.page).toMatchObject({ total: 1, hasMore: false, groups: [] })
})

test('每页重新搜索，内容变动后的总数与版本不冒充快照', async () => {
  await writeFile(join(root, 'a.txt'), 'needle\nneedle\n')
  const { call } = await projectToolFixture({ root })
  const first = await call('project', 'search', { query: 'needle', page: { limit: 1 } })
  await writeFile(join(root, 'a.txt'), 'needle changed\nneedle\nneedle\n')
  const next = await call('project', 'search', { query: 'needle', page: { offset: 1, limit: 1 } })
  expect(first.page.total).toBe(2)
  expect(next.page.total).toBe(3)
  expect(next.page.consistency).toBe('live')
  expect(next.hits[0].revision).not.toBe(first.hits[0].revision)
})

test('搜索超限或底层不完整仍明确失败，不签发虚假准确计数', async () => {
  await writeFile(join(root, 'a.txt'), 'needle\n'.repeat(5001))
  const { call, kernel } = await projectToolFixture({ root })
  expect((await failureOf(call('project', 'search', { query: 'needle', page: {} }))).code).toBe(
    'SCOPE_VIOLATION'
  )
  kernel.search = async () => ({ hits: [], truncated: true, diagnostics: ['timeout'] })
  expect((await failureOf(call('project', 'search', { query: 'needle', page: {} }))).code).toBe(
    'SCOPE_VIOLATION'
  )
})

test('分页非法入参在搜索之前拒绝', async () => {
  const { call, kernel } = await projectToolFixture({ root })
  let searches = 0
  kernel.search = async () => {
    searches++
    return { hits: [] }
  }
  for (const page of [
    null,
    [],
    false,
    { limit: 0 },
    { limit: 201 },
    { limit: null },
    { offset: -1 },
    { offset: 5001 },
    { offset: 0.5 },
    { offset: null },
    { limit: '2' },
  ]) {
    expect((await failureOf(call('project', 'search', { query: 'needle', page }))).code).toBe(
      'INVALID_INPUT'
    )
  }
  expect(searches).toBe(0)
})
