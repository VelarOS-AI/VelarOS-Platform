import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  collectProductBoundaryViolations,
  extractModuleSpecifiers,
} from './checkProductBoundaries.mjs'

test('extracts static, dynamic, export, and require module specifiers without scanning comments', () => {
  const source = `
    // import '@velaros-ai/knowledge'
    import value from '@velaros-ai/core'
    export type { Item } from '@velaros-ai/memory'
    const dynamic = import('@velaros-ai/knowledge/query')
    const legacy = require('electron/main')
  `

  assert.deepEqual(
    extractModuleSpecifiers(source).sort(),
    [
      '@velaros-ai/core',
      '@velaros-ai/knowledge/query',
      '@velaros-ai/memory',
      'electron/main',
    ],
  )
})

test('checks actual @velaros-ai package scopes in source and package manifests', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-boundary-'))
  writePackage(repoRoot, 'memory', {
    source: `
      import type { Knowledge } from '@velaros-ai/knowledge/types'
      import electron from 'electron'
    `,
  })
  writePackage(repoRoot, 'knowledge', {
    source: `
      const memory = import('@velaros-ai/memory')
      import type { ChatSendRequest } from '@velaros-ai/agent/protocol'
    `,
  })

  const violations = collectProductBoundaryViolations(repoRoot)
  assert.equal(violations.length, 4)
  assert.ok(violations.some((item) => item.includes('import @velaros-ai/knowledge/types')))
  assert.ok(violations.some((item) => item.includes('import @velaros-ai/memory')))
  assert.ok(violations.some((item) => item.includes('import electron')))
  assert.ok(violations.some((item) => item.includes('import @velaros-ai/agent/protocol')))
})

test('rejects Kernel-owned model, memory, and workspace concrete APIs', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-boundary-'))
  writePackage(repoRoot, 'memory', {
    source: "import { resolveActiveMemoryScope } from '@velaros-ai/core/memory/memoryScope'",
  })
  writePackage(repoRoot, 'knowledge', {
    source: `
      import { MemoryIndexStatuses } from '@velaros-ai/agent/protocol'
      import { resolveDefaultEmbeddingModelForProvider } from '@velaros-ai/core/utils/EmbeddingModelSelection'
    `,
  })

  const violations = collectProductBoundaryViolations(repoRoot)
  assert.equal(violations.length, 3)
  assert.ok(violations.every((item) => item.includes('必须自持领域 DTO')))
})

test('rejects path and platform policies removed from Core 0.3', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-boundary-'))
  writePackage(repoRoot, 'memory', {
    source: "import { z } from 'zod'",
  })
  writePackage(repoRoot, 'knowledge', {
    source: `
      import { getRelativePathInsideRoot } from '@velaros-ai/core/utils/PathContainmentHelper'
      import { platformCompatibility } from '@velaros-ai/core/utils/PlatformCompatibilityHelper'
    `,
  })

  const violations = collectProductBoundaryViolations(repoRoot)
  assert.equal(violations.length, 2)
  assert.ok(violations.every((item) => item.includes('必须自持领域 DTO')))
})

test('rejects product-specific tool names in reusable package sources', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-boundary-'))
  writePackage(repoRoot, 'memory', {
    source: "const guidance = 'Call workspace_add_root first'",
  })
  writePackage(repoRoot, 'knowledge')

  const violations = collectProductBoundaryViolations(repoRoot)
  assert.equal(violations.length, 1)
  assert.match(violations[0], /宿主工具 workspace_add_root/)
})

test('rejects relative imports that leave the package source tree', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-boundary-'))
  writePackage(repoRoot, 'memory', {
    source: "import { KnowledgeDomain } from '../../knowledge/src/knowledge/domain/Service'",
  })
  writePackage(repoRoot, 'knowledge')

  const violations = collectProductBoundaryViolations(repoRoot)
  assert.equal(violations.length, 1)
  assert.match(violations[0], /逃出 packages\/memory\/src\//u)
})

test('allows each package to keep its own dependencies and relative imports', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-boundary-'))
  writePackage(repoRoot, 'memory', {
    dependencies: {
      '@velaros-ai/kernel': 'workspace:*',
    },
    source: `
      import { z } from 'zod'
      import { createCapabilityToken } from '@velaros-ai/kernel/contracts/abi'
      import { helper } from './helper'
    `,
    extraFiles: { 'helper.ts': 'export const helper = 1' },
  })
  writePackage(repoRoot, 'knowledge', {
    source: "import { z } from 'zod'",
  })

  assert.deepEqual(collectProductBoundaryViolations(repoRoot), [])
})

function writePackage(
  repoRoot,
  directory,
  {
    dependencies = {},
    source = '',
    extraFiles = {},
  } = {},
) {
  const packageRoot = join(repoRoot, 'packages', directory)
  const sourceDirectory = join(packageRoot, 'src')
  mkdirSync(sourceDirectory, { recursive: true })
  const manifestPath = join(packageRoot, 'package.json')
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : {
        name: `@velaros-ai/${directory}`,
        version: '0.0.0',
        dependencies: {},
      }
  manifest.dependencies = { ...manifest.dependencies, ...dependencies }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  writeFileSync(join(sourceDirectory, 'index.ts'), source)
  for (const [name, content] of Object.entries(extraFiles)) {
    writeFileSync(join(sourceDirectory, name), content)
  }
}
