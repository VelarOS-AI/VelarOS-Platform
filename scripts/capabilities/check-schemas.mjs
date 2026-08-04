#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createToolSchemaBundle } from '@velaros-ai/agent/tool-contract'

import { CapabilityOwners, capabilitySchemaEntry } from './capability-owners.mjs'

const RepoRoot = resolve(import.meta.dir, '../..')
let failed = false
const BrowserBaselinePath = resolve(
  RepoRoot,
  'baselines',
  'capabilities',
  'browser-input-schemas.json',
)
const BrowserBundlePath = resolve(
  RepoRoot,
  'packages',
  'browser',
  'dist',
  'tools',
  'schema-bundle.json',
)

function stableStringify(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
      )
    }
    return item
  })
}

function normalizeSources(collection, label) {
  const candidates = Array.isArray(collection)
    ? collection
    : Object.entries(collection ?? {}).map(([name, tool]) => ({ name, ...tool }))

  return candidates.map((tool, index) => {
    if (!tool?.schema) {
      throw new Error(`${label}[${index}] has no schema`)
    }
    return {
      name: tool.name ?? `${label}-${index}`,
      description: tool.description ?? '',
      schema: tool.schema,
    }
  })
}

function isObjectInputSchema(schema) {
  if (schema?.type === 'object') return true
  for (const alternatives of [schema?.anyOf, schema?.oneOf]) {
    if (Array.isArray(alternatives) && alternatives.length > 0)
      return alternatives.every(isObjectInputSchema)
  }
  return false
}

for (const owner of CapabilityOwners) {
  let ownerSchemaCount = 0
  for (const capability of owner.packages) {
    if (capability.schemaExports.length === 0) continue
    try {
      const modulePath = resolve(
        RepoRoot,
        'packages',
        capability.directory,
        capabilitySchemaEntry(capability),
      )
      const exports = await import(pathToFileURL(modulePath).href)
      for (const exportName of capability.schemaExports) {
        const collection = exports[exportName]
        if (!collection) throw new Error(`missing export ${exportName}`)
        const sources = normalizeSources(
          collection,
          `${capability.name}:${exportName}`,
        )
        const bundle = createToolSchemaBundle(sources)
        if (bundle.tools.length !== sources.length) {
          throw new Error(
            `${exportName} generated ${bundle.tools.length}/${sources.length} schemas`,
          )
        }
        for (const tool of bundle.tools) {
          if (!isObjectInputSchema(tool.inputSchema)) {
            throw new Error(`${exportName}:${tool.name} did not produce an object input schema`)
          }
        }
        ownerSchemaCount += bundle.tools.length
      }
    } catch (error) {
      console.error(`❌ ${owner.owner}/${capability.name}: ${error.message}`)
      failed = true
    }
  }
  console.info(`✓ ${owner.owner}: ${ownerSchemaCount} public tool schemas`)
}

if (!existsSync(BrowserBundlePath)) {
  console.error(
    `❌ @velaros-ai/browser/tools: missing dist schema bundle (${BrowserBundlePath})`,
  )
  failed = true
} else {
  const artifact = JSON.parse(readFileSync(BrowserBundlePath, 'utf8'))
  const browserCollection = artifact.collections?.find(
    (collection) => collection.label === 'browser-tools',
  )
  if (!browserCollection) {
    console.error('❌ @velaros-ai/browser/tools: schema bundle has no browser-tools collection')
    failed = true
  } else {
    const current = {
      __sharedDefs: createHash('sha256')
        .update(stableStringify(browserCollection.$defs))
        .digest('hex'),
    }
    for (const tool of browserCollection.tools) {
      const propertyCount = Object.keys(tool.inputSchema?.properties ?? {}).length
      if ((tool.declaredParameterCount ?? 0) > 0 && propertyCount === 0) {
        console.error(
          `❌ browser-tools/${tool.name}: declared parameters degraded to an empty schema`,
        )
        failed = true
      }
      current[tool.name] = createHash('sha256')
        .update(stableStringify(tool.inputSchema))
        .digest('hex')
    }

    if (process.env.SCHEMA_BASELINE_UPDATE === '1') {
      writeFileSync(BrowserBaselinePath, `${JSON.stringify(current, null, 2)}\n`)
      console.info(`✓ browser schema baseline updated: ${BrowserBaselinePath}`)
    } else if (!existsSync(BrowserBaselinePath)) {
      console.error(`❌ browser schema baseline is missing: ${BrowserBaselinePath}`)
      failed = true
    } else {
      const baseline = JSON.parse(readFileSync(BrowserBaselinePath, 'utf8'))
      const changed = Object.keys({ ...baseline, ...current }).filter(
        (key) => baseline[key] !== current[key],
      )
      if (changed.length > 0) {
        console.error(`❌ browser schema baseline drift: ${changed.join(', ')}`)
        failed = true
      } else {
        console.info(
          `✓ browser: ${browserCollection.tools.length} schemas match the checked-in baseline`,
        )
      }
    }
  }
}

process.exit(failed ? 1 : 0)
