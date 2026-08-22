#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'

const configPath = path.join(import.meta.dirname, 'platform-consumers.json')
const config = JSON.parse(await readFile(configPath, 'utf8'))

if (config.schemaVersion !== 1 || !Array.isArray(config.consumers)) {
  throw new Error('platform-consumers.json must declare schemaVersion 1 and a consumers array')
}

const ids = new Set()
for (const consumer of config.consumers) {
  if (!/^[a-z0-9-]+$/u.test(consumer.id ?? '')) {
    throw new Error(`Invalid consumer id: ${consumer.id ?? '(missing)'}`)
  }
  if (ids.has(consumer.id)) throw new Error(`Duplicate consumer id: ${consumer.id}`)
  ids.add(consumer.id)
  if (!/^VelarOS-AI\/[A-Za-z0-9._-]+$/u.test(consumer.repository ?? '')) {
    throw new Error(`Invalid consumer repository for ${consumer.id}`)
  }
  if (!['bun', 'none'].includes(consumer.lockfile)) {
    throw new Error(`Invalid lockfile policy for ${consumer.id}: ${consumer.lockfile}`)
  }
  if (typeof consumer.verifyCommand !== 'string') {
    throw new Error(`verifyCommand must be a string for ${consumer.id}`)
  }
}

console.info(JSON.stringify({ include: config.consumers }))
