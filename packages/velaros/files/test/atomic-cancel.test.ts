import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { expect, test } from 'bun:test'

const fixture = fileURLToPath(new URL('./atomic-cancel.fixture.mjs', import.meta.url))
for (const mode of ['staged-write', 'checked-delete', 'after-rename'])
  test(`atomic file cancellation at the real filesystem boundary: ${mode}`, async () => {
    // 文件系统钩子只存在于独立 Node 子进程，不会影响同时运行的其他测试。
    const { stdout } = await promisify(execFile)('node', [fixture, mode], { timeout: 10000 })
    expect(JSON.parse(stdout)).toMatchObject({ mode, success: true })
  })
