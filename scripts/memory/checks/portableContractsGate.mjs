#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RepositoryRoot = resolve(import.meta.dirname, '../..')
const TypeScriptCli = resolve(RepositoryRoot, 'node_modules/typescript/bin/tsc')
const ViteCli = resolve(RepositoryRoot, 'node_modules/vite/bin/vite.js')
const PortablePackages = [
  {
    directory: resolve(RepositoryRoot, 'packages/memory'),
    name: '@velaros-ai/memory',
  },
  {
    directory: resolve(RepositoryRoot, 'packages/knowledge'),
    name: '@velaros-ai/knowledge',
  },
]

export class PortableContractsGate {
  constructor({ repositoryRoot = RepositoryRoot } = {}) {
    this.repositoryRoot = repositoryRoot
  }

  async run() {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), 'velaros-portable-contracts-')
    )
    const consumerRoot = join(temporaryRoot, 'consumer')

    try {
      await mkdir(consumerRoot, { recursive: true })
      for (const packageSpecification of PortablePackages) {
        await this.installPackedPackage(
          packageSpecification,
          temporaryRoot,
          consumerRoot
        )
      }
      await this.writeConsumer(consumerRoot)
      this.runCommand(
        process.execPath,
        [TypeScriptCli, '--project', 'tsconfig.json'],
        consumerRoot
      )
      this.runCommand(
        process.execPath,
        [ViteCli, 'build', '--config', 'vite.config.mjs'],
        consumerRoot
      )
      await this.assertBrowserOutput(consumerRoot)
      process.stdout.write(
        '✓ packed Memory and Knowledge contracts are browser-safe and Node-type independent\n'
      )
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }

  async installPackedPackage(specification, temporaryRoot, consumerRoot) {
    const archiveDirectory = join(
      temporaryRoot,
      specification.name.replace('@velaros-ai/', '')
    )
    await mkdir(archiveDirectory, { recursive: true })
    this.runCommand(
      'bun',
      ['pm', 'pack', '--destination', archiveDirectory],
      specification.directory
    )

    const archives = (await readdir(archiveDirectory))
      .filter((fileName) => fileName.endsWith('.tgz'))
    assert.equal(
      archives.length,
      1,
      `${specification.name} must produce exactly one tarball`
    )

    const installedDirectory = join(
      consumerRoot,
      'node_modules',
      ...specification.name.split('/')
    )
    await mkdir(installedDirectory, { recursive: true })
    this.runCommand(
      'tar',
      [
        '-xzf',
        join(archiveDirectory, archives[0]),
        '-C',
        installedDirectory,
        '--strip-components=1',
      ],
      this.repositoryRoot
    )

    const manifest = JSON.parse(
      await readFile(join(installedDirectory, 'package.json'), 'utf8')
    )
    assert.deepEqual(manifest.exports?.['./contracts'], {
      types: './dist/contracts.d.ts',
      import: './dist/contracts.js',
    })
    await access(join(installedDirectory, 'dist/contracts.d.ts'))
    await access(join(installedDirectory, 'dist/contracts.js'))
  }

  async writeConsumer(consumerRoot) {
    await writeFile(
      join(consumerRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'velaros-portable-contracts-consumer',
          private: true,
          type: 'module',
        },
        null,
        2
      )
    )
    await writeFile(
      join(consumerRoot, 'browser-contracts.ts'),
      `import * as KnowledgeContracts from '@velaros-ai/knowledge/contracts'
import * as MemoryContracts from '@velaros-ai/memory/contracts'
import type {
  KnowledgeDiagnostics,
  KnowledgeReindexOptions,
  KnowledgeReindexResult,
  KnowledgeWorkspaceSyncOptions,
  KnowledgeWorkspaceSyncResult,
} from '@velaros-ai/knowledge/contracts'
import type {
  MemoryDreamRunResult,
  MemoryTreeDiagnostics,
} from '@velaros-ai/memory/contracts'

export interface PortableContractsFixture {
  dream: MemoryDreamRunResult
  memoryDiagnostics: MemoryTreeDiagnostics
  knowledgeDiagnostics: KnowledgeDiagnostics
  reindexOptions: KnowledgeReindexOptions
  reindexResult: KnowledgeReindexResult
  syncOptions: KnowledgeWorkspaceSyncOptions
  syncResult: KnowledgeWorkspaceSyncResult
}

Object.assign(globalThis, {
  __velarosKnowledgeContracts: KnowledgeContracts,
  __velarosMemoryContracts: MemoryContracts,
})
`
    )
    await writeFile(
      join(consumerRoot, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            lib: ['ES2022', 'DOM'],
            strict: true,
            noEmit: true,
            skipLibCheck: false,
            types: [],
          },
          include: ['browser-contracts.ts'],
        },
        null,
        2
      )
    )
    await writeFile(
      join(consumerRoot, 'vite.config.mjs'),
      `import { builtinModules } from 'node:module'

const NodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => \`node:\${name}\`),
])

export default {
  build: {
    emptyOutDir: true,
    lib: {
      entry: 'browser-contracts.ts',
      formats: ['es'],
      fileName: 'memory-knowledge-contracts',
    },
    outDir: 'browser-dist',
  },
  plugins: [
    {
      name: 'reject-node-builtins-and-native-storage',
      enforce: 'pre',
      resolveId(source) {
        if (
          NodeBuiltins.has(source)
          || source === 'better-sqlite3'
          || source === '@lancedb/lancedb'
          || source === 'apache-arrow'
        ) {
          throw new Error(
            \`Portable contracts imported a host or native dependency: \${source}\`
          )
        }
        return null
      },
    },
  ],
}
`
    )
  }

  async assertBrowserOutput(consumerRoot) {
    const outputDirectory = join(consumerRoot, 'browser-dist')
    const outputFiles = (await readdir(outputDirectory))
      .filter((fileName) => fileName.endsWith('.js'))
    assert.ok(outputFiles.length > 0, 'contracts Vite gate emitted no JavaScript')

    for (const outputFile of outputFiles) {
      const source = await readFile(join(outputDirectory, outputFile), 'utf8')
      assert.doesNotMatch(
        source,
        /(?:__vite-browser-external|from\s*['"]node:|import\s*\(\s*['"]node:|better-sqlite3|@lancedb\/lancedb|apache-arrow)/u
      )
    }
  }

  runCommand(command, args, cwd) {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      env: process.env,
    })
    if (result.status === 0) return
    throw new Error(
      [
        `${command} ${args.join(' ')} failed`,
        result.stdout,
        result.stderr,
      ].filter(Boolean).join('\n')
    )
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) {
  await new PortableContractsGate().run()
}
