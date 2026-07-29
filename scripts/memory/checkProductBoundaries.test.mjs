import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
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
    dependencies: {
      '@velaros-ai/knowledge': '^0.2.0',
    },
    source: "import type { Knowledge } from '@velaros-ai/knowledge/types'",
  })
  writePackage(repoRoot, 'knowledge', {
    source: "const memory = import('@velaros-ai/memory')",
  })
  writePackage(repoRoot, 'memory-adapter-kernel', {
    source: `
      import electron from 'electron'
      import type { ChatSendRequest } from '@velaros-ai/core/types'
    `,
  })

  const violations = collectProductBoundaryViolations(repoRoot)
  assert.equal(violations.length, 5)
  assert.ok(violations.some((item) => item.includes('dependencies 中的 @velaros-ai/knowledge')))
  assert.ok(violations.some((item) => item.includes('import @velaros-ai/knowledge/types')))
  assert.ok(violations.some((item) => item.includes('import @velaros-ai/memory')))
  assert.ok(violations.some((item) => item.includes('import electron')))
  assert.ok(violations.some((item) => item.includes('import @velaros-ai/core/types')))
})

test('rejects Kernel-owned model, memory, and workspace concrete APIs', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-boundary-'))
  writePackage(repoRoot, 'memory', {
    source: "import { resolveActiveMemoryScope } from '@velaros-ai/core/memory/memoryScope'",
  })
  writePackage(repoRoot, 'knowledge', {
    source: `
      import { MemoryIndexStatuses } from '@velaros-ai/core/constants/storage'
      import { resolveDefaultEmbeddingModelForProvider } from '@velaros-ai/core/utils/EmbeddingModelSelection'
    `,
  })
  writePackage(repoRoot, 'memory-adapter-kernel', {
    source: "import { WorkspaceSpaceKind } from '@velaros-ai/core/constants/workspaceSpaces'",
  })

  const violations = collectProductBoundaryViolations(repoRoot)
  assert.equal(violations.length, 4)
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
  writePackage(repoRoot, 'memory-adapter-kernel', {
    source: "import { z } from 'zod'",
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
  writePackage(repoRoot, 'memory-adapter-kernel')

  const violations = collectProductBoundaryViolations(repoRoot)
  assert.equal(violations.length, 1)
  assert.match(violations[0], /宿主工具 workspace_add_root/)
})

test('allows the intended Memory to Kernel adapter dependency direction', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-boundary-'))
  writePackage(repoRoot, 'memory', {
    source: "import { z } from 'zod'",
  })
  writePackage(repoRoot, 'knowledge', {
    source: "import { z } from 'zod'",
  })
  writePackage(repoRoot, 'memory-adapter-kernel', {
    dependencies: {
      '@velaros-ai/memory': 'workspace:*',
    },
    source: "import type { MemoryDomain } from '@velaros-ai/memory'",
  })

  assert.deepEqual(collectProductBoundaryViolations(repoRoot), [])
})

function writePackage(
  repoRoot,
  directory,
  {
    dependencies = {},
    source = '',
  } = {},
) {
  const packageRoot = join(repoRoot, 'packages', directory)
  mkdirSync(join(packageRoot, 'src'), { recursive: true })
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: `@velaros-ai/${directory}`,
      version: '0.0.0',
      dependencies,
    }),
  )
  writeFileSync(join(packageRoot, 'src', 'index.ts'), source)
}
