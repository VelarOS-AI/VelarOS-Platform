#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const packageDirectory = path.join(root, 'packages/model-runtime')
const dryRun = process.argv.includes('--dry-run')
const registry = 'https://npm.pkg.github.com'

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
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
  }
}
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))
const rootManifest = await readJson(path.join(root, 'package.json'))
const manifest = await readJson(path.join(packageDirectory, 'package.json'))
const lockSource = await readFile(path.join(root, 'bun.lock'), 'utf8')
const parsedLock = ts.parseConfigFileTextToJson(path.join(root, 'bun.lock'), lockSource)
if (parsedLock.error) {
  throw new Error(`Unable to parse bun.lock: TypeScript diagnostic ${parsedLock.error.code}`)
}

if (manifest.name !== '@velaros-ai/model-runtime') {
  throw new Error(`Refusing to publish unexpected package ${manifest.name}`)
}
if (rootManifest.version !== manifest.version) {
  throw new Error(
    `Root release version ${rootManifest.version} does not match ${manifest.name} ${manifest.version}`,
  )
}
if (manifest.publishConfig?.registry !== registry) {
  throw new Error(`${manifest.name} must publish to ${registry}`)
}
if (manifest.publishConfig?.access !== 'restricted') {
  throw new Error(`${manifest.name} must remain restricted`)
}

const lockedWorkspace = parsedLock.config.workspaces?.['packages/model-runtime']
if (!lockedWorkspace) {
  throw new Error(`${manifest.name} is missing from bun.lock; run bun install before publishing`)
}
if (lockedWorkspace.version !== manifest.version) {
  throw new Error(
    `${manifest.name} manifest version ${manifest.version} does not match bun.lock ${lockedWorkspace.version}`,
  )
}

const sourceSha = runForOutput('git', ['rev-parse', 'HEAD'], root)
if (!/^[a-f0-9]{40}$/u.test(sourceSha)) {
  throw new Error(`Expected a full source commit SHA, received: ${sourceSha}`)
}
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceSha) {
  throw new Error(
    `GITHUB_SHA ${process.env.GITHUB_SHA} does not match checked out source ${sourceSha}`,
  )
}
const expectedTag = `v${rootManifest.version}`
const releaseTag =
  process.env.GITHUB_REF_TYPE === 'tag'
  && process.env.GITHUB_REF_NAME === expectedTag
  && process.env.GITHUB_REF === `refs/tags/${expectedTag}`
    ? expectedTag
    : null
if (!dryRun && !process.env.GITHUB_SHA) {
  throw new Error('GITHUB_SHA must identify the exact source commit for publishing')
}
if (!dryRun && !releaseTag) {
  throw new Error(`Publishing requires the exact release tag refs/tags/${expectedTag}`)
}
if (runForOutput('git', ['status', '--porcelain', '--untracked-files=all'], root)) {
  throw new Error('Release artifacts require a clean working tree')
}
if (!dryRun && !process.env.NODE_AUTH_TOKEN) {
  throw new Error('NODE_AUTH_TOKEN is required to publish packages')
}

run('bun', ['run', 'build'], root)

const packDirectory = await mkdtemp(path.join(tmpdir(), 'velaros-model-pack-'))
try {
  run(
    'bun',
    ['pm', 'pack', '--destination', packDirectory, '--ignore-scripts'],
    packageDirectory,
  )
  const tarballs = (await readdir(packDirectory)).filter((file) => file.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`${manifest.name} produced ${tarballs.length} package tarballs`)
  }

  const tarballPath = path.join(packDirectory, tarballs[0])
  const bytes = await readFile(tarballPath)
  const artifact = {
    name: manifest.name,
    version: manifest.version,
    sourceSha,
    releaseTag,
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
