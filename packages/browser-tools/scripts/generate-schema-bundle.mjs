#!/usr/bin/env bun
// 用途：把本包工具集合的 inputSchema 面序列化成 dist/schema-bundle.json 产物，
// 供 check:schemas 等下游以「dist 产物」而非「源码可达性」消费(拆仓后浏览器仓随包分发本产物,
// kernel 仓只读产物,不再 import 本包 src 深路径)。
//
// 铁律:产出内容与 createToolSchemaBundle(io:'input') 逐字节等价——只换取货渠道,不漂移锁面。
// declaredParameterCount 记录每个工具 zod shape 的字段数,让消费方无需 zod 源即可拦「零参数退化」。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createToolSchemaBundle } from '@velaros-ai/core/tool-contract'

import { browserTools } from '../src/Collection'

function buildCollectionArtifact(label, collection) {
  const sources = Object.entries(collection).map(([name, tool]) => ({
    name,
    description: '',
    schema: tool.schema,
  }))
  const bundle = createToolSchemaBundle(sources)
  return {
    label,
    $defs: bundle.$defs,
    tools: bundle.tools.map((tool) => ({
      name: tool.name,
      inputSchema: tool.inputSchema,
      declaredParameterCount: Object.keys(collection[tool.name]?.schema?.shape ?? {}).length,
    })),
  }
}

const artifact = {
  schemaVersion: 1,
  package: '@velaros-ai/browser-tools',
  generatedFrom: 'src/Collection',
  collections: [buildCollectionArtifact('browser-tools', browserTools)],
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(scriptDir, '../dist')
const outPath = resolve(outDir, 'schema-bundle.json')
mkdirSync(outDir, { recursive: true })
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`)

const total = artifact.collections.reduce((sum, collection) => sum + collection.tools.length, 0)
console.info(`generate-schema-bundle: wrote ${total} tool schemas to ${outPath}.`)
