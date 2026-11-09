// 只验新增的持久会话控制缝隙；已冻结的进程、模型和领域执行证据不重复运行。
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

import { platformDistributions } from './platform-distributions.mjs'
import { runGuardedCommand, safePackPackage } from './safe-package-pack.mjs'
import { normalizeTarEntryPaths } from './tar-entry-paths.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const arguments_ = process.argv.slice(2)
const resume = arguments_.length === 8
if (
  ![4, 8].includes(arguments_.length) ||
  arguments_[0] !== '--previous-candidate' ||
  arguments_[2] !== '--previous-capabilities-sha256' ||
  !/^[a-f0-9]{64}$/u.test(arguments_[3]) ||
  (resume &&
    (arguments_[4] !== '--resume' ||
      arguments_[6] !== '--base-sha256' ||
      !/^[a-f0-9]{64}$/u.test(arguments_[7])))
)
  throw new Error(
    'Usage: check-session-control-consumer.mjs --previous-candidate <candidate.json> --previous-capabilities-sha256 <verified-hash> [--resume <verification-directory> --base-sha256 <verified-hash>]'
  )
delete process.env.NODE_OPTIONS
delete process.env.NODE_PATH
const previousCandidatePath = path.resolve(arguments_[1])
const previous = JSON.parse(await readFile(previousCandidatePath, 'utf8'))
assert.equal(previous.frozen, true, 'Inherited extension evidence requires a frozen candidate')
assert.equal(previous.validation?.extensionJs, true)
assert.equal(previous.validation?.strictDeclarations, true)
const previousExtension = previous.archives.find((archive) => archive.name === 'capabilities.tgz')
assert(previousExtension)
assert.equal(previousExtension.sha256, arguments_[3])
// 冻结目录可以整体搬到 Linux；不用旧元数据里的机器专属绝对路径。
const previousArchive = path.join(path.dirname(previousCandidatePath), previousExtension.name)
assert.equal(
  createHash('sha256')
    .update(await readFile(previousArchive))
    .digest('hex'),
  arguments_[3]
)

const destination = resume
  ? await realpath(arguments_[5])
  : await mkdtemp(path.join(tmpdir(), 'velaros-session-control-check-'))
if (resume) {
  const relative = path.relative(await realpath(tmpdir()), destination)
  assert(
    relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) &&
      path.basename(destination).startsWith('velaros-session-control-check-'),
    'Resume must stay in a dedicated session control verification directory'
  )
}
const consumer = path.join(destination, 'consumer')
if (!resume) await mkdir(consumer)
else assert.equal(await realpath(consumer), consumer, 'Resume consumer must not be a symbolic link')
console.log(`Session control verification directory: ${destination}`)
const source = path.join(root, 'packages/velaros')
const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
assert.notEqual(manifest.version, previous.version)
assert.equal(manifest.velaros.platform, previous.platformGeneration)
const sourceSha = (
  await runGuardedCommand({
    command: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd: root,
    operation: 'Read session control source identity',
  })
).stdout.trim()
const sourceStatus = (
  await runGuardedCommand({
    command: 'git',
    args: ['status', '--porcelain', '--untracked-files=all'],
    cwd: root,
    operation: 'Read session control working-tree state',
  })
).stdout.trim()
const receipt = resume
  ? JSON.parse(await readFile(path.join(destination, 'receipt.json'), 'utf8'))
  : {
      kind: 'session-control-consumer',
      sourceSha,
      sourceStatus,
      version: manifest.version,
      platform: process.platform,
      node: process.version,
      consumer,
      archives: [],
      validation: { javascript: false, strictDeclarations: false },
      inheritedExtension: {
        candidate: previousCandidatePath,
        version: previous.version,
        sourceCommit: previous.sourceCommit,
        archive: previousArchive,
        sha256: arguments_[3],
        priorJavaScript: true,
        priorStrictDeclarations: true,
        contentEquivalent: false,
      },
    }
if (resume) {
  assert.equal(receipt.kind, 'session-control-consumer')
  assert.equal(receipt.version, manifest.version)
  assert.equal(receipt.sourceSha, sourceSha)
  assert.equal(receipt.platform, process.platform)
  assert.equal(receipt.node, process.version)
  assert.equal(receipt.consumer, consumer)
  assert.equal(receipt.inheritedExtension.sha256, arguments_[3])
  assert.equal(
    receipt.validation.javascript,
    false,
    'This resume mode only repairs the pre-install metadata stage'
  )
  assert.equal(receipt.validation.strictDeclarations, false)
  const base = receipt.archives.find((archive) => archive.distribution === 'velaros')
  assert(base)
  assert.equal(base.path, path.join(destination, 'velaros.tgz'))
  assert.equal(base.sha256, arguments_[7])
  assert((await lstat(base.path)).isFile())
  assert.equal(
    createHash('sha256')
      .update(await readFile(base.path))
      .digest('hex'),
    arguments_[7],
    'Resumed base bytes must match the separately supplied identity'
  )
  const packed = JSON.parse(
    (
      await runGuardedCommand({
        command: 'tar',
        args: ['-xOf', base.path, 'package/package.json'],
        cwd: destination,
        operation: 'Confirm preserved session control base package identity',
      })
    ).stdout
  )
  assert.equal(packed.name, '@velaros-ai/velaros')
  assert.equal(packed.version, manifest.version)
  assert.equal(packed.velaros.platform, manifest.velaros.platform)
  receipt.resumedBase ??= {
    sourceSha: receipt.sourceSha,
    sourceStatus: receipt.sourceStatus,
    path: base.path,
    sha256: base.sha256,
  }
  receipt.sourceStatus = sourceStatus
}
const saveReceipt = () =>
  writeFile(path.join(destination, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
await saveReceipt()

for (const distribution of ['velaros', 'capabilities']) {
  if (resume && distribution === 'velaros') {
    console.log(`Reused preserved base archive: ${arguments_[7]}`)
    continue
  }
  const archive = path.join(destination, `${distribution}${resume ? `-${Date.now()}` : ''}.tgz`)
  await safePackPackage({
    packageDirectory: source,
    filename: archive,
    distribution,
    timeoutMs: 300_000,
  })
  const bytes = await readFile(archive)
  if (resume) {
    receipt.supersededArchives ??= []
    for (const prior of receipt.archives.filter((entry) => entry.distribution === distribution))
      receipt.supersededArchives.push({
        ...prior,
        reason: 'Replaced before installation to restore the declared React type-provider peer',
      })
    receipt.archives = receipt.archives.filter((entry) => entry.distribution !== distribution)
  }
  receipt.archives.push({
    distribution,
    name: platformDistributions[distribution].name,
    path: archive,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  })
  await saveReceipt()
}

async function extract(archive, directory) {
  const entries = normalizeTarEntryPaths(
    (
      await runGuardedCommand({
        command: 'tar',
        args: ['-tzf', archive],
        cwd: destination,
        operation: 'Check extension archive entry boundaries',
      })
    ).stdout
  )
  assert(
    entries.every((entry) => entry.startsWith('package/') && !entry.split('/').includes('..')),
    'Extension entries must stay inside package/'
  )
  await mkdir(directory)
  await runGuardedCommand({
    command: 'tar',
    args: ['-xzf', archive, '-C', directory],
    cwd: destination,
    operation: 'Extract extension bytes for exact content comparison',
  })
}

async function files(directory, prefix = '') {
  const result = new Map()
  for (const entry of await readdir(directory)) {
    const file = path.join(directory, entry)
    const relative = prefix ? `${prefix}/${entry}` : entry
    const details = await lstat(file)
    assert(!details.isSymbolicLink(), `Extension comparison does not follow links: ${relative}`)
    if (details.isDirectory()) {
      for (const pair of await files(file, relative)) result.set(...pair)
    } else {
      assert(details.isFile(), `Unexpected archive member: ${relative}`)
      result.set(
        relative,
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex')
      )
    }
  }
  return result
}

const comparisonDirectory = await mkdtemp(path.join(destination, 'extension-comparison-'))
const beforeDirectory = path.join(comparisonDirectory, 'previous')
const afterDirectory = path.join(comparisonDirectory, 'current')
const extensionArchive = receipt.archives.find((archive) => archive.distribution === 'capabilities')
await extract(previousArchive, beforeDirectory)
await extract(extensionArchive.path, afterDirectory)
const beforeFiles = await files(beforeDirectory)
const afterFiles = await files(afterDirectory)
assert.deepEqual([...afterFiles.keys()].sort(), [...beforeFiles.keys()].sort())
for (const [file, hash] of beforeFiles) {
  if (file === 'package/package.json' || file === 'package/README.md') continue
  assert.equal(
    afterFiles.get(file),
    hash,
    `Extension content changed outside the version metadata: ${file}`
  )
}
const oldPackage = JSON.parse(
  await readFile(path.join(beforeDirectory, 'package/package.json'), 'utf8')
)
const newPackage = JSON.parse(
  await readFile(path.join(afterDirectory, 'package/package.json'), 'utf8')
)
assert.equal(newPackage.name, '@velaros-ai/capabilities')
assert.equal(newPackage.version, manifest.version)
const hostPeers = Object.fromEntries(
  Object.entries(manifest.peerDependencies).filter(([name]) => !name.startsWith('@velaros-ai/'))
)
const hostPeerMetadata = Object.fromEntries(
  Object.keys(hostPeers)
    .filter((name) => manifest.peerDependenciesMeta?.[name]?.optional === true)
    .map((name) => [name, { optional: true }])
)
assert.deepEqual(
  newPackage.peerDependencies,
  { ...hostPeers, '@velaros-ai/velaros': manifest.version },
  'Host peers must retain the source support ranges'
)
assert.deepEqual(
  newPackage.peerDependenciesMeta ?? {},
  hostPeerMetadata,
  'Only the source-declared optional host peers may remain optional'
)
assert.notEqual(newPackage.peerDependenciesMeta?.['@velaros-ai/velaros']?.optional, true)
newPackage.version = oldPackage.version
newPackage.peerDependencies = structuredClone(oldPackage.peerDependencies)
if (oldPackage.peerDependenciesMeta)
  newPackage.peerDependenciesMeta = structuredClone(oldPackage.peerDependenciesMeta)
else delete newPackage.peerDependenciesMeta
assert.deepEqual(
  newPackage,
  oldPackage,
  'Only the extension version and declared peer contracts may change'
)
const oldReadme = await readFile(path.join(beforeDirectory, 'package/README.md'), 'utf8')
const newReadme = await readFile(path.join(afterDirectory, 'package/README.md'), 'utf8')
assert.equal(
  newReadme.replaceAll(
    `@velaros-ai/velaros@${manifest.version}`,
    `@velaros-ai/velaros@${previous.version}`
  ),
  oldReadme
)
Object.assign(receipt.inheritedExtension, {
  contentEquivalent: true,
  comparedFiles: beforeFiles.size,
  allowedDifferences: [
    'package/package.json version and exact base peer',
    'package/package.json host peers restored to source support ranges and optional ownership',
    'package/README.md base version',
  ],
  hostPeers,
  hostPeerMetadata,
})
await saveReceipt()

const baseArchive = receipt.archives.find((archive) => archive.distribution === 'velaros')
const baseSpecifier = `file:${baseArchive.path.split(path.sep).join('/')}`
await writeFile(
  path.join(consumer, 'package.json'),
  `${JSON.stringify({ private: true, type: 'module', dependencies: { '@velaros-ai/velaros': baseSpecifier, '@types/node': rootManifest.devDependencies['@types/node'] }, overrides: { '@velaros-ai/velaros': baseSpecifier } }, null, 2)}\n`
)
await runGuardedCommand({
  command: 'bun',
  args: ['install', '--ignore-scripts'],
  cwd: consumer,
  timeoutMs: 180_000,
  operation: 'Install new base archive for the storage-only control consumer',
})
assert.deepEqual((await readdir(path.join(consumer, 'node_modules/@velaros-ai'))).sort(), [
  'velaros',
])
const fixtures = path.join(import.meta.dirname, 'fixtures/host-contract-consumer')
for (const file of ['session-control-consumer.mjs', 'session-control-consumer.mts'])
  await copyFile(path.join(fixtures, file), path.join(consumer, file))
const javascript = await runGuardedCommand({
  command: process.execPath,
  args: ['session-control-consumer.mjs'],
  cwd: consumer,
  timeoutMs: 60_000,
  operation: 'Independent installed JavaScript session control consumer',
})
console.log(javascript.stdout)
Object.assign(receipt.validation, { javascript: true, javascriptOutput: javascript.stdout })
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
    'session-control-consumer.mts',
  ],
  cwd: consumer,
  timeoutMs: 60_000,
  operation: 'Independent strict session control declaration consumer',
})
receipt.validation.strictDeclarations = true
await saveReceipt()
console.log(
  `PASS session control consumer; inherited unchanged extension execution evidence: ${destination}`
)
