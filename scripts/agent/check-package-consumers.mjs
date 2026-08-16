#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const packagesRoot = path.join(repositoryRoot, 'packages')
const packageScope = '@velaros-ai/'
// README 门只钉「确实是中文」，不钉章节标题：钉形状钉不住内容，手抄签名必然与代码脱节
// （2026-07-30 判决废除 docs/api.zh-CN.md，README 改中文重写）。
const ChineseCharacter = /[\u4e00-\u9fff]/

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    ...options,
  })
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed:\n${output}`)
  }
  return result.stdout?.trim() ?? ''
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertPackageMetadata(manifest, directoryName) {
  const label = manifest.name ?? directoryName
  assert(manifest.name === `${packageScope}${directoryName}`, `${label}: package name mismatch`)
  assert(
    typeof manifest.description === 'string' && manifest.description.length > 20,
    `${label}: description is required`,
  )
  assert(manifest.license === 'Apache-2.0', `${label}: license must be Apache-2.0`)
  assert(manifest.type === 'module', `${label}: only ESM packages are supported`)
  assert(manifest.sideEffects === false, `${label}: sideEffects must be false`)
  assert(manifest.engines?.node === '>=20.0.0', `${label}: Node engine policy is missing`)
  assert(manifest.main === './dist/index.js', `${label}: main must target dist/index.js`)
  assert(manifest.types === './dist/index.d.ts', `${label}: types must target dist/index.d.ts`)
  assert(manifest.exports?.['.']?.import === './dist/index.js', `${label}: root import export is missing`)
  assert(manifest.exports?.['.']?.types === './dist/index.d.ts', `${label}: root types export is missing`)
  assert(manifest.files?.includes('dist'), `${label}: dist is missing from files`)
  assert(manifest.files?.includes('README.md'), `${label}: README is missing from files`)
  assert(manifest.files?.includes('docs'), `${label}: docs are missing from files`)
  assert(manifest.files?.includes('LICENSE'), `${label}: LICENSE is missing from files`)
  assert(
    manifest.repository?.directory === `packages/${directoryName}`,
    `${label}: repository.directory is incorrect`,
  )
  assert(
    manifest.publishConfig?.access === 'public',
    `${label}: publish access must be public`,
  )
  assert(
    manifest.publishConfig?.registry === 'https://npm.pkg.github.com',
    `${label}: publish registry is incorrect`,
  )
}

async function collectFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectFiles(filePath))
    } else {
      files.push(filePath)
    }
  }
  return files
}

async function collectDeclarationFiles(directory) {
  return (await collectFiles(directory)).filter((filePath) => filePath.endsWith('.d.ts'))
}

async function assertExportedConstructorContracts(packageName, distDirectory) {
  for (const declarationFile of await collectDeclarationFiles(distDirectory)) {
    if (declarationFile.endsWith('velaros-globals.d.ts')) continue
    const sourceFile = ts.createSourceFile(
      declarationFile,
      await readFile(declarationFile, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const exportedNames = new Set()
    const localContractNames = new Set()

    for (const statement of sourceFile.statements) {
      if (
        (
          ts.isInterfaceDeclaration(statement)
          || ts.isTypeAliasDeclaration(statement)
          || ts.isClassDeclaration(statement)
          || ts.isEnumDeclaration(statement)
        )
        && statement.name
      ) {
        localContractNames.add(statement.name.text)
        if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
          exportedNames.add(statement.name.text)
        }
      }
      if (
        ts.isExportDeclaration(statement)
        && statement.exportClause
        && ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements) {
          exportedNames.add((element.propertyName ?? element.name).text)
        }
      }
    }

    for (const statement of sourceFile.statements) {
      if (
        !ts.isClassDeclaration(statement)
        || !statement.name
        || !exportedNames.has(statement.name.text)
      ) {
        continue
      }
      for (const member of statement.members) {
        if (!ts.isConstructorDeclaration(member)) continue
        for (const parameter of member.parameters) {
          if (!parameter.type) continue
          const referencedNames = new Set()
          const visit = (node) => {
            if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
              referencedNames.add(node.typeName.text)
            }
            ts.forEachChild(node, visit)
          }
          visit(parameter.type)
          for (const name of referencedNames) {
            assert(
              !localContractNames.has(name) || exportedNames.has(name),
              `${packageName}: ${statement.name.text} constructor uses non-exported ${name} in ${path.relative(distDirectory, declarationFile)}`,
            )
          }
        }
      }
    }
  }
}

const repositoryHelperTypeNames = new Set([
  'JsonStringifyReplacer',
  'JsonStringifyReplacerValue',
  'LooseOptional',
  'Nullable',
  'Nullish',
  'PlainObject',
])

async function assertNoAmbientHelperTypes(packageName, installedDirectory) {
  const distDirectory = path.join(installedDirectory, 'dist')
  assert(
    !await fileExists(path.join(distDirectory, 'velaros-globals.d.ts')),
    `${packageName}: tarball must not publish velaros-globals.d.ts`,
  )

  for (const declarationFile of await collectDeclarationFiles(distDirectory)) {
    const sourceText = await readFile(declarationFile, 'utf8')
    assert(
      !sourceText.includes('reference types="@velaros-ai/core"'),
      `${packageName}: declaration must not load Core ambient types`,
    )
    assert(
      !sourceText.includes('velaros-globals.d.ts'),
      `${packageName}: declaration still references velaros-globals.d.ts`,
    )

    const sourceFile = ts.createSourceFile(
      declarationFile,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    for (const statement of sourceFile.statements) {
      if (
        ts.isModuleDeclaration(statement)
        && statement.name.getText(sourceFile) === 'global'
      ) {
        throw new Error(`${packageName}: ${path.relative(distDirectory, declarationFile)} declares global scope`)
      }
      if (
        ts.isTypeAliasDeclaration(statement)
        && repositoryHelperTypeNames.has(statement.name.text)
        && !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        throw new Error(
          `${packageName}: ${path.relative(distDirectory, declarationFile)} publishes ambient helper ${statement.name.text}`,
        )
      }
    }
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function dependencyNames(manifest) {
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  })
}

// Workspace packages are packed from source; every other @velaros-ai/* dependency
// is a published registry package and gets linked from the installed tree like any third-party dep.
function internalDependencyClosure(packageName, packagesByName) {
  const closure = new Set()
  const visit = (name) => {
    if (closure.has(name)) return
    const record = packagesByName.get(name)
    assert(record, `${packageName}: unknown internal dependency ${name}`)
    closure.add(name)
    for (const dependencyName of dependencyNames(record.packedManifest)) {
      if (packagesByName.has(dependencyName)) visit(dependencyName)
    }
  }
  visit(packageName)
  return [...closure]
}

async function linkExternalDependencies(consumerNodeModules, packageNames, packagesByName) {
  const dependencies = new Map()
  for (const packageName of packageNames) {
    const record = packagesByName.get(packageName)
    for (const name of dependencyNames(record.manifest)) {
      if (packagesByName.has(name)) continue
      const candidate = path.join(record.packageDirectory, 'node_modules', ...name.split('/'))
      dependencies.set(name, await realpath(candidate))
    }
  }
  dependencies.set(
    '@types/node',
    await realpath(path.join(repositoryRoot, 'node_modules', '@types', 'node')),
  )

  for (const [name, source] of dependencies) {
    const target = path.join(consumerNodeModules, ...name.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
  }
}

function exportConditionTarget(exportDefinition, condition) {
  if (typeof exportDefinition === 'string') {
    return condition === 'import' ? exportDefinition : undefined
  }
  return exportDefinition?.[condition]
}

async function expandPublicExports(manifest, installedDirectory) {
  const specifiers = []

  for (const [exportKey, definition] of Object.entries(manifest.exports ?? {})) {
    const importTarget = exportConditionTarget(definition, 'import')
    const typesTarget = exportConditionTarget(definition, 'types')
    assert(typeof importTarget === 'string', `${manifest.name}: ${exportKey} has no import target`)
    assert(typeof typesTarget === 'string', `${manifest.name}: ${exportKey} has no types target`)

    if (!exportKey.includes('*')) {
      assert(!importTarget.includes('*'), `${manifest.name}: malformed import target for ${exportKey}`)
      assert(!typesTarget.includes('*'), `${manifest.name}: malformed types target for ${exportKey}`)
      await access(path.join(installedDirectory, importTarget), fsConstants.R_OK)
      await access(path.join(installedDirectory, typesTarget), fsConstants.R_OK)
      specifiers.push(exportKey === '.' ? manifest.name : `${manifest.name}/${exportKey.slice(2)}`)
      continue
    }

    assert(importTarget.includes('*'), `${manifest.name}: wildcard import target missing for ${exportKey}`)
    assert(typesTarget.includes('*'), `${manifest.name}: wildcard types target missing for ${exportKey}`)
    const [importPrefix, importSuffix] = importTarget.split('*')
    const searchDirectory = path.join(installedDirectory, path.dirname(importPrefix))
    const candidateFiles = await collectFiles(searchDirectory)
    const absolutePrefix = path.join(installedDirectory, importPrefix)
    const absoluteSuffix = importSuffix
    const wildcardMatches = candidateFiles.flatMap((candidate) => {
      if (!candidate.startsWith(absolutePrefix) || !candidate.endsWith(absoluteSuffix)) return []
      return [candidate.slice(absolutePrefix.length, candidate.length - absoluteSuffix.length)]
    })
    assert(wildcardMatches.length > 0, `${manifest.name}: wildcard export ${exportKey} matches no files`)

    const [keyPrefix, keySuffix] = exportKey.split('*')
    const [typesPrefix, typesSuffix] = typesTarget.split('*')
    for (const wildcardMatch of wildcardMatches) {
      const concreteKey = `${keyPrefix}${wildcardMatch}${keySuffix}`
      const concreteTypesTarget = `${typesPrefix}${wildcardMatch}${typesSuffix}`
      await access(path.join(installedDirectory, concreteTypesTarget), fsConstants.R_OK)
      specifiers.push(`${manifest.name}/${concreteKey.slice(2)}`)
    }
  }

  return [...new Set(specifiers)].sort()
}

async function assertPackedCli(manifest, installedDirectory) {
  if (manifest.bin) {
    const entries = typeof manifest.bin === 'string'
      ? [[manifest.name, manifest.bin]]
      : Object.entries(manifest.bin)
    for (const [command, target] of entries) {
      const binPath = path.join(installedDirectory, target)
      await access(binPath, fsConstants.R_OK)
      const mode = (await stat(binPath)).mode
      assert((mode & 0o111) !== 0, `${manifest.name}: CLI ${command} is not executable`)
    }
  }
}

async function unpackPackage(record, consumerNodeModules) {
  const installedDirectory = path.join(consumerNodeModules, ...record.manifest.name.split('/'))
  await mkdir(installedDirectory, { recursive: true })
  run(
    'tar',
    [
      '-xzf',
      record.tarballPath,
      '-C',
      installedDirectory,
      '--strip-components=1',
    ],
    repositoryRoot,
  )
  return installedDirectory
}

async function createPackageConsumer(record, packagesByName, consumersRoot) {
  const consumerRoot = await mkdtemp(path.join(consumersRoot, `${record.directoryName}-`))
  const consumerNodeModules = path.join(consumerRoot, 'node_modules')
  const closure = internalDependencyClosure(record.manifest.name, packagesByName)
  await mkdir(path.join(consumerNodeModules, '@velaros-ai'), { recursive: true })
  await linkExternalDependencies(consumerNodeModules, closure, packagesByName)

  for (const dependencyName of closure) {
    await unpackPackage(packagesByName.get(dependencyName), consumerNodeModules)
  }

  const installedDirectory = path.join(
    consumerNodeModules,
    ...record.manifest.name.split('/'),
  )
  const publicSpecifiers = await expandPublicExports(record.packedManifest, installedDirectory)
  await assertExportedConstructorContracts(
    record.manifest.name,
    path.join(installedDirectory, 'dist'),
  )
  await assertPackedCli(record.packedManifest, installedDirectory)

  await writeFile(
    path.join(consumerRoot, 'package.json'),
    JSON.stringify({
      name: `consumer-${record.directoryName}`,
      private: true,
      type: 'module',
      dependencies: {
        [record.manifest.name]: record.packedManifest.version,
      },
    }, null, 2),
  )

  const imports = publicSpecifiers
    .map((specifier, index) => `import * as api${index} from ${JSON.stringify(specifier)}`)
    .join('\n')
  const values = publicSpecifiers.map((_, index) => `api${index}`).join(', ')
  await writeFile(
    path.join(consumerRoot, 'consumer.ts'),
    `${imports}

void [${values}]
`,
  )
  await writeFile(
    path.join(consumerRoot, 'runtime.mjs'),
    `const specifiers = ${JSON.stringify(publicSpecifiers, null, 2)}
for (const specifier of specifiers) {
  await import(specifier)
}
console.info(${JSON.stringify(record.manifest.name)} + \` runtime imports passed: \${specifiers.length}\`)
`,
  )
  await writeFile(
    path.join(consumerRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ['node'],
      },
      include: ['consumer.ts'],
    }, null, 2),
  )

  run(process.execPath, ['runtime.mjs'], consumerRoot, { stdio: 'inherit' })
  run(
    process.execPath,
    [path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'],
    consumerRoot,
    { stdio: 'inherit' },
  )

  console.info(
    `${record.manifest.name} isolated consumer passed (internal closure: ${closure.join(', ')})`,
  )
}

// Proves the freshly packed agent tarballs and the published @velaros-ai/core declaration surface
// can coexist with a third-party package that declares its own ambient helper aliases. Core is no
// longer part of the locally packed closure, so the probe installs it as the registry artifact
// that linkExternalDependencies mirrors into the consumer.
async function createAmbientConflictConsumer(packagesByName, consumersRoot) {
  const consumerRoot = await mkdtemp(path.join(consumersRoot, 'ambient-conflict-'))
  const consumerNodeModules = path.join(consumerRoot, 'node_modules')
  const agentRuntimeName = '@velaros-ai/agent'
  const coreName = '@velaros-ai/core'
  const closure = internalDependencyClosure(agentRuntimeName, packagesByName)
  await mkdir(path.join(consumerNodeModules, '@velaros-ai'), { recursive: true })
  await linkExternalDependencies(consumerNodeModules, closure, packagesByName)
  for (const dependencyName of closure) {
    await unpackPackage(packagesByName.get(dependencyName), consumerNodeModules)
  }

  const probeSource = path.join(consumerRoot, 'ui-probe-source')
  const probePack = path.join(consumerRoot, 'ui-probe-pack')
  await mkdir(probeSource, { recursive: true })
  await mkdir(probePack, { recursive: true })
  await writeFile(
    path.join(probeSource, 'package.json'),
    JSON.stringify({
      name: '@velaros-ai/ui-conflict-probe',
      version: '0.0.0',
      private: true,
      type: 'module',
      main: './index.js',
      types: './index.d.ts',
      exports: {
        '.': {
          types: './index.d.ts',
          import: './index.js',
        },
      },
      files: ['index.js', 'index.d.ts', 'velaros-globals.d.ts'],
    }, null, 2),
  )
  await writeFile(
    path.join(probeSource, 'velaros-globals.d.ts'),
    `type Nullish = undefined | null
type Nullable<T> = T | null
type LooseOptional<T> = T | Nullish
`,
  )
  await writeFile(
    path.join(probeSource, 'index.d.ts'),
    `/// <reference path="./velaros-globals.d.ts" />
export interface UiConflictProbe {
  value: Nullable<string>
  optional: LooseOptional<number>
}
export declare const uiConflictProbe: true
`,
  )
  await writeFile(path.join(probeSource, 'index.js'), 'export const uiConflictProbe = true\n')
  run('bun', ['pm', 'pack', '--destination', probePack, '--ignore-scripts'], probeSource)
  const probeTarballs = (await readdir(probePack)).filter((entry) => entry.endsWith('.tgz'))
  assert(probeTarballs.length === 1, 'UI conflict probe must produce exactly one tarball')
  const probeInstall = path.join(consumerNodeModules, '@velaros-ai', 'ui-conflict-probe')
  await mkdir(probeInstall, { recursive: true })
  run(
    'tar',
    [
      '-xzf',
      path.join(probePack, probeTarballs[0]),
      '-C',
      probeInstall,
      '--strip-components=1',
    ],
    repositoryRoot,
  )

  await writeFile(
    path.join(consumerRoot, 'consumer.ts'),
    `import { AppError } from '${coreName}'
import { MonotonicExecutionIdFactory } from '${agentRuntimeName}'
import {
  uiConflictProbe,
  type UiConflictProbe,
} from '@velaros-ai/ui-conflict-probe'

const probe: UiConflictProbe = { value: null, optional: undefined }
const ids = new MonotonicExecutionIdFactory({ now: () => 1 }, 'consumer')
void [new AppError('TEST', ids.createExecutionId()), probe, uiConflictProbe]
`,
  )
  await writeFile(
    path.join(consumerRoot, 'runtime.mjs'),
    `await Promise.all([
  import('${coreName}'),
  import('${agentRuntimeName}'),
  import('@velaros-ai/ui-conflict-probe'),
])
`,
  )
  await writeFile(
    path.join(consumerRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ['node'],
      },
      include: ['consumer.ts'],
    }, null, 2),
  )
  run(
    process.execPath,
    [path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'],
    consumerRoot,
    { stdio: 'inherit' },
  )
  run(process.execPath, ['runtime.mjs'], consumerRoot, { stdio: 'inherit' })
  console.info('core + agent + ambient UI tarball conflict probe passed')
}

const packageDirectories = (await readdir(packagesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const workspace = await mkdtemp(path.join(tmpdir(), 'velaros-agent-consumers-'))
const packedDirectory = path.join(workspace, 'packed')
const inspectionRoot = path.join(workspace, 'inspection')
const consumersRoot = path.join(workspace, 'consumers')

try {
  await mkdir(packedDirectory, { recursive: true })
  await mkdir(inspectionRoot, { recursive: true })
  await mkdir(consumersRoot, { recursive: true })
  const packagesByName = new Map()

  for (const directoryName of packageDirectories) {
    const packageDirectory = path.join(packagesRoot, directoryName)
    const manifest = await readJson(path.join(packageDirectory, 'package.json'))
    assertPackageMetadata(manifest, directoryName)

    const readme = await readFile(path.join(packageDirectory, 'README.md'), 'utf8')
    assert(
      ChineseCharacter.test(readme),
      `${manifest.name}: README.md must be written in Chinese`,
    )

    const before = new Set(await readdir(packedDirectory))
    run(
      'bun',
      ['pm', 'pack', '--destination', packedDirectory, '--ignore-scripts'],
      packageDirectory,
    )
    const tarball = (await readdir(packedDirectory)).find(
      (entry) => entry.endsWith('.tgz') && !before.has(entry),
    )
    assert(tarball, `${manifest.name}: pack did not create one tarball`)

    const inspectionDirectory = path.join(inspectionRoot, directoryName)
    await mkdir(inspectionDirectory, { recursive: true })
    run(
      'tar',
      [
        '-xzf',
        path.join(packedDirectory, tarball),
        '-C',
        inspectionDirectory,
        '--strip-components=1',
      ],
      repositoryRoot,
    )
    const packedManifest = await readJson(path.join(inspectionDirectory, 'package.json'))
    assertPackageMetadata(packedManifest, directoryName)
    for (const dependencies of [
      packedManifest.dependencies,
      packedManifest.optionalDependencies,
      packedManifest.peerDependencies,
    ]) {
      for (const version of Object.values(dependencies ?? {})) {
        assert(
          !String(version).startsWith('workspace:'),
          `${manifest.name}: workspace selector leaked into tarball`,
        )
      }
    }
    await readFile(path.join(inspectionDirectory, 'dist', 'index.js'))
    await readFile(path.join(inspectionDirectory, 'dist', 'index.d.ts'))
    await readFile(path.join(inspectionDirectory, 'README.md'))
    await assertNoAmbientHelperTypes(manifest.name, inspectionDirectory)

    packagesByName.set(manifest.name, {
      directoryName,
      packageDirectory,
      manifest,
      packedManifest,
      tarballPath: path.join(packedDirectory, tarball),
    })
  }

  for (const record of packagesByName.values()) {
    await createPackageConsumer(record, packagesByName, consumersRoot)
  }
  await createAmbientConflictConsumer(packagesByName, consumersRoot)

  console.info(`isolated consumer package checks passed: ${packagesByName.size} packages`)
} finally {
  await rm(workspace, { recursive: true, force: true })
}
