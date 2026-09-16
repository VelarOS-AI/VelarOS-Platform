/**
 * INV-1（不变量候选，方案 6.4）：**文件后端的条目只能是本作用域根下 `entries/` 里的 `.md`，
 * id 与索引行越界一律当不存在。**
 *
 * 回归的形状是越界读写：
 *  - `memory:get` 传 `system::../../<任意路径>` 读到记忆目录外的文件（私钥、云凭证）；
 *  - `memory:archive` 传同样的 id 把一个已存在的文件顶上一段 frontmatter（`.zshrc`、`settings.json` 就此坏掉）；
 *  - 一个克隆来的仓库自带 `.velaros/memory/MEMORY.md`、索引行链到仓外的凭据文件，
 *    打开仓库聊到相关话题时回合自动召回就把凭据注进模型上下文。
 *
 * 判定住 `src/files/EntryPath.ts`，id 解析、索引解析、目录扫描三处共用；符号链接由
 * `MemoryFilesIo.isInsideDirectory` 再解一道（Node 实现）。本文件两种 IO 都测。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, test } from 'bun:test'

import {
  createInMemoryMemoryFilesIo,
  createMemoryFilesBackend,
  createNodeMemoryFilesIo,
  type MemoryFilesScopeRoot,
} from '../../src/files'
import { isMemoryEntryPath } from '../../src/files/EntryPath'
import { parseMemoryIndex } from '../../src/files/IndexFile'

const SystemRoot: MemoryFilesScopeRoot = {
  scopeType: 'system',
  scopeId: 'system',
  directory: '/userData/memory',
}

describe('条目路径判定（全仓单源）', () => {
  test('只认 entries/<名>.md', () => {
    expect(isMemoryEntryPath('entries/回复风格.md')).toBe(true)
    expect(isMemoryEntryPath('entries/a.MD')).toBe(true)
  })

  test('越界形状一律拒绝', () => {
    for (const path of [
      '../../home/id_rsa',
      'entries/../../home/id_rsa',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      'entries\\..\\..\\x.md',
      'entries/sub/dir.md',
      'entries//x.md',
      'entries/.md',
      'entries/..',
      ' entries/a.md',
      'notes/a.md',
      'entries/a.txt',
      'MEMORY.md',
    ]) {
      expect(isMemoryEntryPath(path)).toBe(false)
    }
  })

  test('条目目录改名后按新名字判定', () => {
    expect(isMemoryEntryPath('记忆/a.md', '记忆')).toBe(true)
    expect(isMemoryEntryPath('entries/a.md', '记忆')).toBe(false)
  })
})

describe('索引行越界即跳过', () => {
  test('链到根外的索引行不进候选，并交出诊断', () => {
    const rejected: string[] = []
    const entries = parseMemoryIndex(
      '# Memory index\n\n'
      + '- [项目部署约定](../../../home/.aws/credentials) — 部署约定\n'
      + '- [正常条目](entries/ok.md) — 描述\n',
      { onRejectedPath: (path) => rejected.push(path) },
    )
    expect(entries.map((entry) => entry.path)).toEqual(['entries/ok.md'])
    expect(rejected).toEqual(['../../../home/.aws/credentials'])
  })

  test('召回不会因为索引里写着就去读仓外的文件', () => {
    const io = createInMemoryMemoryFilesIo({
      '/repo/.velaros/memory/MEMORY.md':
        '# Memory index\n\n- [项目部署约定](../../../home/.aws/credentials) — 部署约定\n',
      '/home/.aws/credentials': '[default]\naws_secret_access_key = fake\n',
    })
    const backend = createMemoryFilesBackend({
      roots: [{ scopeType: 'workspace', scopeId: 'project:/repo', directory: '/repo/.velaros/memory' }],
      io,
    })
    expect(backend.recall('部署约定', { scopeId: 'project:/repo' })).toEqual([])
  })
})

describe('越界 id 当作不存在', () => {
  test('getItem 读不到记忆目录外的文件', () => {
    const io = createInMemoryMemoryFilesIo({
      '/userData/home/id_rsa': '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n',
    })
    const backend = createMemoryFilesBackend({ roots: [SystemRoot], io })
    expect(backend.getItem('system::../home/id_rsa')).toBeNull()
  })

  test('archive 不改写记忆目录外的文件，越界 id 抛 NOT_FOUND', () => {
    const io = createInMemoryMemoryFilesIo({
      '/userData/home/settings.json': '{"theme":"dark"}\n',
    })
    const backend = createMemoryFilesBackend({ roots: [SystemRoot], io })
    expect(() => backend.archive('system::../home/settings.json')).toThrow(/记忆不存在/u)
    expect(io.snapshot()['/userData/home/settings.json']).toBe('{"theme":"dark"}\n')
  })
})

describe('真实路径必须在根里（Node IO 的第二道）', () => {
  const base = mkdtempSync(join(tmpdir(), 'velaros-memory-entrypath-'))
  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  test('条目目录里指向根外的符号链接读不出内容', () => {
    const memoryRoot = join(base, 'repo', '.velaros', 'memory')
    const outside = join(base, 'home', '.aws')
    mkdirSync(join(memoryRoot, 'entries'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'credentials'), '[default]\naws_secret_access_key = fake\n')
    symlinkSync(join(outside, 'credentials'), join(memoryRoot, 'entries', 'deploy.md'))
    writeFileSync(
      join(memoryRoot, 'MEMORY.md'),
      '# Memory index\n\n- [部署约定](entries/deploy.md) — 部署约定\n',
    )

    const backend = createMemoryFilesBackend({
      roots: [{ scopeType: 'workspace', scopeId: 'project:/repo', directory: memoryRoot }],
      io: createNodeMemoryFilesIo(),
    })
    expect(backend.recall('部署约定', { scopeId: 'project:/repo' })).toEqual([])
    expect(backend.getItem('project:/repo::entries/deploy.md')).toBeNull()
    expect(() => backend.archive('project:/repo::entries/deploy.md')).toThrow(/记忆不存在/u)
    expect(readFileSync(join(outside, 'credentials'), 'utf8')).toContain('aws_secret_access_key')
  })

  test('根里的普通条目照常读写', () => {
    const memoryRoot = join(base, 'ok', 'memory')
    const backend = createMemoryFilesBackend({
      roots: [{ scopeType: 'global', scopeId: 'global', directory: memoryRoot }],
      io: createNodeMemoryFilesIo(),
      now: () => 1_700_000_000_000,
    })
    const captured = backend.capture({
      sourceType: 'agent_tool',
      trustLevel: 'agent_derived',
      title: '回复风格',
      content: '先给结论。',
      category: 'preference',
      scopeId: 'global',
    })
    expect(captured.inserted).toBe(true)
    expect(backend.getItem(captured.evidence.id)?.title).toBe('回复风格')
  })
})

describe('宿主注入的目录名同样过判定', () => {
  test('条目目录名不是单段安全名字时拒绝构造', () => {
    expect(() =>
      createMemoryFilesBackend({
        roots: [SystemRoot],
        io: createInMemoryMemoryFilesIo(),
        entriesDirectoryName: '../..',
      })
    ).toThrow(/单段安全名字/u)
  })
})
