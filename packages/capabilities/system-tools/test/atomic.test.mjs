/**
 * @test-meta
 * title: 系统 primitive 工具
 * summary: 验证 system-tools 内 read/edit/write/grep/list 的基础行为，并确认旧 atomic 名称不再注册。
 * area: packages
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'


const packageEntryPath = new URL('../dist/index.js', import.meta.url)

test('system tools package can be imported without preloading core extensions', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const mod = await import(${JSON.stringify(packageEntryPath.href)}); console.log(Boolean(mod.systemTools?.bash));`,
    ],
    { encoding: 'utf8' }
  )

  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), 'true')
  assert.equal(result.stderr, '')
})

function createSystemToolContext(activeWorkspaceRoot = null) {
  return {
    abortSignal: new AbortController().signal,
    hasWorkspaceRoot: () => Boolean(activeWorkspaceRoot),
    system: {
      getOverview: () => ({
        activeWorkspaceRoot,
        workspaceRoots: [],
        providers: [],
        browserSiteContext: null,
      }),
      globalSearch: async () => ({
        mode: 'content',
        rootPath: activeWorkspaceRoot ?? '/tmp',
        count: 0,
        truncated: false,
        matches: [],
      }),
      runCommand: async (command, options = {}) => ({
        command,
        cwd: options.cwd ?? activeWorkspaceRoot ?? '/tmp',
        exitCode: 0,
        signal: null,
        stdout: 'ok',
        stderr: '',
        durationMs: 1,
        timedOut: false,
        aborted: false,
        truncated: false,
        success: true,
      }),
      canStartBackgroundCommands: () => true,
    },
    execution: {
      awaitConfirmation: async () => undefined,
    },
  }
}

test('primitive filesystem tools are exported from the built package', async () => {
  const { systemExtensionTools, systemTools } = await import(packageEntryPath.href)

  assert.ok(systemTools.read)
  assert.ok(systemTools.edit)
  assert.ok(systemTools.write)
  assert.ok(systemTools.grep)
  assert.ok(systemTools.list)
  assert.equal(systemTools.atomic_read, undefined)
  assert.equal(systemTools.atomic_edit, undefined)
  assert.equal(systemTools.atomic_write, undefined)
  assert.equal(systemTools.atomic_grep, undefined)
  assert.equal(systemTools.atomic_list_dir, undefined)
  assert.equal(systemExtensionTools.atomic_read, undefined)
  assert.equal(systemExtensionTools.atomic_edit, undefined)
  assert.equal(systemExtensionTools.atomic_write, undefined)
  assert.equal(systemExtensionTools.atomic_grep, undefined)
  assert.equal(systemExtensionTools.atomic_list_dir, undefined)
})

test('system tools do not own workspace root registry operations', async () => {
  const { systemExtensionTools, systemTools } = await import(packageEntryPath.href)

  for (const tools of [systemTools, systemExtensionTools]) {
    assert.equal(tools.workspace_roots, undefined)
    assert.equal(tools.workspace_add_root, undefined)
    assert.equal(tools.workspace_remove_root, undefined)
    assert.equal(tools.workspace_switch_root, undefined)
  }
})

test('ps description scopes tasks to managed background commands', async () => {
  const { systemTools } = await import(packageEntryPath.href)

  assert.match(systemTools.ps.description, /后台系统命令/)
  assert.match(systemTools.ps.description, /不包含 sub-agent/)
})

test('ps returns a timestamped fresh runtime snapshot on each call', async () => {
  const { systemTools } = await import(packageEntryPath.href)
  const calls = {
    processes: 0,
    ports: 0,
    tasks: 0,
  }
  const ctx = {
    system: {
      listProcesses: async () => {
        calls.processes += 1
        return [{ pid: 1000 + calls.processes, name: `node-${calls.processes}` }]
      },
      listOpenPorts: async () => {
        calls.ports += 1
        return [{ port: 3000 + calls.ports, pid: 1000 + calls.ports }]
      },
      listBackgroundTasks: async () => {
        calls.tasks += 1
        return [{ id: `task-${calls.tasks}`, status: 'running' }]
      },
    },
  }

  const first = await systemTools.ps.execute({}, ctx)
  const second = await systemTools.ps.execute({}, ctx)

  assert.equal(calls.processes, 2)
  assert.equal(calls.ports, 2)
  assert.equal(calls.tasks, 2)
  assert.equal(Number.isNaN(Date.parse(first.sampledAt)), false)
  assert.equal(Number.isNaN(Date.parse(second.sampledAt)), false)
  assert.equal(first.processes.items[0].pid, 1001)
  assert.equal(second.processes.items[0].pid, 1002)
  assert.equal(first.ports.items[0].port, 3001)
  assert.equal(second.ports.items[0].port, 3002)
  assert.equal(first.tasks.items[0].id, 'task-1')
  assert.equal(second.tasks.items[0].id, 'task-2')
})

test('edit performs exact replacement outside workspace', async () => {
  const { systemTools } = await import(packageEntryPath.href)
  const root = await mkdtemp(join(tmpdir(), 'velaros-atomic-edit-'))
  const ctx = createSystemToolContext()

  try {
    const targetPath = join(root, 'note.txt')
    await writeFile(targetPath, 'alpha\nbeta\n', 'utf8')

    const result = await systemTools.edit.execute(
      { path: targetPath, oldText: 'beta', newText: 'gamma' },
      ctx
    )

    assert.equal(result.path, targetPath)
    assert.equal(result.replacements, 1)
    assert.equal(await readFile(targetPath, 'utf8'), 'alpha\ngamma\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('edit rejects paths inside the active workspace root', async () => {
  const { systemTools } = await import(packageEntryPath.href)
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'velaros-atomic-guard-'))
  const ctx = createSystemToolContext(workspaceRoot)

  try {
    const targetPath = join(workspaceRoot, 'src', 'app.ts')
    await mkdir(join(workspaceRoot, 'src'), { recursive: true })
    await writeFile(targetPath, 'const value = 1\n', 'utf8')

    await assert.rejects(
      () =>
        systemTools.edit.execute(
          { path: targetPath, oldText: 'value', newText: 'next' },
          ctx
        ),
      (error) => {
        assert.match(String(error), /active workspace root/)
        return true
      }
    )
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('read returns bounded file content', async () => {
  const { systemTools } = await import(packageEntryPath.href)
  const root = await mkdtemp(join(tmpdir(), 'velaros-atomic-read-'))

  try {
    const targetPath = join(root, 'sample.txt')
    await writeFile(targetPath, 'line1\nline2\nline3\n', 'utf8')

    const result = await systemTools.read.execute(
      { path: targetPath, startLine: 2, endLine: 2 },
      null
    )

    assert.equal(result.content, 'line2')
    assert.equal(result.startLine, 2)
    assert.equal(result.endLine, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('write overwrites by default and rejects create-only writes to existing files', async () => {
  const { systemTools } = await import(packageEntryPath.href)
  const root = await mkdtemp(join(tmpdir(), 'velaros-atomic-write-'))
  const ctx = createSystemToolContext()

  try {
    const targetPath = join(root, 'nested', 'note.txt')

    const created = await systemTools.write.execute(
      { path: targetPath, content: 'hello\n' },
      ctx
    )
    assert.equal(created.created, true)
    assert.equal(created.changed, true)
    assert.equal(await readFile(targetPath, 'utf8'), 'hello\n')

    const overwritten = await systemTools.write.execute(
      { path: targetPath, content: 'other\n' },
      ctx
    )
    assert.equal(overwritten.created, false)
    assert.equal(overwritten.changed, true)
    assert.equal(await readFile(targetPath, 'utf8'), 'other\n')

    await assert.rejects(
      () =>
        systemTools.write.execute(
          { path: targetPath, content: 'blocked\n', overwrite: false },
          ctx
        ),
      (error) => {
        assert.match(String(error), /overwrite=false/)
        return true
      }
    )

    const unchanged = await systemTools.write.execute(
      { path: targetPath, content: 'other\n', overwrite: true },
      ctx
    )
    assert.equal(unchanged.created, false)
    assert.equal(unchanged.changed, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('write default byte limit accepts diagnostic text larger than 10KB', async () => {
  const { systemTools } = await import(packageEntryPath.href)
  const root = await mkdtemp(join(tmpdir(), 'velaros-atomic-write-large-'))
  const ctx = createSystemToolContext()

  try {
    const targetPath = join(root, 'debug.txt')
    const content = `${'x'.repeat(12_000)}\n`

    const created = await systemTools.write.execute(
      { path: targetPath, content },
      ctx
    )

    assert.equal(created.created, true)
    assert.equal(created.bytes, Buffer.byteLength(content, 'utf8'))
    assert.equal(await readFile(targetPath, 'utf8'), content)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('list lists immediate children with limit', async () => {
  const { systemTools } = await import(packageEntryPath.href)
  const root = await mkdtemp(join(tmpdir(), 'velaros-atomic-list-'))

  try {
    await writeFile(join(root, 'a.txt'), 'a', 'utf8')
    await mkdir(join(root, 'child'), { recursive: true })

    const result = await systemTools.list.execute({ path: root, limit: 10 }, null)

    assert.equal(result.count, 2)
    assert.deepEqual(
      result.entries.map((entry) => entry.path).sort(),
      ['a.txt', 'child']
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('list follows a directory symlink at the requested root', async () => {
  const { systemTools } = await import(packageEntryPath.href)
  const root = await mkdtemp(join(tmpdir(), 'velaros-atomic-list-symlink-'))

  try {
    const realDir = join(root, 'real')
    const linkedDir = join(root, 'linked')
    await mkdir(realDir, { recursive: true })
    await writeFile(join(realDir, 'a.txt'), 'a', 'utf8')
    await symlink(realDir, linkedDir, 'dir')

    const result = await systemTools.list.execute({ path: linkedDir, limit: 10 }, null)

    assert.equal(result.rootPath, await realpath(realDir))
    assert.equal(result.count, 1)
    assert.deepEqual(result.entries, [{ path: 'a.txt', type: 'file' }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('list reports symlink children without recursively entering them', async () => {
  const { systemTools } = await import(packageEntryPath.href)
  const root = await mkdtemp(join(tmpdir(), 'velaros-atomic-list-child-symlink-'))

  try {
    const realDir = join(root, 'real')
    const linkedDir = join(root, 'linked')
    await mkdir(realDir, { recursive: true })
    await writeFile(join(realDir, 'nested.txt'), 'nested', 'utf8')
    await symlink(realDir, linkedDir, 'dir')

    const result = await systemTools.list.execute({ path: root, recursive: true, maxDepth: 2, limit: 10 }, null)

    assert.deepEqual(result.entries, [
      { path: 'linked', type: 'symlink' },
      { path: 'real', type: 'directory' },
      { path: 'real/nested.txt', type: 'file' },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('grep finds matches in a single file', async () => {
  const { systemTools } = await import(packageEntryPath.href)
  const root = await mkdtemp(join(tmpdir(), 'velaros-atomic-grep-'))
  const ctx = createSystemToolContext()

  try {
    const targetPath = join(root, 'app.log')
    await writeFile(targetPath, 'ok\nERROR: boom\n', 'utf8')

    const result = await systemTools.grep.execute(
      { path: targetPath, pattern: 'ERROR', limit: 5 },
      ctx
    )

    assert.equal(result.count, 1)
    assert.equal(result.matches[0].line, 2)
    assert.match(result.matches[0].excerpt, /ERROR/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('grep rejects invalid regex patterns', async () => {
  const { systemTools } = await import(packageEntryPath.href)
  const root = await mkdtemp(join(tmpdir(), 'velaros-atomic-grep-invalid-'))
  const ctx = createSystemToolContext()

  try {
    const targetPath = join(root, 'app.log')
    await writeFile(targetPath, 'line\n', 'utf8')

    await assert.rejects(
      () =>
        systemTools.grep.execute(
          { path: targetPath, pattern: '(', regex: true, limit: 5 },
          ctx
        ),
      (error) => {
        assert.match(String(error), /Invalid regex pattern/)
        return true
      }
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bash rejects commands whose cwd is inside the active workspace root', async () => {
  const { systemTools } = await import(packageEntryPath.href)
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'velaros-bash-guard-'))
  const ctx = createSystemToolContext(workspaceRoot)

  try {
    await assert.rejects(
      () =>
        systemTools.bash.execute(
          { command: 'git status', cwd: workspaceRoot, maxOutputChars: 2000 },
          ctx
        ),
      (error) => {
        assert.match(String(error), /ws_run_command/)
        return true
      }
    )
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('bash rejects commands with implicit cwd when an active workspace root exists', async () => {
  const { systemTools } = await import(packageEntryPath.href)
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'velaros-bash-implicit-guard-'))
  const ctx = createSystemToolContext(workspaceRoot)

  try {
    await assert.rejects(
      () => systemTools.bash.execute({ command: 'git status', maxOutputChars: 2000 }, ctx),
      (error) => {
        assert.match(String(error), /ws_run_command/)
        return true
      }
    )
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
