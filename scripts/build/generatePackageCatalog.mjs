#!/usr/bin/env node
// 从发布拓扑单源生成公开包目录。输出不含时间戳或本机路径，因而可逐字检查是否过期。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { collectReleasePackages } from '../release/releaseTopology.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = resolve(SCRIPT_DIR, '../..')
const OUTPUT_PATH = resolve(ROOT_DIR, 'docs/generated/package-catalog.json')
const CHECK_ONLY = process.argv.includes('--check')
const unexpectedArguments = process.argv.slice(2).filter((argument) => argument !== '--check')

if (unexpectedArguments.length > 0) {
  throw new Error(`Unknown arguments: ${unexpectedArguments.join(', ')}`)
}

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0

const { rootManifest, platformGeneration, ordered } = await collectReleasePackages(ROOT_DIR)
const domainByDirectory = new Map()
for (const [domain, directories] of Object.entries(rootManifest.velaros.domainPackages)) {
  for (const directory of directories) {
    const existing = domainByDirectory.get(directory)
    if (existing) {
      throw new Error(
        `packages/${directory} is registered in both ${existing} and ${domain}; each package has one owner domain`,
      )
    }
    domainByDirectory.set(directory, domain)
  }
}

const packages = ordered
  .map(({ directoryName, manifest }) => {
    const domain = domainByDirectory.get(directoryName)
    if (!domain) throw new Error(`packages/${directoryName} has no owner domain`)
    const expectedRepositoryDirectory = `packages/${directoryName}`
    if (manifest.repository?.directory !== expectedRepositoryDirectory) {
      throw new Error(
        `${manifest.name} repository.directory must be ${expectedRepositoryDirectory}`,
      )
    }
    if (typeof manifest.description !== 'string' || manifest.description.trim().length === 0) {
      throw new Error(`${manifest.name} must have a public description`)
    }
    if (!manifest.exports || typeof manifest.exports !== 'object' || Array.isArray(manifest.exports)) {
      throw new Error(`${manifest.name} must declare a public exports map`)
    }

    return {
      domain,
      directory: expectedRepositoryDirectory,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      exportSubpaths: Object.keys(manifest.exports).sort(compareText),
      repositoryDirectory: manifest.repository.directory,
    }
  })
  .sort((left, right) =>
    compareText(left.domain, right.domain) || compareText(left.name, right.name))

const output = `${JSON.stringify({
  schemaVersion: 1,
  platformGeneration,
  packages,
}, null, 2)}\n`
const outputDisplayPath = relative(ROOT_DIR, OUTPUT_PATH)

if (CHECK_ONLY) {
  const current = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, 'utf8') : null
  if (current !== output) {
    throw new Error(
      `${outputDisplayPath} is missing or stale; run "bun run generate:package-catalog" and commit the result`,
    )
  }
  console.info(`[package-catalog] ${outputDisplayPath} is current (${packages.length} packages).`)
} else {
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  writeFileSync(OUTPUT_PATH, output, 'utf8')
  console.info(`[package-catalog] wrote ${outputDisplayPath} (${packages.length} packages).`)
}
