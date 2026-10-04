/** 搜索窗口按实际正文总量控制，合理的大上下文半径不会拒绝或静默截断。 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { searchFiles } from '../utils/agent/file-reads'

import { failureOf, projectToolFixture } from './support/tools'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-search-context-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('INV-24 28、35 行上下文与独立读取可以一起完成，交回请求的整段原文与绑定目标', async () => {
  const lines = Array.from({ length: 180 }, (_, index) => `line ${index + 1} 中文🙂`)
  lines[99] = 'needle'
  await writeFile(join(root, 'source.txt'), `${lines.join('\n')}\n`)
  const { call } = await projectToolFixture({ root })
  const results = await Promise.allSettled([
    call('project', 'search', { path: 'source.txt', query: 'needle', contextLines: 28 }),
    call('project', 'search', { path: 'source.txt', query: 'needle', contextLines: 35 }),
    call('project', 'read', { files: [{ path: 'source.txt', range: 100 }] }),
  ])
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled'])
  for (const [index, radius] of [28, 35].entries()) {
    const result = results[index] as PromiseFulfilledResult<any>
    expect(result.value.hits).toHaveLength(1)
    expect(result.value.hits[0].range.startLine).toBe(100)
    expect(result.value.files).toHaveLength(1)
    expect(result.value.files[0]).toMatchObject({
      startLine: 100 - radius,
      text: lines.slice(99 - radius, 100 + radius).join('\n'),
      totalLines: 180,
      revision: result.value.hits[0].revision,
    })
    expect(result.value.files[0].target.ref).toMatch(/^target:[\da-f]{8}$/)
    expect(result.value.hits[0].snippet).toBeUndefined()
  }
})

test('极大半径止于真实文件边界，CRLF 与 emoji 按返回的 Unicode 正文计量', async () => {
  await writeFile(join(root, 'source.txt'), '前🙂\r\nneedle\r\n后🙂\r\n')
  const { context, call } = await projectToolFixture({ root })
  const input = { query: 'needle', contextLines: Number.MAX_SAFE_INTEGER }
  const result = await call('project', 'search', input)
  expect(result.files).toHaveLength(1)
  expect(result.files[0]).toMatchObject({
    startLine: 1,
    text: '前🙂\nneedle\n后🙂\n',
    totalLines: 3,
  })
  expect((await searchFiles(input, context, 13)).files[0].text).toBe('前🙂\nneedle\n后🙂\n')
  await expect(searchFiles(input, context, 12)).rejects.toMatchObject({
    reason: 'SCOPE_VIOLATION',
  })
})

test('密集命中的窗口合并后再计量，同一份正文不按命中次数重复扣预算', async () => {
  const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`)
  for (const index of [9, 19, 44]) lines[index] = 'needle'
  await writeFile(join(root, 'source.txt'), `${lines.join('\n')}\n`)
  const { context } = await projectToolFixture({ root })
  const expected = lines.slice(0, 80).join('\n')
  const result = await searchFiles({ query: 'needle', contextLines: 35 }, context, expected.length)
  expect(result.hits).toHaveLength(3)
  expect(result.files).toHaveLength(1)
  expect(result.files[0]).toMatchObject({ startLine: 1, text: expected })
})

test('正文预算在文件与分开的窗口之间共用，超限整次失败并给出分段读取的下一步', async () => {
  await writeFile(join(root, 'a.txt'), 'needle🙂\nhidden\nneedle🙂\n')
  await writeFile(join(root, 'b.txt'), 'needle🙂\n')
  const { context } = await projectToolFixture({ root })
  const input = { query: 'needle', contextLines: 0 }
  const result = await searchFiles(input, context, 23)
  expect(result.hits).toHaveLength(3)
  expect(result.files.map((file) => file.text)).toEqual(['needle🙂', 'needle🙂\n', 'needle🙂\n'])
  await expect(searchFiles(input, context, 22)).rejects.toMatchObject({
    reason: 'SCOPE_VIOLATION',
    suggestedNextAction: expect.stringContaining('read 带 range'),
  })
})

test('非法半径明确报入参错误，在搜索之前拒绝', async () => {
  const { call, kernel } = await projectToolFixture({ root })
  let searches = 0
  const search = kernel.search.bind(kernel)
  kernel.search = async (input) => {
    searches++
    return search(input)
  }
  for (const contextLines of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, true, '28', Infinity]) {
    const failure = await failureOf(call('project', 'search', { query: 'needle', contextLines }))
    expect(failure.code).toBe('INVALID_INPUT')
    expect(failure.message).toContain('contextLines 要非负安全整数')
  }
  expect(searches).toBe(0)
})

test('源码读取超限不会退化成看似完整但没有正文的成功结果', async () => {
  await writeFile(join(root, 'source.txt'), 'needle\n')
  const { call, kernel } = await projectToolFixture({ root })
  const read = kernel.read.bind(kernel)
  kernel.read = async (input) => ({ ...(await read(input)), truncated: true, hasMore: true })
  const failure = await failureOf(call('project', 'search', { query: 'needle', contextLines: 28 }))
  expect(failure.code).toBe('SCOPE_VIOLATION')
  expect(failure.message).toContain('用 read 带 range')
})

test('搜索后的版本变化保留原命中片段，取消读取则明确终止', async () => {
  await writeFile(join(root, 'source.txt'), 'needle before\n')
  const { call, kernel, context } = await projectToolFixture({ root })
  const search = kernel.search.bind(kernel)
  kernel.search = async (input) => {
    const result = await search(input)
    await writeFile(join(root, 'source.txt'), 'needle after\n')
    return result
  }
  const changed = await call('project', 'search', { query: 'needle', contextLines: 35 })
  expect(changed.files).toEqual([])
  expect(changed.hits[0].snippet).toContain('before')
  const abort = new AbortController()
  context.abortSignal = abort.signal
  kernel.read = async () => {
    abort.abort()
    abort.signal.throwIfAborted()
    throw new Error('取消读取应当终止')
  }
  await expect(searchFiles({ query: 'needle', contextLines: 28 }, context)).rejects.toMatchObject({
    name: 'AbortError',
  })
})
