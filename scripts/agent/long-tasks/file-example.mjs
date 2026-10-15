// “可运行文件示例”可自包含，也可接受一个实际输入文件；保留两种调用的真实结果。
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { runCapturedCommand } from './command-output.mjs'

export async function runFileExample({
  cwd,
  entry,
  fixture,
  filename = 'input.txt',
  timeoutMs = 10000,
}) {
  assert.equal(basename(filename), filename, 'Fixture filename must be a single path component')
  assert(filename !== '.' && filename !== '..' && filename.length > 0)
  assert.equal(typeof fixture, 'string')
  const attempts = []
  const invoke = async (args) => {
    const result = await runCapturedCommand(process.execPath, [entry, ...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1_000_000,
    })
    attempts.push({ arguments: args, ...result })
    return result
  }
  const initial = await invoke([])
  if (initial.exitCode === 0 || initial.timedOut || !Number.isInteger(initial.exitCode))
    return { passed: initial.exitCode === 0, attempts }
  const directory = await mkdtemp(join(tmpdir(), 'velaros-file-example-'))
  try {
    const input = join(directory, filename)
    await writeFile(input, fixture, { flag: 'wx', mode: 0o600 })
    const result = await invoke([input])
    return { passed: result.exitCode === 0, attempts, fixture: { filename, text: fixture } }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
