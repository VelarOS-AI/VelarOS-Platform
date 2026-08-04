import assert from 'node:assert/strict'
import { cp, copyFile, mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const RepositoryRoot = resolve(import.meta.dirname, '../../..')
const GateRelativePath = 'scripts/memory/checks/packageConsumerGate.mjs'
const NoSiblingSourceFiles = [
  GateRelativePath,
  'tsconfig.eslint.json',
  'packages/memory/tsconfig.json',
]
const MaintainedConsumerRelativePath =
  'tests/memory/maintained/packages/memory/package-consumer.test.mjs'

test('consumer and TypeScript boundaries contain no sibling repository sources', async () => {
  for (const relativePath of NoSiblingSourceFiles) {
    const source = await readFile(resolve(RepositoryRoot, relativePath), 'utf8')
    assert.doesNotMatch(source, /\.\.\/VelarOS-(?:Kernel|UI)/u, relativePath)
  }
})

test('maintained package test resolves explicit grouped-package build entries', async () => {
  const source = await readFile(
    resolve(RepositoryRoot, MaintainedConsumerRelativePath),
    'utf8'
  )
  for (const packageEntry of [
    'packages/memory/dist/index.js',
    'packages/memory/dist/knowledge/index.js',
    'packages/memory/dist/adapter-kernel/index.js',
  ]) {
    assert.match(
      source,
      new RegExp(
        packageEntry.replaceAll('.', '\\.'),
        'u'
      )
    )
  }
})

test('consumer gate runs from a copied repository without sibling repositories', async () => {
  const isolatedParent = await mkdtemp(
    join(tmpdir(), 'velaros-memory-isolated-repository-')
  )
  const copiedRepository = join(isolatedParent, 'repository')

  try {
    await mkdir(copiedRepository)
    await Promise.all([
      copyFile(
        resolve(RepositoryRoot, 'package.json'),
        join(copiedRepository, 'package.json')
      ),
      copyFile(
        resolve(RepositoryRoot, 'bun.lock'),
        join(copiedRepository, 'bun.lock')
      ),
      copyDirectoryWithoutDependencies('packages', copiedRepository),
      copyDirectoryWithoutDependencies('tests/memory/consumer', copiedRepository),
    ])
    await copyScript('scripts/memory/checks/lockfileConsistency.mjs', copiedRepository)
    await copyScript(GateRelativePath, copiedRepository)

    assert.deepEqual(await readdir(isolatedParent), ['repository'])

    const result = spawnSync(
      process.execPath,
      [resolve(copiedRepository, GateRelativePath)],
      {
        cwd: copiedRepository,
        encoding: 'utf8',
        env: {
          ...process.env,
          VELAROS_TYPESCRIPT_CLI: resolve(
            RepositoryRoot,
            'node_modules/typescript/bin/tsc'
          ),
        },
      }
    )

    assert.equal(
      result.status,
      0,
      [
        result.error?.stack,
        result.stdout,
        result.stderr,
      ].filter(Boolean).join('\n')
    )
  } finally {
    await rm(isolatedParent, { recursive: true, force: true })
  }
})

async function copyDirectoryWithoutDependencies(relativePath, destinationRoot) {
  const source = resolve(RepositoryRoot, relativePath)
  const destination = resolve(destinationRoot, relativePath)
  await cp(source, destination, {
    recursive: true,
    filter: (sourcePath) => {
      const segments = relative(source, sourcePath).split(sep)
      return !segments.includes('node_modules')
    },
  })
}

async function copyScript(relativePath, destinationRoot) {
  const destination = resolve(destinationRoot, relativePath)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(resolve(RepositoryRoot, relativePath), destination)
}
