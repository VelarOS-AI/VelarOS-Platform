import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { LockfileConsistencyValidator } from './lockfileConsistency.mjs'
import { GroupedPrivateLockRefresher } from './refreshPrivateLock.mjs'

test('accepts manifest-aligned workspaces and exact private resolutions', () => {
  const repositoryRoot = createFixture()
  const report = new LockfileConsistencyValidator({ repositoryRoot }).validate()

  assert.deepEqual(report, {
    externalResolutionCount: 2,
    workspaceCount: 1,
  })
  assert.deepEqual(
    new LockfileConsistencyValidator({
      repositoryRoot,
    }).listExternalVelarosDependencyNames(),
    ['@velaros-ai/core', '@velaros-ai/kernel-sdk'],
  )
  assert.deepEqual(
    new LockfileConsistencyValidator({
      repositoryRoot,
    }).listExternalVelarosDependencyGroups(),
    [
      {
        directory: '',
        manifestPath: 'package.json',
        packageNames: ['@velaros-ai/core', '@velaros-ai/kernel-sdk'],
      },
      {
        directory: 'packages/example',
        manifestPath: 'packages/example/package.json',
        packageNames: ['@velaros-ai/core'],
      },
    ],
  )
})

test('rejects a stale workspace version', () => {
  const repositoryRoot = createFixture({
    lockWorkspaceVersion: '0.0.1',
  })

  assert.throws(
    () => new LockfileConsistencyValidator({ repositoryRoot }).validate(),
    /packages\/example version=1\.2\.3/,
  )
})

test('rejects a stale private registry resolution', () => {
  const repositoryRoot = createFixture({
    coreVersion: '0.2.1',
  })

  assert.throws(
    () => new LockfileConsistencyValidator({ repositoryRoot }).validate(),
    /解析 @velaros-ai\/core@0\.2\.1，不满足 package\.json 的 \^0\.3\.2/,
  )
})

test('checks the resolved version against every manifest range', () => {
  const repositoryRoot = createFixture({
    packageCoreRange: '^0.4.0',
  })

  assert.throws(
    () => new LockfileConsistencyValidator({ repositoryRoot }).validate(),
    /不满足 packages\/example\/package\.json 的 \^0\.4\.0/,
  )
})

test('runs each manifest update from its own directory', () => {
  const repositoryRoot = createFixture()
  const updates = []
  const report = new GroupedPrivateLockRefresher({
    repositoryRoot,
    runUpdate: (update) => updates.push(update),
  }).refresh()

  assert.equal(report.updateGroupCount, 2)
  assert.deepEqual(
    updates.map(({ cwd, manifestPath, packageNames }) => ({
      cwd,
      manifestPath,
      packageNames,
    })),
    [
      {
        cwd: repositoryRoot,
        manifestPath: 'package.json',
        packageNames: ['@velaros-ai/core', '@velaros-ai/kernel-sdk'],
      },
      {
        cwd: join(repositoryRoot, 'packages/example'),
        manifestPath: 'packages/example/package.json',
        packageNames: ['@velaros-ai/core'],
      },
    ],
  )
})

test('restores formatting-only manifest changes and continues', () => {
  const repositoryRoot = createFixture()
  const manifestPath = join(repositoryRoot, 'packages/example/package.json')
  const originalSource = readFileSync(manifestPath)

  const report = new GroupedPrivateLockRefresher({
    repositoryRoot,
    runUpdate: () => {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const reorderedManifest = Object.fromEntries(
        Object.entries(manifest).reverse(),
      )
      reorderedManifest.dependencies = Object.fromEntries(
        Object.entries(manifest.dependencies).reverse(),
      )
      writeFileSync(manifestPath, JSON.stringify(reorderedManifest))
    },
  }).refresh()

  assert.equal(report.updateGroupCount, 2)
  assert.ok(readFileSync(manifestPath).equals(originalSource))
})

test('restores exact bytes and fails on dependency semantic changes', () => {
  const repositoryRoot = createFixture()
  const manifestPath = join(repositoryRoot, 'packages/example/package.json')
  const originalSource = readFileSync(manifestPath)

  assert.throws(
    () =>
      new GroupedPrivateLockRefresher({
        repositoryRoot,
        runUpdate: () => {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
          manifest.dependencies['@velaros-ai/core'] = '^9.0.0'
          writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
        },
      }).refresh(),
    /manifest semantics; original bytes restored: packages\/example\/package\.json/,
  )
  assert.ok(readFileSync(manifestPath).equals(originalSource))
})

function createFixture({
  coreVersion = '0.3.2',
  lockWorkspaceVersion = '1.2.3',
  packageCoreRange = '^0.3.2',
} = {}) {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'velaros-lock-check-'))
  mkdirSync(join(repositoryRoot, 'packages/example'), { recursive: true })
  writeJson(join(repositoryRoot, 'package.json'), {
    name: 'fixture',
    private: true,
    dependencies: {
      '@velaros-ai/example': 'workspace:*',
    },
    devDependencies: {
      '@velaros-ai/core': '^0.3.2',
      '@velaros-ai/kernel-sdk': '^0.2.2',
    },
    workspaces: ['packages/*'],
  })
  writeJson(join(repositoryRoot, 'packages/example/package.json'), {
    name: '@velaros-ai/example',
    version: '1.2.3',
    dependencies: {
      '@velaros-ai/core': packageCoreRange,
    },
  })
  writeFileSync(
    join(repositoryRoot, 'bun.lock'),
    `{
  "workspaces": {
    "": {
      "dependencies": {
        "@velaros-ai/example": "workspace:*",
      },
      "devDependencies": {
        "@velaros-ai/core": "^0.3.2",
        "@velaros-ai/kernel-sdk": "^0.2.2",
      },
    },
    "packages/example": {
      "version": "${lockWorkspaceVersion}",
      "dependencies": {
        "@velaros-ai/core": "${packageCoreRange}",
      },
    },
  },
  "packages": {
    "@velaros-ai/core": ["@velaros-ai/core@${coreVersion}", "https://npm.pkg.github.com/download/@velaros-ai/core/${coreVersion}/fixture"],
    "@velaros-ai/kernel-sdk": ["@velaros-ai/kernel-sdk@0.2.2", "https://npm.pkg.github.com/download/@velaros-ai/kernel-sdk/0.2.2/fixture"],
  },
}
`,
  )
  return repositoryRoot
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}
