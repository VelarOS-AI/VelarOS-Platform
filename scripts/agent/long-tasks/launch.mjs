#!/usr/bin/env node
// 外层启动器负责信号域、批次互斥及收尾；模型与命令全部继承同一内核边界。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { acquireCampaignExecution, verifyExecutionLaunch } from './execution-isolation.mjs'
import { archiveTaskResources, createTaskProcessGuard } from './resource-lifecycle.mjs'

const directory = await realpath(process.argv[2])
const frozen = await readFile(join(directory, 'freeze.json'))
const manifest = JSON.parse(frozen)
await verifyExecutionLaunch(directory, manifest, import.meta.filename)
assert(manifest.resources, 'Isolated evaluation requires registered resources')
assert(!manifest.desktop, 'An external Desktop process cannot inherit this execution boundary')
const release = await acquireCampaignExecution(manifest.campaignDirectory, directory)
const launchId = randomUUID()
const receiptDirectory = join(directory, 'isolation')
const save = async (kind, value) => {
  await writeFile(
    join(receiptDirectory, `${launchId}.${kind}.json`),
    JSON.stringify(value, null, 2),
    {
      flag: 'wx',
      mode: 0o600,
    }
  )
}
let child
let guard
let stopped = false
let escalation
let outcome
let cleanup
let failure
const signalChild = (signal, group = false) => {
  if (!child?.pid) return
  try {
    process.kill(group ? -child.pid : child.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}
const cancel = () => {
  if (stopped) return
  stopped = true
  signalChild('SIGTERM')
  escalation = setTimeout(() => signalChild('SIGKILL', true), 10000)
}
try {
  await mkdir(receiptDirectory, { recursive: true })
  const cleanupDirectory = join(receiptDirectory, launchId)
  await mkdir(cleanupDirectory)
  guard = await createTaskProcessGuard(manifest.resources, manifest.taskRoot, cleanupDirectory)
  await save('launch', {
    launchId,
    at: new Date().toISOString(),
    parentPid: process.pid,
    worker: manifest.worker,
    profileSha256: manifest.executionIsolation.profileSha256,
    freezeSha256: createHash('sha256').update(frozen).digest('hex'),
  })
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  child = spawn(
    manifest.executionIsolation.backend,
    [
      '-p',
      manifest.executionIsolation.profile,
      manifest.commandEnvironment.node,
      manifest.worker,
      directory,
      ...process.argv.slice(3),
    ],
    {
      cwd: directory,
      detached: true,
      env: {
        ...process.env,
        PATH: manifest.commandEnvironment.path,
        VELAROS_EVAL_LAUNCH_ID: launchId,
      },
      stdio: 'inherit',
    }
  )
  outcome = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
} catch (error) {
  failure = error
} finally {
  clearTimeout(escalation)
  process.off('SIGINT', cancel)
  process.off('SIGTERM', cancel)
  try {
    signalChild('SIGKILL', true)
    cleanup = await guard?.stop()
    if (outcome?.code === 0 && !stopped && !failure) {
      const proof = JSON.parse(await readFile(join(receiptDirectory, `${launchId}.worker.json`)))
      assert.equal(proof.pid, child.pid)
      const complete = JSON.parse(
        await readFile(join(receiptDirectory, `${launchId}.completed.json`))
      )
      assert.equal(complete.launchId, launchId)
      assert.equal(complete.finished, true)
      assert.equal(cleanup.scopeEmpty, true)
      await archiveTaskResources(manifest.resources)
    }
  } catch (error) {
    failure = failure ? new AggregateError([failure, error]) : error
  }
  await save('exit', {
    launchId,
    at: new Date().toISOString(),
    outcome,
    stopped,
    cleanup,
    failure: failure ? { name: failure.name, message: failure.message } : null,
  })
  // 回收结果不确定时保留锁，后续尝试不能自动覆盖现场或与残留执行重叠。
  if (!child || cleanup?.scopeEmpty === true) await release()
}
if (failure) throw failure
process.exitCode = !stopped && outcome?.code === 0 ? 0 : 1
