// 原生进程的日志和终态必须在评测宿主异步文件操作失效时仍可保全。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const execute = promisify(execFile)

test('CLI exit and exact output survive stalled parent asynchronous writes and reads', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'native-capture-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'fake-codex')
  const lines =
    JSON.stringify({ type: 'thread.started', thread_id: 'capture-control' }) +
    '\n' +
    JSON.stringify({ type: 'item.completed', text: '原样日志'.repeat(10000) }) +
    '\n' +
    JSON.stringify({ type: 'turn.failed' }) +
    '\n'
  const diagnostic = 'original diagnostic\n'.repeat(1000)
  await writeFile(
    executable,
    `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => { require('node:fs').writeFileSync(1, ${JSON.stringify(lines)}); require('node:fs').writeFileSync(2, ${JSON.stringify(diagnostic)}); process.exit(1) });\n`,
    { mode: 0o700 }
  )
  const worker = join(directory, 'worker.mjs')
  await writeFile(
    worker,
    `import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
// Simulate the observed parent-only asynchronous I/O failure. Child I/O is real.
fs.write = () => {};
fs.writev = () => {};
promises.readFile = () => new Promise(() => {});
syncBuiltinESMExports();
const { runCodex } = await import(${JSON.stringify(new URL('./codex.mjs', import.meta.url).href)});
const deadline = setTimeout(() => { fs.writeFileSync(2, 'capture did not settle'); process.exit(90); }, 2000);
const result = await runCodex({ executable: ${JSON.stringify(executable)}, workspace: ${JSON.stringify(directory)}, directory: ${JSON.stringify(directory)}, baseURL: 'http://127.0.0.1:1/v1', apiKey: 'fixture', model: 'fixture', prompt: 'input', timeoutMs: 1500 });
clearTimeout(deadline);
fs.writeFileSync(1, JSON.stringify(result));
`
  )
  const completed = await execute(process.execPath, [worker], { timeout: 5000 })
  const result = JSON.parse(completed.stdout)
  assert.equal(result.code, 1)
  assert.equal(result.terminalComplete, false)
  assert.equal(result.timedOut, false)
  assert.equal(result.threadId, 'capture-control')
  assert.equal(result.eventCount, 3)
  assert.equal(await readFile(join(directory, 'codex.jsonl'), 'utf8'), lines)
  assert.equal(await readFile(join(directory, 'codex.stderr'), 'utf8'), diagnostic)
  const checkpoint = JSON.parse(await readFile(join(directory, 'codex-exit.json'), 'utf8'))
  assert.equal(checkpoint.code, 1)
  assert.equal(checkpoint.signal, null)
  assert.equal(checkpoint.pid > 0, true)
  assert.equal(checkpoint.exitedAt <= result.finishedAt, true)
})
