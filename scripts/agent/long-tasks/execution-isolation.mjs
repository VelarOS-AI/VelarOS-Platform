// 每次评测独占内核信号域与批次锁；启动证明由真实跨域信号拒绝产生。
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export const signalProfile = [
  '(version 1)',
  '(allow default)',
  '(deny signal)',
  '(allow signal (target self) (target same-sandbox))',
].join('\n')

const hash = (value) => createHash('sha256').update(value).digest('hex')

export function executionIsolation() {
  assert.equal(process.platform, 'darwin', 'This evaluation signal boundary requires macOS')
  return {
    schema: 1,
    backend: '/usr/bin/sandbox-exec',
    profile: signalProfile,
    profileSha256: hash(signalProfile),
    scope: 'process-signals',
    serialization: 'campaign-exclusive',
    limitations:
      'Filesystem and network access remain unrestricted; detached descendants outside registered cwd have unknown cleanup coverage',
  }
}

export async function acquireCampaignExecution(campaign, attempt) {
  campaign = await realpath(campaign)
  attempt = await realpath(attempt)
  assert.equal(dirname(attempt), campaign, 'Attempt must be a direct child of its campaign')
  const path = join(campaign, '.paid-execution.lock')
  const owner = { nonce: randomUUID(), pid: process.pid, attempt, at: new Date().toISOString() }
  const handle = await open(path, 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST')
      throw new Error(`Campaign already has an execution lock; inspect its owner: ${path}`)
    throw error
  })
  let identity
  try {
    await handle.writeFile(JSON.stringify(owner, null, 2) + '\n')
    await handle.sync()
    identity = await handle.stat()
  } finally {
    await handle.close()
  }
  return async () => {
    const current = await lstat(path)
    assert.equal(current.dev, identity.dev, 'Campaign lock device changed')
    assert.equal(current.ino, identity.ino, 'Campaign lock identity changed')
    assert.equal(JSON.parse(await readFile(path, 'utf8')).nonce, owner.nonce)
    await rm(path)
  }
}

export async function verifyExecutionLaunch(directory, manifest, launcher) {
  assert.equal(launcher, manifest.controller, 'Run the frozen launch.mjs printed by prepare.mjs')
  assert.deepEqual(manifest.executionIsolation, executionIsolation())
  assert.equal(await realpath(directory), directory, 'Attempt path must be canonical')
  assert.equal(await realpath(manifest.campaignDirectory), dirname(directory))
  assert.equal(process.execPath, manifest.commandEnvironment.node)
  assert.equal(process.version, manifest.commandEnvironment.nodeVersion)
  for (const path of [launcher, manifest.worker, import.meta.filename, process.execPath]) {
    assert.equal(typeof manifest.files[path], 'string', `Missing frozen input: ${path}`)
    assert.equal(hash(await readFile(path)), manifest.files[path], `Frozen input changed: ${path}`)
  }
}

export async function verifyIsolatedWorker(directory, manifest) {
  assert.deepEqual(manifest.executionIsolation, executionIsolation())
  const launchId = process.env.VELAROS_EVAL_LAUNCH_ID
  assert.match(launchId ?? '', /^[a-f\d-]{36}$/u, 'Use the registered evaluation launcher')
  const receiptPath = join(directory, 'isolation', `${launchId}.launch.json`)
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  assert.equal(receipt.launchId, launchId)
  assert.equal(receipt.parentPid, process.ppid, 'Worker must be a direct child of its launcher')
  assert.equal(receipt.worker, resolve(process.argv[1]))
  assert.equal(receipt.worker, manifest.worker)
  assert.equal(receipt.profileSha256, manifest.executionIsolation.profileSha256)
  assert.equal(receipt.freezeSha256, hash(await readFile(join(directory, 'freeze.json'))))
  // SIGCONT 不改变正常运行的父进程；内核必须拒绝它，环境变量本身不构成证明。
  let denied = false
  try {
    process.kill(process.ppid, 'SIGCONT')
  } catch (error) {
    assert.equal(error.code, 'EPERM')
    denied = true
  }
  assert(denied, 'Kernel did not enforce the evaluation signal boundary')
  const proof = {
    launchId,
    at: new Date().toISOString(),
    pid: process.pid,
    parentPid: process.ppid,
    profileSha256: receipt.profileSha256,
    foreignSignal: { signal: 'SIGCONT', result: 'EPERM' },
  }
  await writeFile(join(directory, 'isolation', `${launchId}.worker.json`), JSON.stringify(proof), {
    flag: 'wx',
    mode: 0o600,
  })
  return proof
}
