#!/usr/bin/env node

import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runGuardedCommand, safePackPackage } from './safe-package-pack.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '../..')
const selector = process.argv[2]

if (!selector || process.argv.length !== 3) {
  throw new Error('Usage: bun run check:package-pack -- <package-directory>')
}

const directoryName = selector
  .replace(/^@velaros-ai\//u, '')
  .replace(/^packages\//u, '')

if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(directoryName)) {
  throw new Error(`Invalid package directory selector: ${selector}`)
}

const packageDirectory = path.join(repositoryRoot, 'packages', directoryName)
const manifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'))
const destination = await mkdtemp(path.join(tmpdir(), 'velaros-package-pack-check-'))
const requiredPackageFiles = new Map([
  ['browser', [
    'package/THIRD_PARTY_NOTICES.md',
    'package/vendor/devtools-performance-engine/LICENSE.chrome-devtools-frontend',
    'package/vendor/devtools-performance-engine/LICENSE.chrome-devtools-mcp',
    'package/vendor/devtools-performance-engine/NOTICE.md',
  ]],
  ['office', [
    'package/THIRD_PARTY_NOTICES.md',
    'package/third-party-licenses/pptxgenjs-MIT.txt',
  ]],
  ['ui', [
    'package/THIRD_PARTY_NOTICES.md',
    'package/third-party-licenses/tailwindcss-MIT.txt',
  ]],
])

try {
  await safePackPackage({ destination, packageDirectory })
  const tarballs = (await readdir(destination)).filter((file) => file.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`${manifest.name ?? directoryName} produced ${tarballs.length} tarballs`)
  }
  const tarballPath = path.join(destination, tarballs[0])
  const { stdout } = await runGuardedCommand({
    args: ['-tzf', tarballPath],
    command: 'tar',
    cwd: repositoryRoot,
    operation: `List ${manifest.name ?? directoryName} package tarball`,
  })
  const entries = new Set(stdout.split('\n').filter(Boolean))
  for (const requiredFile of [
    'package/package.json',
    'package/README.md',
    'package/LICENSE',
    'package/NOTICE',
    ...(requiredPackageFiles.get(directoryName) ?? []),
  ]) {
    if (!entries.has(requiredFile)) {
      throw new Error(`${manifest.name ?? directoryName} tarball is missing ${requiredFile}`)
    }
  }

  const archive = await stat(tarballPath)
  console.info(`✓ ${manifest.name}@${manifest.version} packed safely (${archive.size} bytes)`)
} finally {
  await rm(destination, { force: true, recursive: true })
}
