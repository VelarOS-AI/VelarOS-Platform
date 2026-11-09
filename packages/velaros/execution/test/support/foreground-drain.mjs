import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { AppError } from '@velaros-ai/core/error'
import { createPlatform } from '@velaros-ai/core/platform'

import { ShellCommandRunner } from '../../../dist/execution/impl/local/ShellCommandRunner.js'
import { shellProcessManager } from '../../../dist/execution/impl/local/ShellProcessManager.js'
import { shellResolver } from '../../../dist/execution/impl/local/ShellResolver.js'

/** 真实 Node 进程持有双流；释放文件出现才退出，独立硬截止防失败夹具泄漏。 */
async function fixture(failInputSetup = false) {
  const directory = await mkdtemp(join(tmpdir(), 'foreground-drain-'))
  const script = join(directory, 'hold.mjs')
  await writeFile(
    script,
    `
import { existsSync, writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
const deadline = setTimeout(() => process.exit(2), 5000);
const poll = setInterval(() => {
  if (!existsSync('release')) return;
  clearInterval(poll); clearTimeout(deadline);
  process.stdout.write('late stdout\\n'); process.stderr.write('late stderr\\n');
}, 10);
writeFileSync('started', '');
`
  )
  let managed
  const runner = new ShellCommandRunner({
    platform: process.platform,
    platformTools: createPlatform({ platform: process.platform, env: process.env }),
    confinement: { mode: 'danger-full-access', workspaceRoot: directory },
    shells: shellResolver,
    processes: {
      manage: (child, options) => {
        // 终止后端明确未能送达信号，真实进程与双流继续存活。
        managed = shellProcessManager.manage(child, {
          ...options,
          terminateGraceMs: 1,
          terminationDeadlineMs: 10,
          terminate: async () => false,
        })
        if (failInputSetup && child.stdin)
          Object.assign(child.stdin, {
            end: () => {
              throw new AppError('PROTOCOL', 'fixture input setup failure')
            },
          })
        return managed
      },
      manageTerminal: shellProcessManager.manageTerminal.bind(shellProcessManager),
      find: shellProcessManager.find.bind(shellProcessManager),
      captureIdentity: shellProcessManager.captureIdentity.bind(shellProcessManager),
      resolveStatus: shellProcessManager.resolveStatus.bind(shellProcessManager),
    },
  })
  return { directory, script, runner, managed: () => managed }
}

async function waitForStarted(directory) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (existsSync(join(directory, 'started'))) return
    await delay(10)
  }
  throw new AppError('TIMEOUT', '真实 foreground fixture 没有启动。')
}

for (const mode of ['bounded-cancel', 'strict-cancel', 'strict-timeout', 'strict-setup-error']) {
  test(`INV-21 ${mode}: 有界事实与真实关闭各由同一 owner 交付`, { timeout: 15_000 }, async () => {
    const f = await fixture(mode === 'strict-setup-error')
    const controller = new AbortController()
    const strict = mode !== 'bounded-cancel'
    let settled = false
    let output = ''
    const outcome = f.runner
      .run(
        'held foreground',
        f.directory,
        {
          nativeCommand: { file: process.execPath, args: [f.script] },
          timeoutMs: mode === 'strict-timeout' ? 10 : null,
          waitForClose: strict,
          onOutput: (text) => {
            output += text
          },
        },
        controller.signal
      )
      .then(
        (value) => {
          settled = true
          return { status: 'fulfilled', value }
        },
        (error) => {
          settled = true
          return { status: 'rejected', error }
        }
      )
    try {
      await waitForStarted(f.directory)
      if (mode.endsWith('cancel')) controller.abort()
      const managed = f.managed()
      assert.ok(managed)
      const bounded = await managed.completion
      assert.equal(bounded.cleanupIncomplete, true)
      if (mode === 'strict-timeout') assert.equal(bounded.timedOut, true)
      if (mode.endsWith('cancel')) assert.equal(bounded.aborted, true)
      if (strict) {
        assert.equal(settled, false)
        const failure = await f.runner.dispose().then(
          () => null,
          (error) => error
        )
        assert.equal(failure?.code, 'PLATFORM')
        assert.equal(settled, false)
        assert.equal(managed.result?.cleanupIncomplete, true)
      } else {
        const result = await outcome
        assert.equal(result.status, 'fulfilled')
        assert.equal(result.value.cleanupIncomplete, true)
      }
      await writeFile(join(f.directory, 'release'), '')
      await managed.closing
      const result = await outcome
      if (mode === 'strict-setup-error') {
        assert.equal(result.status, 'rejected')
        assert.equal(result.error.code, 'PROTOCOL')
        assert.equal(result.error.message, 'fixture input setup failure')
      } else {
        assert.equal(result.status, 'fulfilled')
        assert.equal(result.value.cleanupIncomplete, true)
        assert.equal(result.value.success, false)
      }
      assert.ok(output.includes('late stdout\n'), output)
      assert.ok(output.includes('late stderr\n'), output)
      assert.equal(bounded.cleanupIncomplete, true)
      assert.equal(managed.result?.cleanupIncomplete, false)
      await f.runner.dispose()
      assert.equal(await readFile(join(f.directory, 'release'), 'utf8'), '')
    } finally {
      await writeFile(join(f.directory, 'release'), '')
      await f.managed()?.closing
      await outcome
      await f.runner.dispose()
      await rm(f.directory, { recursive: true, force: true })
    }
  })
}

test('INV-21 background: waitForClose 在准备和 spawn 前拒绝', { timeout: 15_000 }, async () => {
  const f = await fixture()
  try {
    const failure = await f.runner
      .run('must not spawn', f.directory, { background: true, waitForClose: true })
      .then(
        () => null,
        (error) => error
      )
    assert.equal(failure?.code, 'VALIDATION')
    assert.equal(f.managed(), undefined)
  } finally {
    await f.runner.dispose()
    await rm(f.directory, { recursive: true, force: true })
  }
})
