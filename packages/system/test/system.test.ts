import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { executeAtomicRead } from '../src/atomic/Read'
import { executeAtomicWrite, resolveAtomicWriteContent } from '../src/atomic/Write'
import { systemTools } from '../src/Collection'
import { SystemToolNames } from '../src/system-tool-names'
import {
  isSystemShellCommandReadOnly,
  shouldReapForegroundProcessGroupAfterExit,
} from '../src/SystemCommandExecutionPolicy'

describe('System capability', () => {
  test('publishes only canonical system tool ids', () => {
    expect(Object.keys(systemTools).toSorted()).toEqual(Object.values(SystemToolNames).toSorted())
    expect(Object.keys(systemTools).every((name) => name.startsWith('system:'))).toBe(true)
  })

  test('does not publish project discovery or diagnostic shortcuts', () => {
    expect(Object.hasOwn(systemTools, 'discover_projects')).toBe(false)
    expect(Object.hasOwn(systemTools, 'diagnose_dev_runtime')).toBe(false)
    expect(Object.hasOwn(systemTools, 'get_system_overview')).toBe(false)
  })

  test('only reaps commands that launch a real shell background job', () => {
    expect(shouldReapForegroundProcessGroupAfterExit('printf one && printf two')).toBe(false)
    expect(shouldReapForegroundProcessGroupAfterExit('false || printf fallback')).toBe(false)
    expect(shouldReapForegroundProcessGroupAfterExit('printf value | wc -c')).toBe(false)
    expect(shouldReapForegroundProcessGroupAfterExit('server &')).toBe(true)
    expect(shouldReapForegroundProcessGroupAfterExit('server &; printf ready')).toBe(true)
    expect(shouldReapForegroundProcessGroupAfterExit('server &\nprintf ready')).toBe(true)
    expect(shouldReapForegroundProcessGroupAfterExit('nohup server &')).toBe(false)
  })

  test('whitelisted commands still lose read-only status when their arguments write', () => {
    expect(isSystemShellCommandReadOnly('find . -name "*.ts"')).toBe(true)
    expect(isSystemShellCommandReadOnly('sed -n 1,20p file.txt')).toBe(true)
    // 白名单是「无人值守自动放行」与「可并发执行」两道判定的底；这几种写盘形态必须掉出来。
    expect(isSystemShellCommandReadOnly('find . -name "*.tmp" -delete')).toBe(false)
    expect(isSystemShellCommandReadOnly('find . -type f -exec rm {} ;')).toBe(false)
    expect(isSystemShellCommandReadOnly('sed -i s/a/b/ file.txt')).toBe(false)
    expect(isSystemShellCommandReadOnly('sed --in-place=.bak s/a/b/ file.txt')).toBe(false)
  })

  test('dangerous shell commands request approval that can never be reused', async () => {
    const seen: Array<Record<string, unknown> | undefined> = []
    const context = {
      abortSignal: new AbortController().signal,
      approval: {
        awaitConfirmation: async (
          _message: string,
          _signal?: AbortSignal,
          options?: Record<string, unknown>
        ) => {
          seen.push(options)
        },
      },
      system: {
        canStartBackgroundCommands: () => true,
        runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0, truncated: false }),
      },
    } as never

    await systemTools[SystemToolNames.run].execute({ command: 'rm -rf /tmp/velaros-fixture' }, context)
    // 破坏性命令：必须是「每次亲自裁决」，绝不能进 riskScope 记忆——否则批准过一条
    // rm -rf 就等于预授权了本会话此后所有 rm -rf / sudo / dd。
    expect(seen[0]).toEqual({
      approvalRisk: 'high',
      riskScope: 'system-command:dangerous',
      requireManualApproval: true,
      rememberRiskScope: false,
    })

    await systemTools[SystemToolNames.run].execute({ command: 'npm run dev' }, context)
    // 长驻服务只是体验型确认：低风险、可按类记忆，语义不变。
    expect(seen[1]).toEqual({ approvalRisk: 'low' })
  })

  test('does not count a final line ending as an extra addressable line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-'))
    const path = join(root, 'lines.txt')
    try {
      await writeFile(path, 'line-1\nline-2\n')

      const result = await executeAtomicRead({ path, startLine: 1, endLine: 99 })

      expect(result.content).toBe('line-1\nline-2\n')
      expect(result.totalLines).toBe(2)
      expect(result.endLine).toBe(2)
      await expect(
        executeAtomicRead({ path, startLine: 3, maxChars: 100 })
      ).rejects.toThrow('startLine (3) > endLine (2)')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('preserves intentional empty lines before the final line ending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-empty-lines-'))
    const path = join(root, 'lines.txt')
    try {
      await writeFile(path, 'line-1\n\n')

      const result = await executeAtomicRead({ path, startLine: 1, endLine: 99 })

      expect(result.content).toBe('line-1\n\n')
      expect(result.totalLines).toBe(2)
      expect(result.endLine).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('preserves original line endings while keeping line-address pagination exact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-line-endings-'))
    const path = join(root, 'lines.txt')
    try {
      await writeFile(path, 'line-1\r\nline-2\r\nline-3')

      const first = await executeAtomicRead({ path, startLine: 1, endLine: 2 })
      const second = await executeAtomicRead({ path, startLine: 3, endLine: 3 })

      expect(first.content).toBe('line-1\r\nline-2\r\n')
      expect(first.totalLines).toBe(3)
      expect(first.hasMore).toBe(true)
      expect(first.nextStartLine).toBe(3)
      expect(second.content).toBe('line-3')
      expect(`${first.content}${second.content}`).toBe('line-1\r\nline-2\r\nline-3')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('copies a bounded source range without round-tripping text through the model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-write-source-'))
    const sourcePath = join(root, 'source.txt')
    const targetPath = join(root, 'target.txt')
    try {
      await writeFile(sourcePath, 'one\r\n  two\r\n\r\nfour  \r\nfive\r\n')
      const source = { path: sourcePath, startLine: 2, endLine: 4 }
      const resolved = await resolveAtomicWriteContent({ path: targetPath, source })
      expect(resolved).toEqual({ content: '  two\r\n\r\nfour  \r\n', copiedFrom: source })

      await executeAtomicWrite(
        { path: targetPath, source },
        {
          abortSignal: new AbortController().signal,
          approval: {
            requestApproval: async () => ({ approved: true }),
          },
          system: {} as never,
        }
      )
      expect(await readFile(targetPath, 'utf8')).toBe('  two\r\n\r\nfour  \r\n')
      await expect(
        resolveAtomicWriteContent({ path: targetPath, content: 'x', source })
      ).rejects.toThrow('Exactly one of content or source')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
