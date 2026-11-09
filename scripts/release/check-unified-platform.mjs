// 一个真实消费者依次核验基础独立安装与显式能力扩展；归档每种只生成一次。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { safePackPackage, runGuardedCommand } from './safe-package-pack.mjs'
import { platformDistributions } from './platform-distributions.mjs'

const root = path.resolve(import.meta.dirname, '../..')
delete process.env.NODE_OPTIONS
delete process.env.NODE_PATH
const arguments_ = process.argv.slice(2)
const resume = arguments_[0] === '--resume'
if (
  arguments_.length &&
  (!resume ||
    ![4, 8].includes(arguments_.length) ||
    arguments_[2] !== '--base-sha256' ||
    !/^[a-f0-9]{64}$/u.test(arguments_[3]) ||
    (arguments_.length === 8 &&
      (arguments_[4] !== '--capabilities-archive' ||
        arguments_[6] !== '--capabilities-sha256' ||
        !/^[a-f0-9]{64}$/u.test(arguments_[7]))))
)
  throw new Error(
    'Usage: check-unified-platform.mjs [--resume <verification-directory> --base-sha256 <verified-hash> [--capabilities-archive <archive> --capabilities-sha256 <verified-hash>]]'
  )
const destination = resume
  ? await realpath(arguments_[1])
  : await mkdtemp(path.join(tmpdir(), 'velaros-distribution-check-'))
if (resume) {
  const temporaryRoot = await realpath(tmpdir())
  const relative = path.relative(temporaryRoot, destination)
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !path.basename(destination).startsWith('velaros-distribution-check-')
  )
    throw new Error(
      'Resume requires a dedicated Platform verification directory under the system temporary directory'
    )
}
const consumer = path.join(destination, 'consumer')
if (!resume) await mkdir(consumer)
else if ((await realpath(consumer)) !== consumer)
  throw new Error('Resume consumer must not be a symbolic link')
console.log(`Distribution verification directory: ${destination}`)
const source = path.join(root, 'packages/velaros')
const sourceManifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const sourceSha = (
  await runGuardedCommand({
    command: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd: root,
    operation: 'Read validation source identity',
  })
).stdout.trim()
const sourceStatus = (
  await runGuardedCommand({
    command: 'git',
    args: ['status', '--porcelain', '--untracked-files=all'],
    cwd: root,
    operation: 'Read validation working-tree state',
  })
).stdout.trim()
const dependencies = { '@types/node': rootManifest.devDependencies['@types/node'] }
const previous = resume
  ? JSON.parse(await readFile(path.join(destination, 'receipt.json'), 'utf8'))
  : undefined
if (
  resume &&
  (previous.sourceSha !== sourceSha ||
    previous.platform !== process.platform ||
    previous.node !== process.version ||
    previous.consumer !== consumer ||
    !Array.isArray(previous.evidence))
)
  throw new Error(
    'Resume receipt does not match the current source, host, Node version or consumer'
  )
const evidence = previous?.evidence ?? []
const saveReceipt = () =>
  writeFile(
    path.join(destination, 'receipt.json'),
    `${JSON.stringify({ sourceSha, sourceStatus, resumedBase: previous ? { sourceSha: previous.sourceSha, sourceStatus: previous.sourceStatus, sha256: arguments_[3] } : undefined, platform: process.platform, node: process.version, modelVerification: 'deterministic-driver; no provider API request', consumer, evidence }, null, 2)}\n`
  )

async function directorySize(directory) {
  let bytes = 0
  for (const entry of await readdir(directory)) {
    const file = path.join(directory, entry)
    const details = await lstat(file)
    if (details.isDirectory()) bytes += await directorySize(file)
    else if (details.isFile()) bytes += details.size
  }
  return bytes
}

for (const [distribution, configuration] of Object.entries(platformDistributions)) {
  if (resume && distribution === 'velaros') {
    const verified = evidence.findLast(
      (record) => record.distribution === 'velaros' && record.stage === 'complete'
    )
    if (!verified || !verified.strictDeclarations || verified.sha256 !== arguments_[3])
      throw new Error(
        'Resume requires the separately supplied hash of a completed base verification'
      )
    const expectedPath = path.join(destination, 'velaros.tgz')
    if (verified.archive !== expectedPath || !(await lstat(expectedPath)).isFile())
      throw new Error('Verified base archive identity is outside this verification directory')
    const hash = createHash('sha256')
      .update(await readFile(expectedPath))
      .digest('hex')
    if (hash !== arguments_[3])
      throw new Error('Verified base archive bytes changed after the completed verification')
    const packed = JSON.parse(
      (
        await runGuardedCommand({
          command: 'tar',
          args: ['-xOf', expectedPath, 'package/package.json'],
          cwd: destination,
          operation: 'Confirm the resumed base archive identity',
        })
      ).stdout
    )
    if (packed.name !== configuration.name || packed.version !== sourceManifest.version)
      throw new Error(
        'Verified base archive package identity does not match the current source version'
      )
    dependencies[configuration.name] = `file:${expectedPath.split(path.sep).join('/')}`
    console.log(`Reused completed base verification: ${hash}`)
    continue
  }
  let archive
  let record
  if (resume && distribution === 'capabilities' && arguments_.length === 8) {
    archive = await realpath(arguments_[5])
    if (path.dirname(archive) !== destination || !(await lstat(archive)).isFile())
      throw new Error(
        'Reused capability archive must be a regular file in this verification directory'
      )
    const hash = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex')
    record = evidence.findLast(
      (entry) =>
        entry.distribution === distribution &&
        entry.archive === archive &&
        entry.sha256 === arguments_[7]
    )
    if (!record || hash !== arguments_[7])
      throw new Error(
        'Reused capability archive does not match the separately supplied hash and receipt'
      )
    const packed = JSON.parse(
      (
        await runGuardedCommand({
          command: 'tar',
          args: ['-xOf', archive, 'package/package.json'],
          cwd: destination,
          operation: 'Confirm the reused capability archive identity',
        })
      ).stdout
    )
    if (
      packed.name !== configuration.name ||
      packed.version !== sourceManifest.version ||
      packed.dependencies?.['@velaros-ai/velaros'] ||
      packed.peerDependencies?.['@velaros-ai/velaros'] !== sourceManifest.version ||
      packed.peerDependenciesMeta?.['@velaros-ai/velaros']?.optional
    )
      throw new Error(
        'Reused capability archive must require the exact base version as a nonoptional peer'
      )
    console.log(`Reused capability archive: ${hash}`)
  } else {
    archive = path.join(destination, `${distribution}${resume ? `-${Date.now()}` : ''}.tgz`)
    await safePackPackage({
      packageDirectory: source,
      filename: archive,
      distribution,
      timeoutMs: 300_000,
    })
    const bytes = await readFile(archive)
    record = {
      distribution,
      archive,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      compressedBytes: bytes.length,
      stage: 'packed',
    }
    evidence.push(record)
  }
  await saveReceipt()
  dependencies[configuration.name] = `file:${archive.split(path.sep).join('/')}`
  const overrides = { '@velaros-ai/velaros': dependencies['@velaros-ai/velaros'] }
  await writeFile(
    path.join(consumer, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module', dependencies, overrides }, null, 2)}\n`
  )
  await runGuardedCommand({
    command: 'bun',
    args: ['install', '--ignore-scripts'],
    cwd: consumer,
    timeoutMs: 180_000,
    operation: `Install real ${distribution} archive`,
  })
  const installed = path.join(consumer, 'node_modules', configuration.name)
  const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'))
  assert.equal(manifest.version, sourceManifest.version)
  assert.equal(manifest.name, configuration.name)
  Object.assign(record, {
    stage: 'installed',
    installedPackageBytes: await directorySize(installed),
    installedClosureBytes: await directorySize(path.join(consumer, 'node_modules')),
    dependencies: manifest.dependencies,
    peerDependencies: manifest.peerDependencies,
    installationSourceOverrides: overrides,
  })
  await saveReceipt()
  assert(!manifest.optionalDependencies || Object.keys(manifest.optionalDependencies).length === 0)
  const installedFirstParty = (
    await readdir(path.join(consumer, 'node_modules/@velaros-ai'))
  ).sort()
  assert.deepEqual(
    installedFirstParty,
    distribution === 'velaros' ? ['velaros'] : ['capabilities', 'velaros']
  )
  if (distribution === 'velaros') {
    for (const name of [
      '@napi-rs/canvas',
      'docx',
      'exceljs',
      'pdfjs-dist',
      '@playwright/test',
      '@ast-grep/napi',
      'ts-morph',
      'electron',
      'react',
    ]) {
      await assert.rejects(
        lstat(path.join(consumer, 'node_modules', name)),
        { code: 'ENOENT' },
        name
      )
    }
    for (const unit of platformDistributions.capabilities.units)
      await assert.rejects(lstat(path.join(installed, 'dist', unit)), { code: 'ENOENT' }, unit)
    for (const resource of platformDistributions.capabilities.resources)
      await assert.rejects(lstat(path.join(installed, resource)), { code: 'ENOENT' }, resource)
    assert(
      !Object.keys(manifest.exports).some(
        (entry) => entry === './project' || entry.startsWith('./skill-jsts')
      )
    )
  } else {
    assert.equal(manifest.dependencies['@velaros-ai/velaros'], undefined)
    assert.equal(manifest.peerDependencies['@velaros-ai/velaros'], sourceManifest.version)
    assert.notEqual(manifest.peerDependenciesMeta?.['@velaros-ai/velaros']?.optional, true)
    for (const module of ['core', 'kernel', 'model', 'agent', 'context', 'script'])
      await assert.rejects(
        lstat(path.join(installed, 'modules', module)),
        { code: 'ENOENT' },
        module
      )
  }
  const runtimeFile =
    distribution === 'velaros' ? 'foundation-runtime.mjs' : 'capability-runtime.mjs'
  await copyFile(
    path.join(import.meta.dirname, 'fixtures/host-contract-consumer', runtimeFile),
    path.join(consumer, runtimeFile)
  )
  const runtime = await runGuardedCommand({
    command: process.execPath,
    args: [runtimeFile],
    cwd: consumer,
    timeoutMs: 90_000,
    operation: `Independent ${distribution} JavaScript consumer`,
  })
  console.log(runtime.stdout)
  Object.assign(record, { stage: 'javascript-validated', runtime: runtime.stdout })
  await saveReceipt()
  const types =
    distribution === 'velaros'
      ? Object.entries(manifest.exports)
          .filter(([entry, target]) => !entry.includes('*') && target?.types)
          .map(
            ([entry], index) =>
              `import * as entry${index} from '${configuration.name}${entry === '.' ? '' : entry.slice(1)}'; export type Entry${index}=typeof entry${index};`
          )
          .join('\n')
      : "import {createProjectKernel,createProjectCapabilityModule,type ProjectSpacePort} from '@velaros-ai/capabilities/project';import {createNodeRuntime,type NodeRuntimeOptions} from '@velaros-ai/velaros/node';export type Consumer={project:ProjectSpacePort;options:NodeRuntimeOptions};void [createProjectKernel,createProjectCapabilityModule,createNodeRuntime];"
  const typeFile = `${distribution}.mts`
  await writeFile(path.join(consumer, typeFile), types)
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
      typeFile,
    ],
    cwd: consumer,
    timeoutMs: 90_000,
    operation: `Independent strict ${distribution} declaration consumer`,
  })
  Object.assign(record, { stage: 'complete', strictDeclarations: true })
  await saveReceipt()
}
console.log(`PASS independent Platform distributions: ${destination}`)
