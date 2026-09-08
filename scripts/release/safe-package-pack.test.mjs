import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { safePackPackage, windowsTaskkillArguments } from './safe-package-pack.mjs'

const fakeBunSource = `#!/bin/sh
if [ "$SAFE_PACK_FAKE_MODE" = "hang" ]; then
  trap '' TERM
  /bin/sh -c 'trap "" TERM; while :; do sleep 1; done' &
  grandchild=$!
  printf '{"child":%s,"grandchild":%s}\n' "$$" "$grandchild" > "$SAFE_PACK_PID_FILE"
  while :; do sleep 1; done
elif [ "$SAFE_PACK_FAKE_MODE" = "orphan" ]; then
  /bin/sh -c 'trap "" HUP; while :; do sleep 1; done' </dev/null >/dev/null 2>&1 &
  grandchild=$!
  printf '{"child":%s,"grandchild":%s}\n' "$$" "$grandchild" > "$SAFE_PACK_PID_FILE"
  exit 0
else
  exec node -e 'const { writeFileSync } = require("node:fs"); writeFileSync(process.env.SAFE_PACK_CAPTURE_FILE, JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd() }))' "$@"
fi
`

async function createFixture(t, manifest = { name: 'leaf-package', version: '1.0.0' }) {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'velaros-safe-pack-test-'))
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }))

  const packageDirectory = path.join(fixtureRoot, 'package')
  const destination = path.join(fixtureRoot, 'archives')
  await mkdir(packageDirectory)
  await mkdir(destination)
  await writeFile(path.join(packageDirectory, 'package.json'), `${JSON.stringify(manifest)}\n`)
  return { destination, fixtureRoot, packageDirectory }
}

async function installFakeBun(t, fixtureRoot, mode = 'capture') {
  const binDirectory = path.join(fixtureRoot, 'bin')
  await mkdir(binDirectory)
  if (process.platform === 'win32') {
    const runnerPath = path.join(binDirectory, 'fake-bun.cjs')
    await writeFile(runnerPath, `
const { writeFileSync } = require('node:fs')
writeFileSync(process.env.SAFE_PACK_CAPTURE_FILE, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
}))
`)
    return { binDirectory, bunArguments: [runnerPath], bunCommand: process.execPath }
  } else {
    await writeFile(path.join(binDirectory, 'bun'), fakeBunSource)
    await chmod(path.join(binDirectory, 'bun'), 0o755)
  }

  const previousPath = process.env.PATH
  const previousMode = process.env.SAFE_PACK_FAKE_MODE
  process.env.PATH = `${binDirectory}${path.delimiter}${previousPath ?? ''}`
  process.env.SAFE_PACK_FAKE_MODE = mode
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousMode === undefined) delete process.env.SAFE_PACK_FAKE_MODE
    else process.env.SAFE_PACK_FAKE_MODE = previousMode
  })
  return { binDirectory, bunArguments: [], bunCommand: 'bun' }
}

function setTestEnvironment(t, name, value) {
  const previousValue = process.env[name]
  process.env[name] = value
  t.after(() => {
    if (previousValue === undefined) delete process.env[name]
    else process.env[name] = previousValue
  })
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

function registerProcessGroupCleanup(t, pidFile) {
  if (process.platform === 'win32') return
  t.after(() => {
    let child
    try {
      child = JSON.parse(readFileSync(pidFile, 'utf8')).child
    } catch {
      return
    }
    if (!Number.isSafeInteger(child) || child <= 1) return
    try {
      process.kill(-child, 'SIGKILL')
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  })
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

function waitForChildExit(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      reject(new Error(`child ${child.pid ?? 'unknown'} did not exit within ${timeoutMs} ms`))
    }, timeoutMs)
    child.once('error', reject)
    child.once('close', (code, signal) => {
      clearTimeout(timeoutHandle)
      resolve({ code, signal })
    })
  })
}

async function startHangingPackRunner(
  t,
  { destination, fixtureRoot, packageDirectory, pidFile, ipc = false },
) {
  const { binDirectory } = await installFakeBun(t, fixtureRoot, 'hang')
  registerProcessGroupCleanup(t, pidFile)
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, 'safe-package-pack.mjs')).href
  const runnerSource = `
    import { safePackPackage } from ${JSON.stringify(moduleUrl)}
    const packing = safePackPackage({
      packageDirectory: process.env.SAFE_PACK_PACKAGE,
      destination: process.env.SAFE_PACK_DESTINATION,
      timeoutMs: 60_000,
    })
    process.on('message', (message) => {
      if (message === 'exit-now') process.exit(23)
    })
    await packing
  `
  const runner = spawn(process.execPath, ['--input-type=module', '--eval', runnerSource], {
    env: {
      ...process.env,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
      SAFE_PACK_DESTINATION: destination,
      SAFE_PACK_FAKE_MODE: 'hang',
      SAFE_PACK_PACKAGE: packageDirectory,
      SAFE_PACK_PID_FILE: pidFile,
    },
    stdio: ipc ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore',
  })
  t.after(() => {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL')
  })

  assert.equal(
    await waitFor(() => {
      try {
        return Boolean(JSON.parse(readFileSync(pidFile, 'utf8')))
      } catch {
        return false
      }
    }),
    true,
    'fake Bun did not report its process group',
  )
  return runner
}

test('rejects a workspace root instead of packing it as a leaf package', async (t) => {
  const { destination, packageDirectory } = await createFixture(t, {
    name: 'workspace-root',
    private: true,
    workspaces: ['packages/*'],
  })

  await assert.rejects(
    safePackPackage({ packageDirectory, destination }),
    /must be a leaf package; workspace roots cannot be packed/u,
  )
})

test('rejects shared temporary roots as archive destinations', async (t) => {
  const { packageDirectory } = await createFixture(t)

  await assert.rejects(
    safePackPackage({ packageDirectory, destination: tmpdir() }),
    /must not be a shared temporary root/u,
  )
})

test('rejects a symbolic-link destination before Bun can enter its makePath loop', async (t) => {
  const { destination, fixtureRoot, packageDirectory } = await createFixture(t)
  const destinationLink = path.join(fixtureRoot, 'archives-link')
  await symlink(destination, destinationLink)

  await assert.rejects(
    safePackPackage({ packageDirectory, destination: destinationLink }),
    /destination must not be a symbolic link/u,
  )
})

test('requires a publishable package identity', async (t) => {
  const { destination, packageDirectory } = await createFixture(t, { private: true })

  await assert.rejects(
    safePackPackage({ packageDirectory, destination }),
    /package\.json must declare a non-empty name/u,
  )
})

test('spawns Bun in the leaf package with only destination option arguments', async (t) => {
  const { destination, fixtureRoot, packageDirectory } = await createFixture(t)
  const fakeBun = await installFakeBun(t, fixtureRoot)
  const captureFile = path.join(fixtureRoot, 'capture.json')
  setTestEnvironment(t, 'SAFE_PACK_CAPTURE_FILE', captureFile)

  const result = await safePackPackage({ packageDirectory, destination, ...fakeBun })
  const invocation = JSON.parse(await readFile(captureFile, 'utf8'))

  assert.equal(result.code, 0)
  assert.equal(invocation.cwd, await realpath(packageDirectory))
  assert.deepEqual(invocation.argv, [
    'pm',
    'pack',
    '--destination',
    await realpath(destination),
    '--ignore-scripts',
    '--quiet',
  ])
  assert.equal(invocation.argv.includes(await realpath(packageDirectory)), false)
})

test('supports a safe explicit tgz filename without a package positional argument', async (t) => {
  const { destination, fixtureRoot, packageDirectory } = await createFixture(t)
  const fakeBun = await installFakeBun(t, fixtureRoot)
  const captureFile = path.join(fixtureRoot, 'filename-capture.json')
  const filename = path.join(destination, 'leaf-package.tgz')
  setTestEnvironment(t, 'SAFE_PACK_CAPTURE_FILE', captureFile)

  await safePackPackage({ packageDirectory, filename, ...fakeBun })
  const invocation = JSON.parse(await readFile(captureFile, 'utf8'))

  assert.deepEqual(invocation.argv, [
    'pm',
    'pack',
    '--filename',
    path.join(await realpath(destination), 'leaf-package.tgz'),
    '--ignore-scripts',
    '--quiet',
  ])
  assert.equal(invocation.argv.includes(await realpath(packageDirectory)), false)
})

test('requires destination and filename to be exclusive and safely separated from source', async (t) => {
  const { destination, packageDirectory } = await createFixture(t)
  const nestedDestination = path.join(packageDirectory, 'archives')
  await mkdir(nestedDestination)

  await assert.rejects(
    safePackPackage({
      packageDirectory,
      destination,
      filename: path.join(destination, 'leaf-package.tgz'),
    }),
    /Exactly one of destination or filename/u,
  )
  await assert.rejects(
    safePackPackage({ packageDirectory, destination: nestedDestination }),
    /must not overlap package source/u,
  )
  await assert.rejects(
    safePackPackage({ packageDirectory, filename: path.join(packageDirectory, 'unsafe.tgz') }),
    /must not overlap package source/u,
  )
})

test('uses taskkill tree arguments and force only for escalation on Windows', () => {
  assert.deepEqual(windowsTaskkillArguments(123), ['/PID', '123', '/T'])
  assert.deepEqual(
    windowsTaskkillArguments(123, { force: true }),
    ['/PID', '123', '/T', '/F'],
  )
})

test('times out and removes the detached Bun process group including its grandchild', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { destination, fixtureRoot, packageDirectory } = await createFixture(t)
  await installFakeBun(t, fixtureRoot, 'hang')
  const pidFile = path.join(fixtureRoot, 'pids.json')
  setTestEnvironment(t, 'SAFE_PACK_PID_FILE', pidFile)
  registerProcessGroupCleanup(t, pidFile)

  const readiness = waitFor(() => {
    try {
      return Boolean(JSON.parse(readFileSync(pidFile, 'utf8')))
    } catch {
      return false
    }
  }, 1_500)
  const timeoutResult = safePackPackage({
    packageDirectory,
    destination,
    timeoutMs: 2_000,
  }).then(
    () => ({ error: undefined }),
    (error) => ({ error }),
  )

  assert.equal(await readiness, true, 'fake Bun did not install its signal traps before timeout')
  const { error } = await timeoutResult
  assert.match(error?.message ?? '', /timed out after 2000 ms.*SIGTERM followed by SIGKILL/u)

  const { child, grandchild } = JSON.parse(await readFile(pidFile, 'utf8'))
  assert.equal(await waitFor(() => !isProcessAlive(child)), true, `child ${child} remained alive`)
  assert.equal(
    await waitFor(() => !isProcessAlive(grandchild)),
    true,
    `grandchild ${grandchild} remained alive`,
  )
})

test('removes a same-group grandchild after the Bun leader exits successfully', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { destination, fixtureRoot, packageDirectory } = await createFixture(t)
  await installFakeBun(t, fixtureRoot, 'orphan')
  const pidFile = path.join(fixtureRoot, 'orphan-pid.json')
  setTestEnvironment(t, 'SAFE_PACK_PID_FILE', pidFile)
  registerProcessGroupCleanup(t, pidFile)

  const result = await safePackPackage({
    packageDirectory,
    destination,
    stdio: 'ignore',
    timeoutMs: 5_000,
  })
  const { grandchild } = JSON.parse(await readFile(pidFile, 'utf8'))

  assert.equal(result.code, 0)
  assert.equal(
    await waitFor(() => !isProcessAlive(grandchild)),
    true,
    `grandchild ${grandchild} remained alive after its Bun leader exited`,
  )
})

test('cleans the Bun process group on SIGHUP even if another signal arrives during cleanup', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { destination, fixtureRoot, packageDirectory } = await createFixture(t)
  const pidFile = path.join(fixtureRoot, 'signal-pids.json')
  const runner = await startHangingPackRunner(t, {
    destination,
    fixtureRoot,
    packageDirectory,
    pidFile,
  })
  runner.kill('SIGHUP')
  setTimeout(() => {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGTERM')
  }, 50)
  const status = await waitForChildExit(runner)
  const { child, grandchild } = JSON.parse(await readFile(pidFile, 'utf8'))

  assert.deepEqual(status, { code: null, signal: 'SIGHUP' })
  assert.equal(await waitFor(() => !isProcessAlive(child)), true, `child ${child} remained alive`)
  assert.equal(
    await waitFor(() => !isProcessAlive(grandchild)),
    true,
    `grandchild ${grandchild} remained alive`,
  )
})

test('uses the synchronous exit fallback when the parent calls process.exit', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { destination, fixtureRoot, packageDirectory } = await createFixture(t)
  const pidFile = path.join(fixtureRoot, 'exit-pids.json')
  const runner = await startHangingPackRunner(t, {
    destination,
    fixtureRoot,
    ipc: true,
    packageDirectory,
    pidFile,
  })

  runner.send('exit-now')
  const status = await waitForChildExit(runner)
  const { child, grandchild } = JSON.parse(await readFile(pidFile, 'utf8'))

  assert.deepEqual(status, { code: 23, signal: null })
  assert.equal(await waitFor(() => !isProcessAlive(child)), true, `child ${child} remained alive`)
  assert.equal(
    await waitFor(() => !isProcessAlive(grandchild)),
    true,
    `grandchild ${grandchild} remained alive`,
  )
})
