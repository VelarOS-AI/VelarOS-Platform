#!/usr/bin/env node

import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { safePackPackage } from './safe-package-pack.mjs'

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

try {
  await safePackPackage({ destination, packageDirectory })
  const tarballs = (await readdir(destination)).filter((file) => file.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`${manifest.name ?? directoryName} produced ${tarballs.length} tarballs`)
  }
  const archive = await stat(path.join(destination, tarballs[0]))
  console.info(`✓ ${manifest.name}@${manifest.version} packed safely (${archive.size} bytes)`)
} finally {
  await rm(destination, { force: true, recursive: true })
}
