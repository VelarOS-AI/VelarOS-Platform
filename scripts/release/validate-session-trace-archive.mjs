import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runGuardedCommand } from './safe-package-pack.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const fixtures = path.join(import.meta.dirname, 'fixtures/host-contract-consumer')
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

// 消费已经打好的基础归档；本函数不构建、不打包，也不读取 workspace 中的实现。
export async function validateSessionTraceArchive({
  archive,
  sha256,
  sourceSha,
  releaseTag,
  version,
  receiptDirectory,
  bunVersion,
}) {
  assert.match(sha256, /^[a-f0-9]{64}$/u)
  assert.match(sourceSha, /^[a-f0-9]{40}$/u)
  assert.equal(typeof releaseTag, 'string')
  assert(releaseTag)
  assert.equal(typeof version, 'string')
  assert(version)
  assert.equal(typeof bunVersion, 'string')
  assert(bunVersion)
  const archivePath = path.resolve(archive)
  assert((await lstat(archivePath)).isFile(), 'Trace consumer requires a regular archive file')
  assert.equal(
    digest(await readFile(archivePath)),
    sha256,
    'Base archive changed before consumption'
  )
  const receiptPath = path.join(await realpath(receiptDirectory), 'session-trace-receipt.json')
  const consumer = await mkdtemp(path.join(tmpdir(), 'velaros-release-trace-consumer-'))
  const relative = path.relative(root, consumer)
  assert(
    relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    'Trace consumer must not inherit workspace node_modules'
  )
  const typescript = JSON.parse(
    await readFile(path.join(root, 'node_modules/typescript/package.json'), 'utf8')
  ).version
  const nodeTypes = JSON.parse(
    await readFile(path.join(root, 'node_modules/@types/node/package.json'), 'utf8')
  ).version
  const receipt = {
    schemaVersion: 1,
    kind: 'session-trace-archive-consumer',
    name: '@velaros-ai/velaros',
    version,
    sourceSha,
    releaseTag,
    sha256,
    toolchain: {
      node: process.version,
      bun: bunVersion,
      typescript,
      nodeTypes,
      platform: process.platform,
      arch: process.arch,
    },
    fixtures: {},
    validation: { javascript: false, strictDeclarations: false },
    local: { archive: archivePath, consumer, receiptPath },
  }
  const saveReceipt = () => writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !['NODE_OPTIONS', 'NODE_PATH'].includes(name.toUpperCase())
    )
  )
  const baseSpecifier = `file:${archivePath.split(path.sep).join('/')}`
  try {
    await writeFile(
      path.join(consumer, 'package.json'),
      `${JSON.stringify(
        {
          name: 'velaros-release-session-trace-consumer',
          private: true,
          type: 'module',
          dependencies: { '@velaros-ai/velaros': baseSpecifier },
          devDependencies: { typescript, '@types/node': nodeTypes },
          overrides: { '@velaros-ai/velaros': baseSpecifier },
        },
        null,
        2
      )}\n`
    )
    for (const [kind, file] of [
      ['javascript', 'session-trace-consumer.mjs'],
      ['declarations', 'session-trace-consumer.mts'],
    ]) {
      receipt.fixtures[kind] = {
        fileName: file,
        sha256: digest(await readFile(path.join(fixtures, file))),
      }
      await copyFile(path.join(fixtures, file), path.join(consumer, file))
    }
    await saveReceipt()
    await runGuardedCommand({
      command: 'bun',
      args: ['install', '--ignore-scripts'],
      cwd: consumer,
      env: environment,
      timeoutMs: 180_000,
      operation: 'Install the exact release base archive for session trace consumption',
    })
    assert.deepEqual((await readdir(path.join(consumer, 'node_modules/@velaros-ai'))).sort(), [
      'velaros',
    ])
    const installed = JSON.parse(
      await readFile(path.join(consumer, 'node_modules/@velaros-ai/velaros/package.json'), 'utf8')
    )
    assert.equal(installed.name, receipt.name)
    assert.equal(installed.version, version)
    const javascript = await runGuardedCommand({
      command: process.execPath,
      args: ['session-trace-consumer.mjs'],
      cwd: consumer,
      env: environment,
      timeoutMs: 60_000,
      operation: 'Consume the release session trace archive in plain Node',
    })
    receipt.local.javascriptOutput = javascript.stdout
    receipt.validation.javascriptOutputSha256 = digest(javascript.stdout)
    receipt.validation.javascript = true
    await saveReceipt()
    await runGuardedCommand({
      command: process.execPath,
      args: [
        path.join(consumer, 'node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        'false',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--target',
        'ES2022',
        '--types',
        'node',
        'session-trace-consumer.mts',
      ],
      cwd: consumer,
      env: environment,
      timeoutMs: 60_000,
      operation: 'Consume the release session trace declarations with skipLibCheck false',
    })
    assert.equal(
      digest(await readFile(archivePath)),
      sha256,
      'Base archive changed during consumption'
    )
    receipt.validation.strictDeclarations = true
    await saveReceipt()
    return receipt
  } catch (error) {
    receipt.local.failure = error instanceof Error ? error.message : String(error)
    await saveReceipt()
    throw error
  }
}
