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

if (eventName !== 'push' && eventName !== 'workflow_dispatch') {
  throw new Error(`Unsupported release event/ref: ${eventName ?? 'unknown'} ${ref ?? 'unknown'}`)
}
if (
  refType !== 'tag'
  || refName !== expectedTag
  || ref !== `refs/tags/${expectedTag}`
) {
  throw new Error(
    `Release ref must be the exact version tag refs/tags/${expectedTag}; received ${ref ?? 'unknown'}`,
  )
}

console.info(`release source: ${sourceSha}`)
console.info(`release ref: ${ref}`)
