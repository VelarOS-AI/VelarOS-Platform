import assert from 'node:assert/strict'
import { cp, copyFile, mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const RepositoryRoot = resolve(import.meta.dirname, '../../..')
const GateRelativePath = 'scripts/check-package-consumer.mjs'

test('consumer gate contains no sibling repository sources', async () => {
  const source = await readFile(
    resolve(RepositoryRoot, GateRelativePath),
    'utf8'
  )
  assert.doesNotMatch(source, /\.\.\/VelarOS-(?:Kernel|UI)/u)
})

test(
  'consumer gate runs from a copied repository without sibling repositories',
  { skip: !process.env.NODE_AUTH_TOKEN && 'NODE_AUTH_TOKEN is required' },
  async () => {
    const isolatedParent = await mkdtemp(
      join(tmpdir(), 'velaros-model-isolated-repository-')
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
        copyDirectoryWithoutDependencies('tests/model/consumer', copiedRepository),
      ])
      await copyScript('scripts/checks/lockfileConsistency.mjs', copiedRepository)
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
            VELAROS_VITE_CLI: resolve(
              RepositoryRoot,
              'node_modules/vite/bin/vite.js'
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
  }
)

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
