import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'
import { nodeExecutable } from '@velaros-ai/script'

const fixture = fileURLToPath(new URL('../support/foreground-drain.mjs', import.meta.url))

// 被测 runner、Managed 与真实进程的完整生命周期都在 Node 中；Bun 只等待独立测试进程结束。
for (const mode of [
  'bounded-cancel',
  'strict-cancel',
  'strict-timeout',
  'strict-setup-error',
  'background',
]) {
  test(`INV-21 ${mode}: Node 验证有界事实与真实排空`, () => {
    const executable = nodeExecutable.resolve()
    if (!executable) throw new AppError('UNAVAILABLE', 'foreground drain fixture 需要真实 Node。')
    const result = spawnSync(
      executable,
      ['--test', `--test-name-pattern=^INV-21 ${mode}:`, fixture],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true }
    )
    expect(result.status, `${result.stdout}\n${result.stderr}\n${String(result.error ?? '')}`).toBe(
      0
    )
  }, 15_000)
}
