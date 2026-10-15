// 既有公共行为验收加压测交付核验；小时级资格仍需宿主真实命令与源码审计。
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { runCapturedCommand } from './command-output.mjs'
import { assertReliabilityAppend, readReliabilityEvidence } from './reliability-evidence.mjs'
import './test_roomsync_service.mjs'

const script = resolve('contrib/roomsync/test/reliability-soak.js')

test(
  'reliability CLI runs real short workloads, resumes evidence and rejects corrupt checkpoints',
  { timeout: 45000 },
  async (t) => {
    assert(existsSync(script), 'reliability-soak.js must exist')
    const temporary = await mkdtemp(join(tmpdir(), 'roomsync-soak-accept-'))
    t.after(() => rm(temporary, { recursive: true, force: true }))
    const directory = join(temporary, 'campaign')
    const run = (destination, duration, faultInterval = 500) =>
      runCapturedCommand(
        process.execPath,
        [
          script,
          '--directory',
          destination,
          '--duration-ms',
          String(duration),
          ...(faultInterval === null ? [] : ['--fault-interval-ms', String(faultInterval)]),
        ],
        { cwd: process.cwd(), env: process.env, timeout: 15000 }
      )
    const firstRun = await run(directory, 3500)
    assert.equal(firstRun.exitCode, 0, JSON.stringify(firstRun))
    const first = await readReliabilityEvidence(directory, {
      productiveMs: 3500,
      transactions: 5,
      faults: 1,
    })
    const secondRun = await run(directory, 2500)
    assert.equal(secondRun.exitCode, 0, JSON.stringify(secondRun))
    const second = await readReliabilityEvidence(directory, {
      productiveMs: 6000,
      transactions: first.transactions + 5,
      faults: 2,
    })
    assertReliabilityAppend(first, second, {
      productiveMs: 2500,
      transactions: 5,
      faults: 1,
    })
    // 默认故障间隔长于本次短测，仍须补齐这一次调用的四类故障。
    const defaultRun = await run(directory, 1000, null)
    assert.equal(defaultRun.exitCode, 0, JSON.stringify(defaultRun))
    const third = await readReliabilityEvidence(directory, {
      productiveMs: 7000,
      transactions: second.transactions + 5,
      faults: 3,
    })
    assertReliabilityAppend(second, third, {
      productiveMs: 1000,
      transactions: 5,
      faults: 1,
    })
    const corrupt = join(temporary, 'corrupt')
    await cp(directory, corrupt, { recursive: true })
    const text = await readFile(join(corrupt, 'report.json'), 'utf8')
    const damaged = JSON.parse(text)
    damaged.segments[0].sha256 = '0'.repeat(64)
    const changed = JSON.stringify(damaged)
    await writeFile(join(corrupt, 'report.json'), changed)
    const rejected = await run(corrupt, 3500)
    assert.notEqual(rejected.exitCode, 0, 'Corrupt evidence must be rejected')
    assert.equal(
      await readFile(join(corrupt, 'report.json'), 'utf8'),
      changed,
      'Rejection must preserve evidence'
    )
    const invalid = await run(join(temporary, 'invalid'), -1)
    assert.notEqual(invalid.exitCode, 0, 'Invalid duration must be rejected')
  }
)

test(
  'long campaign retains hash-bound productive work and an operational report',
  { timeout: 30000 },
  async () => {
    await readReliabilityEvidence(resolve('contrib/roomsync/reliability'))
    const report = await readFile('contrib/roomsync/reliability/REPORT.md', 'utf8')
    assert(report.trim().length >= 300, 'Record commands, measurements, findings and limitations')
  }
)
