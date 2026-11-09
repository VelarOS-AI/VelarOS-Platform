import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { LocalSandboxHost } from '../impl/LocalSandboxHost'
import type { LocalSandboxEntry } from '../types/mirror'

/** 本组只测镜像 IO 与宿主资源所有权；执行器替身拒绝执行命令，不冒充操作系统隔离。 */
function ioHost(base: string): LocalSandboxHost {
  const host = new LocalSandboxHost({ baseDir: base })
  Reflect.set(host, 'createRunner', (root: string) => ({
    root,
    run: async () => {
      throw new AppError('UNAVAILABLE', 'IO fixture 不运行命令。')
    },
    dispose: async () => {},
  }))
  return host
}

async function site() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'sandbox-owner-')))
  const source = join(directory, 'source')
  const base = join(directory, 'boxes')
  await mkdir(source)
  await writeFile(join(source, 'note.txt'), 'original')
  const host = ioHost(base)
  return {
    directory,
    source,
    base,
    host,
    close: async () => {
      for (const record of host.listSandboxes()) await host.discardSandbox(record.id)
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('INV-15 并发创建预占容量，失败释放份额，记录快照不会污染宿主', async () => {
  const f = await site()
  try {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, () => f.host.createSandbox({ source: f.source }))
    )
    const created = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : []
    )
    expect(created).toHaveLength(5)
    expect(
      outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason.code] : []))
    ).toEqual(['VALIDATION'])
    const missingId = '20261108-120000-000000'
    const missing = await f.host.getSandboxRecord(missingId).then(
      () => null,
      (error: unknown) => error
    )
    expect(missing).toMatchObject({ code: 'NOT_FOUND' })
    // Project 先读 metadata 核权，只有 NOT_FOUND 才把丢弃解释成本来不存在。
    const discarded = await f.host.getSandboxRecord(missingId).then(
      () => f.host.discardSandbox(missingId),
      (error: unknown) => {
        if (AppError.from(error).code === 'NOT_FOUND')
          return { sandboxId: missingId, removed: false }
        throw error
      }
    )
    expect(discarded).toEqual({ sandboxId: missingId, removed: false })
    expect(f.host.listSandboxes()).toHaveLength(5)
    const first = created[0]!
    const id = first.id
    first.root = f.source
    first.linkedDirectories.push('injected')
    const listed = f.host.listSandboxes().find((record) => record.id === id)!
    listed.source = f.directory
    listed.linkedDirectories.push('listed')
    const snapshot = await f.host.getSandboxRecord(id)
    snapshot.linkedDirectories.push('snapshot')
    expect(await f.host.getSandboxRecord(id)).toMatchObject({
      root: join(f.base, id, 'tree'),
      source: f.source,
      linkedDirectories: [],
    })
    await f.host.discardSandbox(id)
    expect((await f.host.createSandbox({ source: f.source })).source).toBe(f.source)
  } finally {
    await f.close()
  }
})

test('剪断 git push 后生产完整内容版本，初始差量干净且同元数据改写可见', async () => {
  const f = await site()
  try {
    await mkdir(join(f.source, '.git'))
    await writeFile(
      join(f.source, '.git', 'config'),
      '[remote "origin"]\n\turl = ssh://example/a\n'
    )
    const record = await f.host.createSandbox({ source: f.source })
    expect((await f.host.diffSandbox({ sandboxId: record.id })).gitChanged).toBe(false)
    const config = join(record.root, '.git', 'config')
    const original = await readFile(config, 'utf8')
    const before = await stat(config)
    await writeFile(config, original.replace('example/a', 'example/b'))
    await utimes(config, before.atime, before.mtime)
    expect((await f.host.diffSandbox({ sandboxId: record.id })).gitChanged).toBe(true)
  } finally {
    await f.close()
  }
})

test('重启并发加载合并同一 ID，加载与创建共用五个容量份额', async () => {
  const f = await site()
  const other = ioHost(f.base)
  const restarted = ioHost(f.base)
  try {
    const records = await Promise.all(
      Array.from({ length: 5 }, () => f.host.createSandbox({ source: f.source }))
    )
    records.push(await other.createSandbox({ source: f.source }))
    const first = await Promise.all([
      restarted.getSandboxRecord(records[0]!.id),
      restarted.getSandboxRecord(records[0]!.id),
    ])
    expect(first.map((record) => record.id)).toEqual([records[0]!.id, records[0]!.id])
    const outcomes = await Promise.allSettled(
      records.slice(1).map((record) => restarted.getSandboxRecord(record.id))
    )
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(4)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    expect(restarted.listSandboxes()).toHaveLength(5)
  } finally {
    await restarted.dispose()
    for (const record of other.listSandboxes()) await other.discardSandbox(record.id)
    await other.dispose()
    await f.close()
  }
})

test('旧格式和缺失内容版本的清单都拒绝，原文件保持不变', async () => {
  const f = await site()
  try {
    const record = await f.host.createSandbox({ source: f.source })
    const path = join(f.base, record.id, 'manifest.json')
    const original = JSON.parse(await readFile(path, 'utf8'))
    for (const mutation of ['version', 'content', 'path']) {
      const changed = structuredClone(original)
      if (mutation === 'version') changed.version = 1
      if (mutation === 'content') delete changed.files['note.txt'].contentVersion
      if (mutation === 'path') changed.files['../outside'] = changed.files['note.txt']
      const text = JSON.stringify(changed)
      await writeFile(path, text)
      const failure = await f.host.diffSandbox({ sandboxId: record.id }).then(
        () => null,
        (error: unknown) => error
      )
      expect(failure).toMatchObject({ code: 'NOT_FOUND' })
      expect(await readFile(path, 'utf8')).toBe(text)
    }
    await writeFile(path, JSON.stringify(original))
  } finally {
    await f.close()
  }
})

test('恢复清单只接受 ignored 的三个字符串枚举值', async () => {
  const f = await site()
  try {
    const record = await f.host.createSandbox({ source: f.source })
    const path = join(f.base, record.id, 'manifest.json')
    const original = JSON.parse(await readFile(path, 'utf8'))
    const cases = [
      { ignored: ['link'], valid: false },
      { ignored: ['copy'], valid: false },
      { ignored: ['skip'], valid: false },
      { ignored: {}, valid: false },
      { ignored: { toString: 'copy' }, valid: false },
      { ignored: 1, valid: false },
      { ignored: 'unknown', valid: false },
      { ignored: 'link', valid: true },
      { ignored: 'copy', valid: true },
      { ignored: 'skip', valid: true },
    ]
    for (const { ignored, valid } of cases) {
      const changed = structuredClone(original)
      changed.record.ignored = ignored
      await writeFile(path, JSON.stringify(changed))
      // 每次用新宿主恢复，确保读取盘上清单而不是已登记记录的内存快照。
      const restarted = ioHost(f.base)
      try {
        if (valid) {
          expect(await restarted.getSandboxRecord(record.id)).toMatchObject({
            id: record.id,
            ignored,
          })
        } else {
          await expect(restarted.getSandboxRecord(record.id)).rejects.toMatchObject({
            code: 'NOT_FOUND',
          })
          expect(restarted.listSandboxes()).toEqual([])
        }
      } finally {
        await restarted.dispose()
      }
    }
  } finally {
    await f.close()
  }
})

test('丢弃等待操作排空，清理失败保留 owner 和目录，重试成功才删除', async () => {
  const f = await site()
  const entered = Promise.withResolvers<void>()
  const drained = Promise.withResolvers<void>()
  let entry: LocalSandboxEntry | undefined
  let running: Promise<unknown> | undefined
  try {
    const record = await f.host.createSandbox({ source: f.source })
    const entries = Reflect.get(f.host, 'entries') as Map<string, LocalSandboxEntry>
    entry = entries.get(record.id)!
    entry.runner.run = async () => {
      entered.resolve()
      await drained.promise
      return {
        command: 'fixture',
        cwd: record.root,
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        timedOut: false,
        aborted: false,
        truncated: false,
        success: true,
        verification: { kind: 'unknown', status: 'passed', issues: [] },
      }
    }
    let attempts = 0
    entry.runner.dispose = async () => {
      if (++attempts === 1) throw new AppError('UNAVAILABLE', 'fixture cleanup incomplete')
    }
    running = f.host.runInSandbox({ sandboxId: record.id, command: 'fixture' })
    await entered.promise
    let settled = false
    const discarded = f.host
      .discardSandbox(record.id)
      .then(
        () => null,
        (error: unknown) => error
      )
      .then((value) => {
        settled = true
        return value
      })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(await stat(record.root)).toBeDefined()
    expect(
      await f.host.runInSandbox({ sandboxId: record.id, command: 'late' }).then(
        () => null,
        (error: unknown) => error
      )
    ).toMatchObject({ code: 'CLOSED' })
    drained.resolve()
    await running
    expect(await discarded).toMatchObject({ code: 'UNAVAILABLE' })
    expect(f.host.listSandboxes()).toHaveLength(1)
    expect((await f.host.getSandboxRecord(record.id)).source).toBe(f.source)
    expect(await stat(record.root)).toBeDefined()
    expect(await f.host.discardSandbox(record.id)).toMatchObject({ removed: true })
    expect(await readdir(f.base)).toEqual([])
  } finally {
    drained.resolve()
    await running
    if (entry) entry.runner.dispose = async () => {}
    await f.close()
  }
})

test('活动句柄核权 A 后，磁盘清单不能把 diff 或 apply 转到 B', async () => {
  const f = await site()
  try {
    const record = await f.host.createSandbox({ source: f.source })
    const other = join(f.directory, 'other')
    await mkdir(other)
    await writeFile(join(other, 'note.txt'), 'unrelated')
    await writeFile(join(record.root, 'note.txt'), 'sandbox change')
    const path = join(f.base, record.id, 'manifest.json')
    const original = JSON.parse(await readFile(path, 'utf8'))
    for (const field of ['source', 'root']) {
      const changed = structuredClone(original)
      changed.record[field] = other
      await writeFile(path, JSON.stringify(changed))
      expect((await f.host.getSandboxRecord(record.id)).source).toBe(f.source)
      for (const operation of [
        () => f.host.diffSandbox({ sandboxId: record.id }),
        () => f.host.applySandbox({ sandboxId: record.id }),
      ])
        expect(
          await operation().then(
            () => null,
            (error: unknown) => error
          )
        ).toMatchObject({ code: 'PERMISSION' })
      expect(await readFile(join(other, 'note.txt'), 'utf8')).toBe('unrelated')
      expect(await readFile(join(f.source, 'note.txt'), 'utf8')).toBe('original')
    }
  } finally {
    await f.close()
  }
})

test('宿主关闭拒绝新的创建和加载，且一个失败不跳过其他执行器', async () => {
  const f = await site()
  const entries = Reflect.get(f.host, 'entries') as Map<string, LocalSandboxEntry>
  try {
    await f.host.createSandbox({ source: f.source })
    await f.host.createSandbox({ source: f.source })
    let stopped = 0
    const all = [...entries.values()]
    all[0]!.runner.dispose = async () => {
      throw new AppError('UNAVAILABLE', 'fixture incomplete')
    }
    all[1]!.runner.dispose = async () => {
      stopped++
    }
    expect(
      await f.host.dispose().then(
        () => null,
        (error: unknown) => error
      )
    ).toMatchObject({ code: 'UNAVAILABLE' })
    expect(stopped).toBe(1)
    expect(
      await f.host.createSandbox({ source: f.source }).then(
        () => null,
        (error: unknown) => error
      )
    ).toMatchObject({ code: 'CLOSED' })
    all[0]!.runner.dispose = async () => {}
    await f.host.dispose()
  } finally {
    for (const entry of entries.values()) entry.runner.dispose = async () => {}
    await f.close()
  }
})
