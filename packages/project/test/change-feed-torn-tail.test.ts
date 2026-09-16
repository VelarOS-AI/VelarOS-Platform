import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { createFileProjectChangeFeed } from '../src/index'
import type { ProjectChangeRecordInput } from '../src/types/change-feed'

let directory = ''
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'project-feed-torn-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** 一条最小的变更记录。 */
function record(transactionId: string): ProjectChangeRecordInput {
  return { transactionId, lifecycle: 'applied', intents: [], patches: [], changedFiles: ['a.ts'], diff: '', changedLines: 0, risk: 'low', revisions: [], createdAt: 1 }
}

test('崩溃留下的残行在下次打开时被截掉，后续记录不会拼到它后面', async () => {
  const path = join(directory, 'changes.jsonl')
  const first = createFileProjectChangeFeed({ path })
  first.record(record('tx_1'))
  first.close()

  // 追加写到一半崩溃：末尾留下没有换行结尾的半条记录。
  await appendFile(path, '{"transactionId":"tx_2","sequence":2,"lifecyc')

  const second = createFileProjectChangeFeed({ path })
  expect(second.list()).toHaveLength(1)
  second.record(record('tx_3'))
  second.close()

  const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
  expect(lines).toHaveLength(2)
  for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  expect(lines[1]).not.toContain('lifecyc{')

  // 再开一次不再抛错：残行已经不在文件里了（改动前这里会因为坏行整份记录报废）。
  const third = createFileProjectChangeFeed({ path })
  expect(third.list().map((change) => change.transactionId).sort()).toEqual(['tx_1', 'tx_3'])
  third.close()
})

test('整份文件只有半条记录时截成空文件，之后照常追加', async () => {
  const path = join(directory, 'only-torn.jsonl')
  await appendFile(path, '{"transactionId":"tx_1"')
  const feed = createFileProjectChangeFeed({ path })
  expect(feed.list()).toHaveLength(0)
  feed.record(record('tx_9'))
  feed.close()
  const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0]!).transactionId).toBe('tx_9')
})
