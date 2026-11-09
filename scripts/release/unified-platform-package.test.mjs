// 整体发布的入口、声明和动态加载重定位回归。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import {
  moduleReferences,
  isModelSourceAsset,
  relocatePlatformText,
  relocateRelativeReferences,
  resolvePeerContract,
  declarationPeerNames,
} from './unified-platform-package.mjs'
import {
  distributionExports,
  distributionForVelarosPath,
  capabilityDistributionItem,
} from './platform-distributions.mjs'

const semver = createRequire(new URL('../../packages/velaros/package.json', import.meta.url))(
  'semver'
)

test('declaration peers follow referenced runtime packages without adding UI peers to Node', () => {
  const manifest = {
    peerDependencies: { '@types/react': '^19.0.0', '@types/babel__core': '^7.0.0' },
  }
  assert.deepEqual(declarationPeerNames(new Set(['react']), manifest), ['@types/react'])
  assert.deepEqual(declarationPeerNames(new Set(['@babel/core']), manifest), ['@types/babel__core'])
  assert.deepEqual(declarationPeerNames(new Set(['execa']), manifest), [])
  assert.deepEqual(
    declarationPeerNames(new Set(['react']), { devDependencies: { '@types/react': '^19.0.0' } }),
    []
  )
})

test('host peers preserve declared support instead of the development-machine version', () => {
  assert.deepEqual(resolvePeerContract([{ range: '^19.0.0', optional: true }], semver), {
    range: '^19.0.0',
    optional: true,
  })
  const intersection = resolvePeerContract(
    [
      { range: '^18 || ^19', optional: true },
      { range: '^19 || ^20', optional: false },
    ],
    semver
  )
  assert.equal(intersection.optional, false)
  assert.deepEqual(
    ['18.3.0', '19.2.0', '20.0.0'].map((version) => semver.satisfies(version, intersection.range)),
    [false, true, false]
  )
  const nested = resolvePeerContract([{ range: '>=41.0.0' }, { range: '^42.0.0' }], semver)
  assert.deepEqual(
    ['41.9.0', '42.11.16', '43.0.0'].map((version) => semver.satisfies(version, nested.range)),
    [false, true, false]
  )
  assert.throws(
    () => resolvePeerContract([{ range: '>=41 <42' }, { range: '>=42' }], semver),
    /Incompatible host peer ranges/
  )
  assert.throws(
    () => resolvePeerContract([{ range: '>=1.0.0-beta' }, { range: '*' }], semver),
    /Cannot preserve/
  )
})

test('rewrites static, dynamic, require and declaration references without prefix collisions', () => {
  for (const text of [
    "import x from '@velaros-ai/core/error'",
    "import('@velaros-ai/model')",
    "require.resolve('@velaros-ai/kernel')",
    'import("@velaros-ai/agent").Agent',
    "const code = `import('@velaros-ai/script')`",
    '"@velaros-ai/context/contracts"',
  ]) {
    const expected = text.replace('@velaros-ai/', '@velaros-ai/velaros/')
    assert.equal(relocatePlatformText(text), expected)
  }
  assert.equal(relocatePlatformText('@velaros-ai/core-extra'), '@velaros-ai/core-extra')
  assert.equal(relocatePlatformText('@velaros-ai/skill-jsts'), '@velaros-ai/skill-jsts')
  assert.equal(
    relocatePlatformText('@velaros-ai/skill-jsts/package.json'),
    '@velaros-ai/capabilities/skill-jsts/package.json'
  )
})

test('assigns public exports and resources to one install boundary', () => {
  const manifest = {
    name: '@velaros-ai/velaros',
    version: '0.9.0',
    exports: {
      '.': { types: './dist/act/runtime/index.d.ts', import: './dist/act/runtime/index.js' },
      './project': { types: './dist/project/index.d.ts', import: './dist/project/index.js' },
    },
  }
  assert.deepEqual(Object.keys(distributionExports(manifest, 'velaros')), ['.'])
  assert.deepEqual(Object.keys(distributionExports(manifest, 'capabilities')), ['./project'])
  assert.equal(distributionForVelarosPath('dist/execution/index.js'), 'velaros')
  assert.throws(() => distributionForVelarosPath('dist/unregistered/index.js'), /Unregistered/)
  const extension = capabilityDistributionItem({
    directoryName: 'velaros',
    directory: '/source',
    manifest,
  })
  assert.deepEqual(extension.manifest.dependencies, {})
  assert.deepEqual(extension.manifest.peerDependencies, { '@velaros-ai/velaros': '0.9.0' })
  assert.equal(extension.distribution, 'capabilities')
})

test('relocates optional capabilities without retaining base aliases', () => {
  assert.equal(
    relocatePlatformText("import {x} from '@velaros-ai/velaros/project'"),
    "import {x} from '@velaros-ai/capabilities/project'"
  )
  assert.equal(
    relocatePlatformText('@velaros-ai/velaros/project-extra'),
    '@velaros-ai/velaros/project-extra'
  )
})

test('reads imports from syntax trees, including multiline declarations and import types', () => {
  const text =
    "export type {\n X\n} from './types.js';type T = import('./other.js').X; const x=import('./lazy.js'); require.resolve('third-party');"
  assert.deepEqual(
    moduleReferences(text, 'index.d.ts').map((reference) => reference.value),
    ['./types.js', './other.js', './lazy.js', 'third-party']
  )
})

test('only registered model source assets use virtual model imports', () => {
  assert.equal(isModelSourceAsset('dist/act/system/environment-template.js'), true)
  assert.equal(isModelSourceAsset('dist/act/system/template.js'), true)
  assert.equal(isModelSourceAsset('dist/act/system/impl/environment-template.js'), false)
  assert.equal(isModelSourceAsset('dist/unknown/template.js'), false)
})

test('cross-distribution references require a public base entry', () => {
  const exports = new Map([['dist/execution/index.js', './execution']])
  const before = "import type { Host } from '../../execution/index.js'"
  assert.equal(
    relocateRelativeReferences(before, 'dist/skills/impl/Installer.d.ts', exports, 'capabilities'),
    "import type { Host } from '@velaros-ai/velaros/execution'"
  )
  assert.throws(
    () =>
      relocateRelativeReferences(
        "import '../../project/index.js'",
        'dist/act/runtime/index.js',
        exports,
        'velaros'
      ),
    /optional capability/
  )
  assert.throws(
    () =>
      relocateRelativeReferences(
        "import '../../execution/impl/private.js'",
        'dist/skills/impl/Installer.js',
        exports,
        'capabilities'
      ),
    /no public entry/
  )
  assert.equal(
    relocateRelativeReferences(
      "import type {Optional} from '../../internal/utility-types.js'",
      'dist/skills/types/Skill.d.ts',
      exports,
      'capabilities'
    ),
    "import type {Optional} from '../../internal/utility-types.js'"
  )
  assert.throws(
    () =>
      relocateRelativeReferences(
        "import '../../internal/utility-types.js'",
        'dist/skills/impl/Installer.js',
        exports,
        'capabilities'
      ),
    /cannot be loaded as JavaScript/
  )
})
