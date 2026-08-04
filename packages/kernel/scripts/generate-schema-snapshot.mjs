#!/usr/bin/env bun
// 用途：把全部协议 wire zod schema 序列化成 JSON Schema 快照产物 dist/schema-snapshot.json。
// 直接读 src(经 bun),不依赖 dist 先构建——让 check:schemas 链无需先跑 tsc 即可再生快照,
// 且源码/dist 两侧序列化逐字节等价(已验证)。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import { KernelProtocolVersion } from '../src/contracts/protocol/handshake.ts'
import { KernelProtocolWireSchemas } from '../src/contracts/protocol/schema-snapshot.ts'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(scriptDir, '../dist')
const outPath = resolve(outDir, 'schema-snapshot.json')
mkdirSync(outDir, { recursive: true })

const schemas = {}
for (const name of Object.keys(KernelProtocolWireSchemas).sort()) {
  schemas[name] = z.toJSONSchema(KernelProtocolWireSchemas[name])
}

const snapshot = {
  package: '@velaros-ai/kernel',
  protocolVersion: KernelProtocolVersion,
  schemas,
}

writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`)
console.info(
  `generate-schema-snapshot: wrote ${Object.keys(schemas).length} schemas to ${outPath}.`
)
