import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const rootManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const publicPackages = readdirSync(resolve(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) =>
    JSON.parse(readFileSync(resolve(root, 'packages', entry.name, 'package.json'), 'utf8')),
  )
  .filter((manifest) => manifest.private !== true)

for (const manifest of publicPackages) {
  if (manifest.version !== rootManifest.version) {
    throw new Error(
      `${manifest.name} version ${manifest.version} does not match release version ${rootManifest.version}`,
    )
  }
}

const expectedTag = `v${rootManifest.version}`
const eventName = process.env.GITHUB_EVENT_NAME
const ref = process.env.GITHUB_REF
const refType = process.env.GITHUB_REF_TYPE
const refName = process.env.GITHUB_REF_NAME
const sourceCommit = process.env.GITHUB_SHA

if (!sourceCommit || !/^[a-f0-9]{40}$/u.test(sourceCommit)) {
  throw new Error('GITHUB_SHA must identify the exact 40-character source commit')
}

if (
  !['push', 'workflow_dispatch'].includes(eventName)
  || refType !== 'tag'
  || ref !== `refs/tags/${expectedTag}`
  || refName !== expectedTag
) {
  throw new Error(
    `Package releases require exact tag ${expectedTag}; received ${eventName ?? 'unknown'} ${ref ?? 'unknown'}`,
  )
}

console.info(`✓ release source: ${sourceCommit}`)
console.info(`✓ release ref: ${ref}`)
