import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dryRun = process.argv.includes('--dry-run')
const registry = 'https://npm.pkg.github.com'

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))
const runForOutput = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}: ${result.stderr.trim()}`,
    )
  }
  return result.stdout.trim()
}
const readJsonc = async (file) => {
  const source = await readFile(file, 'utf8')
  const parsed = ts.parseConfigFileTextToJson(file, source)
  if (parsed.error) {
    throw new Error(`Unable to parse ${file}: TypeScript diagnostic ${parsed.error.code}`)
  }
  return parsed.config
}
const rootManifest = await readJson(path.join(root, 'package.json'))
const sourceSha = runForOutput('git', ['rev-parse', 'HEAD'], root)
if (!/^[a-f0-9]{40}$/u.test(sourceSha)) {
  throw new Error(`Expected a full source commit SHA, received: ${sourceSha}`)
}
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceSha) {
  throw new Error(
    `GITHUB_SHA ${process.env.GITHUB_SHA} does not match checked out source ${sourceSha}`,
  )
}
if (!dryRun && !process.env.GITHUB_SHA) {
  throw new Error('GITHUB_SHA must identify the exact source commit for publishing')
}
const workingTreeStatus = runForOutput(
  'git',
  ['status', '--porcelain', '--untracked-files=all'],
  root,
)
if (workingTreeStatus) {
  throw new Error('Release artifacts require a clean working tree')
}
const lockfile = await readJsonc(path.join(root, 'bun.lock'))
const packageDirectories = (
  await readdir(path.join(root, 'packages'), { withFileTypes: true })
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(root, 'packages', entry.name))

const packages = []
for (const directory of packageDirectories) {
  const manifest = await readJson(path.join(directory, 'package.json'))
  if (manifest.private === true) continue
  if (!manifest.name?.startsWith('@velaros-ai/')) {
    throw new Error(`Refusing to publish invalid package name: ${manifest.name ?? directory}`)
  }
  if (manifest.publishConfig?.registry !== registry) {
    throw new Error(`${manifest.name} must publish to ${registry}`)
  }
  packages.push({ directory, manifest })
}

const byName = new Map(packages.map((item) => [item.manifest.name, item]))

for (const item of packages) {
  const workspacePath = path
    .relative(root, item.directory)
    .split(path.sep)
    .join('/')
  const lockedWorkspace = lockfile.workspaces?.[workspacePath]
  if (!lockedWorkspace) {
    throw new Error(
      `${item.manifest.name} is missing from bun.lock workspaces; run bun install before publishing`,
    )
  }
  if (lockedWorkspace.version !== item.manifest.version) {
    throw new Error(
      `${item.manifest.name} manifest version ${item.manifest.version} does not match bun.lock workspace version ${lockedWorkspace.version}; run bun install before publishing`,
    )
  }
}

const ordered = []
const visiting = new Set()
const visited = new Set()
const visit = (item) => {
  if (visited.has(item.manifest.name)) return
  if (visiting.has(item.manifest.name)) {
    throw new Error(`Package dependency cycle at ${item.manifest.name}`)
  }
  visiting.add(item.manifest.name)
  const dependencies = {
    ...item.manifest.dependencies,
    ...item.manifest.optionalDependencies,
    ...item.manifest.peerDependencies,
  }
  for (const name of Object.keys(dependencies)) {
    const dependency = byName.get(name)
    if (dependency) visit(dependency)
  }
  visiting.delete(item.manifest.name)
  visited.add(item.manifest.name)
  ordered.push(item)
}
for (const item of packages) visit(item)

if (!dryRun && !process.env.NODE_AUTH_TOKEN) {
  throw new Error('NODE_AUTH_TOKEN is required to publish packages')
}

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
  }
}

const buildScript = rootManifest.scripts?.['build:package'] ? 'build:package' : 'build'
run('bun', ['run', buildScript], root)

for (const item of ordered) {
  const packDirectory = await mkdtemp(path.join(tmpdir(), 'velaros-kernel-pack-'))
  try {
    run(
      'bun',
      ['pm', 'pack', '--destination', packDirectory, '--ignore-scripts'],
      item.directory,
    )
    const tarballs = (await readdir(packDirectory)).filter((file) => file.endsWith('.tgz'))
    if (tarballs.length !== 1) {
      throw new Error(`${item.manifest.name} produced ${tarballs.length} package tarballs`)
    }

    const tarballPath = path.join(packDirectory, tarballs[0])
    const bytes = await readFile(tarballPath)
    const artifact = {
      name: item.manifest.name,
      version: item.manifest.version,
      sourceSha,
      tag: `v${rootManifest.version}`,
      fileName: tarballs[0],
      sizeBytes: (await stat(tarballPath)).size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    console.info(`release artifact: ${JSON.stringify(artifact)}`)

    const args = [
      'publish',
      tarballPath,
      '--registry',
      registry,
      '--access',
      'restricted',
      '--tolerate-republish',
      '--ignore-scripts',
    ]
    if (dryRun) args.push('--dry-run')
    run('bun', args, root)
  } finally {
    await rm(packDirectory, { recursive: true, force: true })
  }
}
