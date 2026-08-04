import assert from 'node:assert/strict'
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { assertLockfileConsistency } from './lockfileConsistency.mjs'

const ScriptDirectory = dirname(fileURLToPath(import.meta.url))
const RepositoryRoot = resolve(ScriptDirectory, '../../..')
const TypeScriptCli =
  process.env.VELAROS_TYPESCRIPT_CLI
  ?? resolve(RepositoryRoot, 'node_modules/typescript/bin/tsc')
const SkipLockfileAudit = process.argv.includes('--skip-lockfile-audit')
const UtilityTypeNames = [
  'JsonStringifyReplacer',
  'JsonStringifyReplacerValue',
  'LooseOptional',
  'Nullable',
  'Nullish',
  'PlainObject',
]

const PackageSpecifications = [
  {
    name: '@velaros-ai/memory',
    directory: resolve(RepositoryRoot, 'packages/memory'),
    example: 'memory.ts',
    expectedDependencies: {
      '@velaros-ai/core': '^0.4.0',
    },
  },
  {
    name: '@velaros-ai/memory/knowledge',
    directory: resolve(RepositoryRoot, 'packages/memory'),
    example: 'knowledge.ts',
    expectedDependencies: {
      '@velaros-ai/core': '^0.4.0',
    },
  },
  {
    name: '@velaros-ai/memory/adapter-kernel',
    directory: resolve(RepositoryRoot, 'packages/memory'),
    example: 'adapter-kernel.ts',
    expectedDependencies: {
      '@velaros-ai/core': '^0.4.0',
      '@velaros-ai/kernel': '^0.1.0',
    },
  },
]

const SupportPackageSpecifications = [
  {
    name: '@velaros-ai/core',
    expectedVersion: '0.4.0',
  },
  {
    name: '@velaros-ai/kernel',
    expectedVersion: '0.1.0',
  },
  {
    name: '@velaros-ai/ui',
    expectedVersion: '0.2.2',
    combinedOnly: true,
    allowSideEffects: true,
  },
]

const RequiredPublishedFiles = [
  'package.json',
  'README.md',
  'examples/minimal.ts',
  'dist/index.js',
  'dist/index.d.ts',
]

export class SynchronousCommandRunner {
  #maxAttempts
  #onRetry
  #retryDelayMs
  #spawn
  #wait

  constructor({
    maxAttempts = 3,
    onRetry = writeRetryWarning,
    retryDelayMs = 250,
    spawn = spawnSync,
    wait = waitSynchronously,
  } = {}) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new TypeError('maxAttempts must be a positive integer')
    }
    this.#maxAttempts = maxAttempts
    this.#onRetry = onRetry
    this.#retryDelayMs = retryDelayMs
    this.#spawn = spawn
    this.#wait = wait
  }

  run(command, args, options = {}) {
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const result = this.#spawnCommand(command, args, options)
      const transientFailure =
        Boolean(result.error)
        || Boolean(result.signal)
        || result.status === null

      if (transientFailure && attempt < this.#maxAttempts) {
        const delayMs = this.#retryDelayMs * attempt
        this.#onRetry({
          args,
          attempt,
          command,
          delayMs,
          maxAttempts: this.#maxAttempts,
          result,
        })
        this.#wait(delayMs)
        continue
      }
      if (result.status !== 0) {
        throw createCommandFailure(
          command,
          args,
          result,
          attempt,
          this.#maxAttempts,
        )
      }
      return normalizeCommandOutput(result.stdout)
    }
    throw new Error('Unreachable command runner state')
  }

  #spawnCommand(command, args, options) {
    try {
      return this.#spawn(command, args, {
        cwd: options.cwd ?? RepositoryRoot,
        encoding: 'utf8',
        env: process.env,
      })
    } catch (error) {
      return {
        error: error instanceof Error ? error : new Error(String(error)),
        signal: null,
        status: null,
        stderr: undefined,
        stdout: undefined,
      }
    }
  }
}

function createCommandFailure(command, args, result, attempt, maxAttempts) {
  const stdout = normalizeCommandOutput(result.stdout)
  const stderr = normalizeCommandOutput(result.stderr)
  const errorDetail = result.error
    ? `spawn error: ${result.error.code ? `${result.error.code} ` : ''}${result.error.message}`
    : ''
  const signalDetail = result.signal ? `signal: ${result.signal}` : ''
  const statusDetail = `exit status: ${String(result.status)}`
  return new Error(
    [
      `命令失败（attempt ${attempt}/${maxAttempts}）：${command} ${args.join(' ')}`,
      errorDetail,
      signalDetail,
      statusDetail,
      stdout ? `stdout:\n${stdout}` : '',
      stderr ? `stderr:\n${stderr}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    result.error ? { cause: result.error } : undefined,
  )
}

function normalizeCommandOutput(output) {
  if (output === undefined || output === null) return ''
  return String(output).trim()
}

function waitSynchronously(delayMs) {
  if (delayMs <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
}

function writeRetryWarning({
  args,
  attempt,
  command,
  delayMs,
  maxAttempts,
  result,
}) {
  const reason = [
    result.error?.message,
    result.signal ? `signal ${result.signal}` : '',
    result.status === null ? 'null status' : '',
  ]
    .filter(Boolean)
    .join(', ')
  process.stderr.write(
    `Transient spawn failure for ${command} ${args.join(' ')} (${reason || 'unknown'}); retrying after ${delayMs}ms [${attempt}/${maxAttempts}].\n`,
  )
}

const CommandRunner = new SynchronousCommandRunner()

function run(command, args, options = {}) {
  return CommandRunner.run(command, args, options)
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

function archiveNameFor(packageName) {
  return `${packageName.replace('@velaros-ai/', 'velaros-ai-')}.tgz`
}

function collectExportTargets(exportsMap) {
  const targets = []

  for (const definition of Object.values(exportsMap ?? {})) {
    if (typeof definition === 'string') {
      targets.push(definition)
      continue
    }

    for (const target of Object.values(definition ?? {})) {
      if (typeof target === 'string') targets.push(target)
    }
  }

  return targets
}

async function assertPublishedTarget(packageRoot, target) {
  const relativeTarget = target.replace(/^\.\//, '')
  if (!relativeTarget.includes('*')) {
    await readFile(join(packageRoot, relativeTarget))
    return
  }

  const targetDirectory = dirname(relativeTarget)
  const filePattern = basename(relativeTarget)
  const [prefix, suffix] = filePattern.split('*')
  const entries = await readdir(join(packageRoot, targetDirectory))
  assert.ok(
    entries.some((entry) => entry.startsWith(prefix) && entry.endsWith(suffix)),
    `发布 export 模式没有匹配文件：${target}`
  )
}

async function collectDeclarationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nestedFiles = await Promise.all(
    entries.map((entry) => {
      const entryPath = join(directory, entry.name)
      return entry.isDirectory()
        ? collectDeclarationFiles(entryPath)
        : Promise.resolve(entryPath.endsWith('.d.ts') ? [entryPath] : [])
    })
  )
  return nestedFiles.flat()
}

async function assertPublishedDeclarations(
  packageRoot,
  { enforceUtilityImports = false } = {}
) {
  const declarations = await collectDeclarationFiles(join(packageRoot, 'dist'))

  for (const declaration of declarations) {
    const sourceText = await readFile(declaration, 'utf8')
    assert.notEqual(
      basename(declaration),
      'velaros-globals.d.ts',
      `${declaration} 不得发布 ambient globals`
    )
    assert.doesNotMatch(sourceText, /(?:declare global|^\/\/\/\s*<reference)/mu)
    if (!enforceUtilityImports) continue
    if (declaration.endsWith('/internal/utility-types.d.ts')) continue

    const importLine =
      sourceText
        .split('\n')
        .find((line) => line.includes('internal/utility-types.js')) ?? ''
    const declarationBody = sourceText.replace(importLine, '')
    for (const typeName of UtilityTypeNames) {
      if (new RegExp(`\\b${typeName}\\b`, 'u').test(declarationBody)) {
        assert.match(
          importLine,
          new RegExp(`\\b${typeName}\\b`, 'u'),
          `${declaration} 使用 ${typeName} 但没有模块级 import type`
        )
      }
    }
  }
}

async function packPackage(specification, archiveDirectory) {
  const archiveName = archiveNameFor(specification.name)
  const archivePath = join(archiveDirectory, archiveName)
  run(
    'bun',
    [
      'pm',
      'pack',
      '--filename',
      archivePath,
      '--ignore-scripts',
      '--quiet',
    ],
    { cwd: specification.directory }
  )
  return archivePath
}

async function auditPackageRoot(
  specification,
  packageRoot,
  { repositoryOwned, rootVersion }
) {
  const manifest = await readJson(join(packageRoot, 'package.json'))

  assert.equal(manifest.name, specification.name)
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.license, 'UNLICENSED')
  if (specification.allowSideEffects) {
    assert.notEqual(manifest.sideEffects, undefined)
  } else {
    assert.equal(manifest.sideEffects, false)
  }
  assert.match(manifest.engines?.node ?? '', />=20/)
  assert.ok(manifest.description)
  if (specification.expectedVersion) {
    assert.equal(manifest.version, specification.expectedVersion)
  }

  if (repositoryOwned) {
    assert.equal(manifest.version, rootVersion)
    assert.ok(manifest.repository?.url)
    assert.ok(manifest.repository?.directory)
    assert.ok(manifest.homepage)
    assert.ok(manifest.bugs?.url)
    for (const relativePath of RequiredPublishedFiles) {
      await readFile(join(packageRoot, relativePath))
    }
    for (const [name, version] of Object.entries(
      specification.expectedDependencies ?? {}
    )) {
      assert.equal(manifest.dependencies?.[name], version)
    }
    if (specification.name === '@velaros-ai/memory/adapter-kernel') {
      assert.equal(manifest.dependencies?.['@velaros-ai/memory'], rootVersion)
    }
    assert.ok(manifest.files.includes('docs'))
    assert.ok(manifest.files.includes('examples'))
  }

  await assertPublishedDeclarations(packageRoot, {
    enforceUtilityImports: repositoryOwned,
  })

  for (const target of [
    manifest.main,
    manifest.types,
    ...collectExportTargets(manifest.exports),
    ...Object.values(manifest.bin ?? {}),
  ].filter(Boolean)) {
    await assertPublishedTarget(packageRoot, target)
  }

  for (const dependencies of [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    for (const version of Object.values(dependencies ?? {})) {
      assert.doesNotMatch(version, /^workspace:/)
    }
  }
}

async function auditPublishedPackage(
  specification,
  archivePath,
  auditDirectory,
  rootVersion
) {
  const extractionDirectory = join(
    auditDirectory,
    basename(archivePath, '.tgz')
  )
  await mkdir(extractionDirectory, { recursive: true })
  run('tar', ['-xzf', archivePath, '-C', extractionDirectory])

  const packageRoot = join(extractionDirectory, 'package')
  await auditPackageRoot(specification, packageRoot, {
    repositoryOwned: true,
    rootVersion,
  })
}

async function writeRegistryConfiguration(consumerDirectory) {
  assert.ok(
    process.env.NODE_AUTH_TOKEN,
    'NODE_AUTH_TOKEN is required to install published VelarOS support packages'
  )
  await writeFile(
    join(consumerDirectory, '.npmrc'),
    [
      '@velaros-ai:registry=https://npm.pkg.github.com',
      '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}',
      '',
    ].join('\n')
  )
}

function supportPackageArguments({ includeCombined }) {
  return SupportPackageSpecifications
    .filter((specification) => includeCombined || !specification.combinedOnly)
    .map(
      (specification) =>
        `${specification.name}@${specification.expectedVersion}`
    )
}

async function auditInstalledSupportPackages(
  consumerDirectory,
  { includeCombined, rootVersion }
) {
  for (const specification of SupportPackageSpecifications) {
    if (specification.combinedOnly && !includeCombined) continue
    await auditPackageRoot(
      specification,
      join(consumerDirectory, 'node_modules', specification.name),
      {
        repositoryOwned: false,
        rootVersion,
      }
    )
  }
}

async function writeConsumerProject(consumerDirectory) {
  await writeFile(
    join(consumerDirectory, 'package.json'),
    JSON.stringify(
      {
        name: 'velaros-memory-package-consumer',
        private: true,
        type: 'module',
      },
      null,
      2
    )
  )
  await writeFile(
    join(consumerDirectory, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022', 'DOM'],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: ['node'],
        },
        include: [
          'package-api.ts',
          'examples/**/*.ts',
          'combined-consumer.ts',
        ],
      },
      null,
      2
    )
  )
  await copyFile(
    resolve(RepositoryRoot, 'tests/memory/consumer/package-api.ts'),
    join(consumerDirectory, 'package-api.ts')
  )

  const examplesDirectory = join(consumerDirectory, 'examples')
  await mkdir(examplesDirectory)
  for (const specification of PackageSpecifications) {
    await copyFile(
      join(
        consumerDirectory,
        'node_modules',
        specification.name,
        'examples/minimal.ts'
      ),
      join(examplesDirectory, specification.example)
    )
  }

  await writeFile(
    join(consumerDirectory, 'runtime-import.mjs'),
    `import assert from 'node:assert/strict'

const memory = await import('@velaros-ai/memory')
const knowledge = await import('@velaros-ai/memory/knowledge')
const adapter = await import('@velaros-ai/memory/adapter-kernel')

assert.equal(typeof memory.DefaultMemoryRuntime, 'function')
assert.equal(typeof memory.MemoryRuntime, 'function')
assert.equal(typeof knowledge.DefaultKnowledgeRuntime, 'function')
assert.equal(typeof knowledge.KnowledgeRuntime, 'function')
assert.equal(typeof knowledge.VectorFailureMonitor, 'function')
assert.equal(typeof adapter.MemoryAdapterRuntime, 'function')
assert.equal(typeof adapter.mountMemoryAdapter, 'function')
`
  )
}

async function writeCombinedConsumer(consumerDirectory) {
  await writeFile(
    join(consumerDirectory, 'combined-consumer.ts'),
    `import { isBlank } from '@velaros-ai/core'
import * as Knowledge from '@velaros-ai/memory/knowledge'
import * as Memory from '@velaros-ai/memory'
import * as MemoryAdapter from '@velaros-ai/memory/adapter-kernel'
import * as UI from '@velaros-ai/ui'
import type { Nullable as UiNullable } from '@velaros-ai/ui/utility-types'

declare const nullableText: UiNullable<string>

void nullableText
void isBlank('text')
void Knowledge
void Memory
void MemoryAdapter
void UI
`
  )
  await writeFile(
    join(consumerDirectory, 'tsconfig.combined.json'),
    JSON.stringify(
      {
        extends: './tsconfig.json',
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['combined-consumer.ts'],
      },
      null,
      2
    )
  )
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'velaros-memory-consumer-'))
  const archiveDirectory = join(temporaryRoot, 'archives')
  const auditDirectory = join(temporaryRoot, 'audit')
  const consumerDirectory = join(temporaryRoot, 'consumer')

  try {
    await mkdir(archiveDirectory)
    await mkdir(auditDirectory)
    await mkdir(consumerDirectory)
    await writeRegistryConfiguration(consumerDirectory)

    const rootManifest = await readJson(join(RepositoryRoot, 'package.json'))
    if (!SkipLockfileAudit) {
      assertLockfileConsistency({ repositoryRoot: RepositoryRoot })
    }
    const archives = []
    for (const specification of PackageSpecifications) {
      const archivePath = await packPackage(specification, archiveDirectory)
      await auditPublishedPackage(
        specification,
        archivePath,
        auditDirectory,
        rootManifest.version
      )
      archives.push(archivePath)
    }

    const standaloneArchives = archives.filter(
      (_archive, index) => !PackageSpecifications[index].combinedOnly
    )
    const combinedArchives = archives

    run(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        '--registry=https://registry.npmjs.org',
        '@types/node@^22.19.17',
        '@types/better-sqlite3@^7.6.13',
        ...supportPackageArguments({ includeCombined: false }),
        ...standaloneArchives,
      ],
      { cwd: consumerDirectory }
    )
    await auditInstalledSupportPackages(consumerDirectory, {
      includeCombined: false,
      rootVersion: rootManifest.version,
    })

    await writeConsumerProject(consumerDirectory)
    run(process.execPath, [TypeScriptCli, '--project', 'tsconfig.json'], {
      cwd: consumerDirectory,
    })
    run(process.execPath, ['runtime-import.mjs'], { cwd: consumerDirectory })

    run(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        '--registry=https://registry.npmjs.org',
        '@types/node@^22.19.17',
        '@types/better-sqlite3@^7.6.13',
        '@types/react@^19.0.0',
        '@types/react-dom@^19.0.0',
        'react@^19.0.0',
        'react-dom@^19.0.0',
        ...supportPackageArguments({ includeCombined: true }),
        ...combinedArchives,
      ],
      { cwd: consumerDirectory }
    )
    await auditInstalledSupportPackages(consumerDirectory, {
      includeCombined: true,
      rootVersion: rootManifest.version,
    })
    await writeCombinedConsumer(consumerDirectory)
    run(process.execPath, [TypeScriptCli, '--project', 'tsconfig.combined.json'], {
      cwd: consumerDirectory,
    })

    console.info(
      '✓ Memory packages pass isolated registry-backed standalone and Core/UI combined consumer gates'
    )
    if (SkipLockfileAudit) {
      console.info('ℹ bun.lock audit skipped explicitly; registry-backed CI must run it')
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) await main()
