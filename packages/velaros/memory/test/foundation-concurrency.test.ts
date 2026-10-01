import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { createMemoryStore } from '../impl/MemoryStore'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'memory-foundation-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const entry = {
  id: 'shared',
  type: 'work' as const,
  title: 'title',
  description: 'description',
  content: 'before',
}

test('INV-14 stale save and remove reject without replacing the latest memory', async () => {
  const scope = createMemoryStore({ root }).scope('same')
  await scope.save(entry)
  await expect(
    scope.save({ ...entry, content: 'stale', expectedRevision: '0'.repeat(64) })
  ).rejects.toMatchObject({ code: 'CONFLICT' })
  await expect(
    scope.remove({ id: entry.id, expectedRevision: '0'.repeat(64) })
  ).rejects.toMatchObject({ code: 'CONFLICT' })
  expect((await scope.list())[0].content).toBe('before')
})
test('separate stores sharing the same directory allow only one compare-and-set winner', async () => {
  const a = createMemoryStore({ root }).scope('same')
  const b = createMemoryStore({ root }).scope('same')
  const saved = await a.save(entry)
  expect(saved.revision).toMatch(/^[a-f0-9]{64}$/)
  const result = await Promise.allSettled([
    a.save({ ...entry, content: 'a', expectedRevision: saved.revision }),
    b.save({ ...entry, content: 'b', expectedRevision: saved.revision }),
  ])
  expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
  expect(['a', 'b']).toContain((await a.list())[0].content)
})
test('expected absence is an exclusive create across separate store instances', async () => {
  const a = createMemoryStore({ root }).scope('same')
  const b = createMemoryStore({ root }).scope('same')
  const result = await Promise.allSettled([
    a.save({ ...entry, expectedRevision: null }),
    b.save({ ...entry, expectedRevision: null }),
  ])
  expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
})

test('cooperating separate processes have one CAS winner for the same revision', async () => {
  const scope = createMemoryStore({ root }).scope('same')
  const saved = await scope.save(entry)
  const modulePath = new URL('../impl/MemoryStore.ts', import.meta.url).pathname
  const run = async (content: string) => {
    const code = `import { createMemoryStore } from ${JSON.stringify(modulePath)};
      try { await createMemoryStore({ root: ${JSON.stringify(root)} }).scope('same').save(${JSON.stringify({ ...entry, content, expectedRevision: saved.revision })}); console.log('saved') }
      catch (error) { if (error.code !== 'CONFLICT') throw error; console.log('conflict') }`
    const child = Bun.spawn([process.execPath, '--eval', code], { stdout: 'pipe', stderr: 'pipe' })
    const [output, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(error).toBe('')
    expect(exit).toBe(0)
    return output.trim()
  }
  expect((await Promise.all([run('child-a'), run('child-b')])).sort()).toEqual([
    'conflict',
    'saved',
  ])
})

test('unconditional saves preserve current tags and optional cancellation prevents publication', async () => {
  const scope = createMemoryStore({ root }).scope('same')
  await scope.save({ ...entry, tags: ['latest'] })
  await createMemoryStore({ root })
    .scope('same')
    .save({ ...entry, content: 'last committed' })
  expect((await scope.list())[0]).toMatchObject({ content: 'last committed', tags: ['latest'] })
  const abort = new AbortController()
  const pending = scope.save({ ...entry, content: 'cancelled' }, abort.signal)
  abort.abort()
  await expect(pending).rejects.toBeDefined()
  expect((await scope.list())[0].content).toBe('last committed')
})
