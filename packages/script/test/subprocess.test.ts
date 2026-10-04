import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createNodeCodeRunner } from '../src/impl/NodeCodeRunner'
import type { CodeRunRequest } from '../src/types/runner'
import { executeNativeNode } from '../src/utils/native-process'

const request = (source: string, extra: Partial<CodeRunRequest> = {}): CodeRunRequest => ({
  source,
  modules: {},
  blobs: {},
  input: null,
  operations: {},
  timeoutMs: 1000,
  ...extra,
})
const noCalls = async () => ({})
const log = () => {}
async function fixture(run: (cwd: string, directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'native-script-test-'))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  try {
    await run(cwd, join(root, 'runs'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('INV-28 宿主 Node 进程注入与回收', () => {
  test('预取消和审批拒绝均不启动进程', () =>
    fixture(async (cwd, directory) => {
      let launches = 0
      const runner = createNodeCodeRunner({
        cwd,
        directory,
        authorize: async () => {
          throw new Error('denied')
        },
        execute: async () => {
          launches++
          throw new Error('unexpected')
        },
      })
      expect(
        (await runner.run(request('console.log(1)'), noCalls, log, AbortSignal.abort())).error?.code
      ).toBe('ABORTED')
      expect((await runner.run(request('console.log(1)'), noCalls, log)).error?.message).toContain(
        'denied'
      )
      expect(launches).toBe(0)
    }))
  test('注入的进程收束失败不能报告成功', () =>
    fixture(async (cwd, directory) => {
      const runner = createNodeCodeRunner({
        cwd,
        directory,
        execute: async () => ({
          exitCode: 0,
          signal: null,
          stdout: 'partial',
          stderr: '',
          cleanupIncomplete: true,
        }),
      })
      const result = await runner.run(request(''), noCalls, log)
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('RUNNER_CRASHED')
      expect(result.process?.stdout).toBe('partial')
    }))
  test('真实 Node 同步失败、输出与 Shell heredoc 使用同一进程口', () =>
    fixture(async (cwd, directory) => {
      const runner = createNodeCodeRunner({ cwd, directory, execute: executeNativeNode })
      const result = await runner.run(
        request("cat <<'EOF' > note.txt\n$notExpanded `literal`\nEOF\ncat note.txt", {
          language: 'shell',
          input: undefined,
        }),
        noCalls,
        log
      )
      expect(result.ok).toBe(true)
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('$notExpanded `literal`\n')
      const failed = await runner.run(
        request("console.log('before');throw new Error('failed')"),
        noCalls,
        log
      )
      expect(failed.error?.message).toBe('failed')
      expect(failed.process?.stdout).toContain('before')
    }))
  test('超时后回收同一进程组中的子进程', () =>
    fixture(async (cwd, directory) => {
      const runner = createNodeCodeRunner({ cwd, directory, execute: executeNativeNode })
      const result = await runner.run(
        request(
          "import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync('pid.txt',String(child.pid));setInterval(()=>{},1000)",
          { timeoutMs: 500 }
        ),
        noCalls,
        log
      )
      expect(result.error?.code).toBe('TIMEOUT')
      const pid = Number(await readFile(join(cwd, 'pid.txt'), 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
    }))
  test('输出在异常和 CPU 超时后仍保留，不会被 catch 隐藏非法输出', () =>
    fixture(async (cwd, directory) => {
      const runner = createNodeCodeRunner({ cwd, directory, execute: executeNativeNode })
      for (const tail of ["throw new Error('failed')", 'while(true){}']) {
        const result = await runner.run(
          request(`import {output} from 'velaros';output({n:42});${tail}`, { timeoutMs: 300 }),
          noCalls,
          log
        )
        expect(result.ok).toBe(false)
        expect(result.output?.blocks[0]?.value).toEqual({ n: 42 })
      }
    }))
})
