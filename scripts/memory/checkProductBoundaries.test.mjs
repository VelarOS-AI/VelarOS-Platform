import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  collectProductBoundaryViolations,
  extractModuleSpecifiers,
} from './checkProductBoundaries.mjs'

test('extracts static, dynamic, export, and require module specifiers without scanning comments', () => {
  const source = `
    // import '@velaros-ai/velar/knowledge'
    import value from '@velaros-ai/core'
    export type { Item } from '@velaros-ai/velar/memory'
    const dynamic = import('@velaros-ai/velar/knowledge/contracts')
    const legacy = require('electron/main')
  `

  assert.deepEqual(
    extractModuleSpecifiers(source).sort(),
    [
      '@velaros-ai/core',
      '@velaros-ai/velar/knowledge/contracts',
      '@velaros-ai/velar/memory',
      'electron/main',
    ],
  )
})

test('checks the sibling unit\'s subpaths and host modules in unit sources', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-boundary-'))
  writeUnit(repoRoot, 'memory', {
    source: `
      import type { KnowledgeRecord } from '@velaros-ai/velar/knowledge/contracts'
      import electron from 'electron'
    `,
  })
  writeUnit(repoRoot, 'knowledge', {
    source: `
      const memory = import('@velaros-ai/velar/memory')
      import type { ChatSendRequest } from '@velaros-ai/agent/protocol'
    `,
  })

  const violations = collectProductBoundaryViolations(repoRoot)
  assert.equal(violations.length, 4)
  assert.ok(violations.some((item) => item.includes('import @velaros-ai/velar/knowledge/contracts')))
  assert.ok(violations.some((item) => item.includes('import @velaros-ai/velar/memory')))
  assert.ok(violations.some((item) => item.includes('import electron')))
  assert.ok(violations.some((item) => item.includes('import @velaros-ai/agent/protocol')))
})

test('rejects Kernel-owned model, memory, and workspace concrete APIs', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-boundary-'))
  writeUnit(repoRoot, 'memory', {
    source: "import { resolveActiveMemoryScope } from '@velaros-ai/core/memory/memoryScope'",
  })
  writeUnit(repoRoot, 'knowledge', {
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
  writeUnit(repoRoot, 'memory', {
    source: "import { z } from 'zod'",
  })
  writeUnit(repoRoot, 'knowledge', {
    source: `
      import { getRelativePathInsideRoot } from '@velaros-ai/core/utils/PathContainmentHelper'
      import { platformCompatibility } from '@velaros-ai/core/utils/PlatformCompatibilityHelper'
    `,
  })

  const violations = collectProductBoundaryViolations(repoRoot)
  assert.equal(violations.length, 2)
  assert.ok(violations.every((item) => item.includes('必须自持领域 DTO')))
})

test('rejects product-specific tool names in reusable unit sources', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-boundary-'))
  writeUnit(repoRoot, 'memory', {
    source: "const guidance = 'Call workspace_add_root first'",
  })
  writeUnit(repoRoot, 'knowledge')

  const violations = collectProductBoundaryViolations(repoRoot)
  assert.equal(violations.length, 1)
  assert.match(violations[0], /宿主工具 workspace_add_root/)
})

test('rejects relative imports that leave the unit directory', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-boundary-'))
  writeUnit(repoRoot, 'memory', {
    source: "import { KnowledgeDomain } from '../knowledge/impl/domain/KnowledgeDomain.js'",
  })
  writeUnit(repoRoot, 'knowledge')

  const violations = collectProductBoundaryViolations(repoRoot)
  assert.equal(violations.length, 1)
  assert.match(violations[0], /逃出 packages\/velar\/memory\//u)
})

test('rejects the sibling unit\'s code-surface module in a code template', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-boundary-'))
  writeUnit(repoRoot, 'memory', {
    extraFiles: { 'template.js': "import { search } from 'velar:knowledge'" },
  })
  writeUnit(repoRoot, 'knowledge')

  const violations = collectProductBoundaryViolations(repoRoot)
  assert.equal(violations.length, 1)
  assert.match(violations[0], /import velar:knowledge/u)
})

test('leaves the unit\'s spec and test companions alone: they read build output from outside the unit', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-boundary-'))
  writeUnit(repoRoot, 'knowledge', {
    extraFiles: { 'test/consumer.test.mjs': "import { createKnowledgeRuntime } from '../../dist/knowledge/index.js'" },
  })
  writeUnit(repoRoot, 'memory')

  assert.deepEqual(collectProductBoundaryViolations(repoRoot), [])
})

test('allows each unit to keep its own dependencies and relative imports', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'velaros-memory-boundary-'))
  writeUnit(repoRoot, 'memory', {
    dependencies: {
      '@velaros-ai/kernel': 'workspace:*',
    },
    source: `
      import { z } from 'zod'
      import { kernelModules } from '@velaros-ai/kernel'
      import { helper } from './helper'
    `,
    extraFiles: { 'helper.ts': 'export const helper = 1' },
  })
  writeUnit(repoRoot, 'knowledge', {
    source: "import { z } from 'zod'",
  })

  assert.deepEqual(collectProductBoundaryViolations(repoRoot), [])
})

/** 在临时仓里写一个 @velaros-ai/velar 的能力单元：包清单是两个单元共用的那一份，单元目录下写入口与额外文件。 */
function writeUnit(
  repoRoot,
  unit,
  {
    dependencies = {},
    source = '',
    extraFiles = {},
  } = {},
) {
  const packageRoot = join(repoRoot, 'packages', 'velar')
  const unitDirectory = join(packageRoot, unit)
  mkdirSync(unitDirectory, { recursive: true })
  const manifestPath = join(packageRoot, 'package.json')
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : {
        name: '@velaros-ai/velar',
        version: '0.0.0',
        dependencies: {},
      }
  manifest.dependencies = { ...manifest.dependencies, ...dependencies }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  writeFileSync(join(unitDirectory, 'index.ts'), source)
  for (const [name, content] of Object.entries(extraFiles)) {
    mkdirSync(dirname(join(unitDirectory, name)), { recursive: true })
    writeFileSync(join(unitDirectory, name), content)
  }
}
