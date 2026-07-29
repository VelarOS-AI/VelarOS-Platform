#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../../..')
const rootManifest = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
)
const eventName = process.env.GITHUB_EVENT_NAME
const ref = process.env.GITHUB_REF
const refType = process.env.GITHUB_REF_TYPE
const refName = process.env.GITHUB_REF_NAME
const sourceSha = process.env.GITHUB_SHA
const expectedTag = `v${rootManifest.version}`

if (!sourceSha || !/^[a-f0-9]{40}$/u.test(sourceSha)) {
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

console.info(`✓ release source: ${sourceSha}`)
console.info(`✓ release ref: ${ref}`)
