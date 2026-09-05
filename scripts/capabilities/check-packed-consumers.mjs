#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import { CapabilityPackages } from './capability-owners.mjs'
import { InstalledPackageResolver } from './lib/installed-package-resolver.mjs'
import { safePackPackage } from '../release/safe-package-pack.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const packagesRoot = path.join(repositoryRoot, 'packages')
const viteCli = path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const capabilityPackageNames = new Set(CapabilityPackages.map(({ name }) => name))
const installedPackageResolver = new InstalledPackageResolver({
  repositoryRoot,
  workspaceDirectories: CapabilityPackages.map(({ directory }) =>
    path.join(packagesRoot, directory)
  ),
})
const kernelPackageSources = new Map(
  await Promise.all(
    ['@velaros-ai/core', '@velaros-ai/kernel'].map(async (packageName) => [
      packageName,
      await installedPackageResolver.resolve(packageName),
    ]),
  ),
)
const expectedKernelVersions = new Map([
  ['@velaros-ai/core', '0.4.0'],
  ['@velaros-ai/kernel', '0.1.0'],
])
const repositoryHelperTypeNames = new Set([
  'JsonStringifyReplacer',
  'JsonStringifyReplacerValue',
  'LooseOptional',
  'Nullable',
  'Nullish',
  'PlainObject',
])
const forbiddenPublishedPathFragments = [
  '/Users/example',
  'WebstormProjects',
]
const portableContractsFixtures = new Map([
  [
    '@velaros-ai/computer',
    {
      bundleName: 'computer-contracts',
      source: `import {
  ComputerOperationMetadata,
  ComputerToolOperations,
  type ComputerOperation,
} from '@velaros-ai/computer/contracts'

export interface ComputerContractsTypeFixture {
  operation: ComputerOperation
}

Object.assign(globalThis, { __velarosComputerContractsBrowserGate: {
  ComputerOperationMetadata,
  ComputerToolOperations,
} })
`,
    },
  ],
  [
    '@velaros-ai/project',
    {
      bundleName: 'project-contracts',
      source: `import {
  isProjectRootSource,
  ProjectRootSource,
  ProjectToolNames,
  type ProjectBackgroundProcessInfo,
  type ProjectCommandResult,
  type ProjectGitBranch,
  type ProjectReadFileResult,
  type ProjectRootEntry,
} from '@velaros-ai/project/contracts'

export interface ProjectContractsTypeFixture {
  root: ProjectRootEntry
  branch: ProjectGitBranch
  backgroundProcess: ProjectBackgroundProcessInfo
  commandResult: ProjectCommandResult
  readResult: ProjectReadFileResult
}

Object.assign(globalThis, { __velarosProjectContractsBrowserGate: {
  ProjectRootSource,
  ProjectToolNames,
  isProjectRootSource,
} })
`,
    },
  ],
  [
    '@velaros-ai/browser/core',
    {
      bundleName: 'browser-core-contracts',
      source: `import {
  buildBrowserScreenshotOptions,
  getBrowserSiteHost,
  getBrowserUrlCandidate,
  isLocalBrowserUrl,
  resolveBrowserNavigationInput,
  resolveBrowserSearchFallbackUrl,
  resolveBrowserSearchOrNavigationInput,
  type BrowserAutomationMode,
  type BrowserElementSelection,
  type BrowserPageNavigationAction,
  type BrowserPagePreviewFrame,
  type BrowserViewportOptions,
} from '@velaros-ai/browser/core/contracts'

export interface BrowserContractsTypeFixture {
  mode: BrowserAutomationMode
  selection: BrowserElementSelection
  navigation: BrowserPageNavigationAction
  preview: BrowserPagePreviewFrame
  viewport: BrowserViewportOptions
}

Object.assign(globalThis, { __velarosBrowserContractsBrowserGate: {
  buildBrowserScreenshotOptions,
  getBrowserSiteHost,
  getBrowserUrlCandidate,
  isLocalBrowserUrl,
  resolveBrowserNavigationInput,
  resolveBrowserSearchFallbackUrl,
  resolveBrowserSearchOrNavigationInput,
} })
`,
    },
  ],
  [
    '@velaros-ai/system',
    {
      bundleName: 'system-contracts',
      source: `import * as SystemContracts from '@velaros-ai/system/contracts'
import type {
  SystemBackgroundTaskRecord,
  SystemDefaultEditorId,
  SystemEnvironmentInspection,
  SystemOverview,
  SystemRuntimePlatform,
} from '@velaros-ai/system/contracts'

export interface SystemContractsTypeFixture {
  backgroundTask: SystemBackgroundTaskRecord
  defaultEditor: SystemDefaultEditorId
  environment: SystemEnvironmentInspection
  overview: SystemOverview
  platform: SystemRuntimePlatform
}

Object.assign(globalThis, { __velarosSystemContractsBrowserGate: SystemContracts })
`,
    },
  ],
])
const consumerTypeFixtures = new Map([
  [
    '@velaros-ai/development',
    `import {
  executeProjectCodeLanguageQuery,
  type LanguageReadPort,
  type LanguageToolContext,
} from '@velaros-ai/development/runtime'

declare const source: LanguageReadPort

const languageContext: LanguageToolContext = {
  abortSignal: new AbortController().signal,
  project: {
    getRootPath: () => '/workspace/example',
    runInDirectory: async (_path, action) => action(),
    kernel: async () => source,
  },
}

void executeProjectCodeLanguageQuery({ action: 'find_symbols' }, languageContext)
`,
  ],
  [
    '@velaros-ai/office',
    `import type {
  OfficeEnvironmentInspection,
  OfficeSystemApi,
} from '@velaros-ai/office/contracts'

declare const inspectFromHost: (
  commands?: string[]
) => Promise<OfficeEnvironmentInspection>

const inspectForOffice: OfficeSystemApi['inspectEnvironment'] = inspectFromHost

void inspectForOffice
`,
  ],
])

function run(command, args, cwd = repositoryRoot, options = {}) {
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

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function collectFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(filePath))
    else files.push(filePath)
  }
  return files
}

function dependencyNames(manifest) {
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  })
}

function assertManifestQuality(manifest, directoryName) {
  const label = manifest.name ?? directoryName
  assert(
    manifest.name === `@velaros-ai/${directoryName}`,
    `${label}: package name does not match its directory`,
  )
  assert(
    typeof manifest.description === 'string' && manifest.description.trim().length >= 20,
    `${label}: description must explain the public package`,
  )
  assert(manifest.license === 'Apache-2.0', `${label}: license must be Apache-2.0`)
  assert(manifest.type === 'module', `${label}: only ESM packages are supported`)
  assert(manifest.engines?.node === '>=20.0.0', `${label}: engines.node must be >=20.0.0`)
  assert(manifest.sideEffects === false, `${label}: sideEffects must be false`)
  assert(manifest.repository?.directory === `packages/${directoryName}`, `${label}: repository.directory is incorrect`)
  assert(manifest.files?.includes('dist'), `${label}: files must include dist`)
  assert(manifest.files?.includes('README.md'), `${label}: files must include README.md`)
  assert(manifest.files?.includes('docs'), `${label}: files must include docs`)
  assert(manifest.files?.includes('LICENSE'), `${label}: files must include LICENSE`)
  assert(manifest.exports?.['.'], `${label}: exports must define the root entry`)
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    assert(
      conditions && typeof conditions === 'object',
      `${label}: ${subpath} export must use explicit conditions`,
    )
    assert(typeof conditions.types === 'string', `${label}: ${subpath} must declare types`)
    assert(typeof conditions.import === 'string', `${label}: ${subpath} must declare import`)
  }
}

async function assertDocumentation(packageDirectory, packageName) {
  const readme = await readFile(path.join(packageDirectory, 'README.md'), 'utf8')
  assert(
    /[\u4e00-\u9fff]/.test(readme),
    `${packageName}: README.md must be written in Chinese`,
  )
  assert(
    readme.length >= 400,
    `${packageName}: README.md is ${readme.length} characters — too thin to describe the package`,
  )
}

function importedHelperTypes(sourceFile) {
  const imported = new Set()
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !statement.moduleSpecifier.text.includes('utility-types')
    ) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      imported.add(element.name.text)
    }
  }
  return imported
}

function referencedHelperTypes(sourceFile) {
  const referenced = new Set()
  const visit = (node) => {
    if (
      ts.isTypeReferenceNode(node)
      && ts.isIdentifier(node.typeName)
      && repositoryHelperTypeNames.has(node.typeName.text)
    ) {
      referenced.add(node.typeName.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return referenced
}

function locallyDeclaredHelperTypes(sourceFile) {
  const declared = new Set()
  for (const statement of sourceFile.statements) {
    if (
      ts.isTypeAliasDeclaration(statement)
      && repositoryHelperTypeNames.has(statement.name.text)
    ) {
      declared.add(statement.name.text)
    }
  }
  return declared
}

async function assertNoAmbientHelperTypes(packageName, installedDirectory) {
  const distDirectory = path.join(installedDirectory, 'dist')
  assert(
    !await exists(path.join(distDirectory, 'velaros-globals.d.ts')),
    `${packageName}: tarball must not publish velaros-globals.d.ts`,
  )

  const declarationFiles = (await collectFiles(installedDirectory))
    .filter((filePath) => /\.d\.[cm]?ts$/u.test(filePath))
  for (const declarationFile of declarationFiles) {
    const relativePath = path.relative(installedDirectory, declarationFile)
    const sourceText = await readFile(declarationFile, 'utf8')
    assert(
      !/^\s*\/\/\/\s*<reference\b/mu.test(sourceText),
      `${packageName}: ${relativePath} contains a triple-slash reference`,
    )
    assert(
      !sourceText.includes('velaros-globals.d.ts'),
      `${packageName}: ${relativePath} references velaros-globals.d.ts`,
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
        throw new Error(`${packageName}: ${relativePath} declares global scope`)
      }
    }

    if (relativePath === path.join('dist', 'internal', 'utility-types.d.ts')) continue
    const imported = importedHelperTypes(sourceFile)
    const locallyDeclared = locallyDeclaredHelperTypes(sourceFile)
    for (const helperName of referencedHelperTypes(sourceFile)) {
      assert(
        imported.has(helperName) || locallyDeclared.has(helperName),
        `${packageName}: ${relativePath} uses ${helperName} without an explicit private module import`,
      )
    }
  }
}

async function assertNoUserSpecificPaths(packageName, installedDirectory) {
  for (const filePath of await collectFiles(installedDirectory)) {
    const contents = await readFile(filePath)
    for (const fragment of forbiddenPublishedPathFragments) {
      assert(
        !contents.includes(Buffer.from(fragment)),
        `${packageName}: published ${path.relative(installedDirectory, filePath)} contains user-specific path fragment ${fragment}`,
      )
    }
  }
}

function assertPublishedDependencyPolicy(manifest) {
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  }
  for (const [name, version] of Object.entries(dependencies)) {
    assert(
      !/^(?:workspace:|file:|link:)/u.test(version),
      `${manifest.name}: published dependency ${name} contains local selector ${version}`,
    )
    if (name === '@velaros-ai/core') {
      assert(version === '^0.4.0', `${manifest.name}: Core floor must be ^0.4.0`)
    }
    if (name === '@velaros-ai/kernel') {
      assert(version === '^0.1.0', `${manifest.name}: Kernel floor must be ^0.1.0`)
    }
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
    assert(!exportKey.includes('*'), `${manifest.name}: wildcard exports require an explicit consumer fixture`)
    await access(path.join(installedDirectory, importTarget), fsConstants.R_OK)
    await access(path.join(installedDirectory, typesTarget), fsConstants.R_OK)
    specifiers.push(exportKey === '.' ? manifest.name : `${manifest.name}/${exportKey.slice(2)}`)
  }
  return [...new Set(specifiers)].sort()
}

async function assertPackedCli(manifest, installedDirectory) {
  const entries = typeof manifest.bin === 'string'
    ? [[manifest.name, manifest.bin]]
    : Object.entries(manifest.bin ?? {})
  for (const [command, target] of entries) {
    const binPath = path.join(installedDirectory, target)
    await access(binPath, fsConstants.R_OK)
    assert(
      ((await stat(binPath)).mode & 0o111) !== 0,
      `${manifest.name}: CLI ${command} is not executable`,
    )
  }
}

function internalDependencyClosure(packageName, packagesByName) {
  const closure = new Set()
  const visit = (name) => {
    if (closure.has(name)) return
    const record = packagesByName.get(name)
    assert(record, `${packageName}: unknown internal dependency ${name}`)
    closure.add(name)
    for (const dependencyName of dependencyNames(record.packedManifest)) {
      if (capabilityPackageNames.has(dependencyName)) visit(dependencyName)
    }
  }
  visit(packageName)
  return [...closure]
}

function requiredKernelPackages(closure, packagesByName) {
  const required = new Set()
  for (const packageName of closure) {
    for (const dependencyName of dependencyNames(packagesByName.get(packageName).packedManifest)) {
      if (kernelPackageSources.has(dependencyName)) required.add(dependencyName)
    }
  }
  return [...required]
}

async function linkExternalDependencies(consumerNodeModules, closure, packagesByName) {
  const externalDependencies = new Map()
  for (const packageName of closure) {
    const record = packagesByName.get(packageName)
    for (const dependencyName of dependencyNames(record.manifest)) {
      if (
        capabilityPackageNames.has(dependencyName)
        || kernelPackageSources.has(dependencyName)
      ) continue
      const source = await installedPackageResolver.resolve(
        dependencyName,
        { declaringPackageDirectories: [record.packageDirectory] },
      )
      externalDependencies.set(dependencyName, source)
    }
  }
  for (const packageDirectory of kernelPackageSources.values()) {
    const manifest = await readJson(path.join(packageDirectory, 'package.json'))
    for (const dependencyName of dependencyNames(manifest)) {
      if (dependencyName.startsWith('@velaros-ai/')) continue
      const source = await installedPackageResolver.resolve(
        dependencyName,
        { declaringPackageDirectories: [packageDirectory] },
      )
      externalDependencies.set(dependencyName, source)
    }
  }
  externalDependencies.set(
    '@types/node',
    await realpath(path.join(repositoryRoot, 'node_modules', '@types', 'node')),
  )

  for (const [dependencyName, source] of externalDependencies) {
    const target = path.join(consumerNodeModules, ...dependencyName.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
  }
}

async function unpack(record, consumerNodeModules) {
  const installedDirectory = path.join(consumerNodeModules, ...record.name.split('/'))
  await mkdir(installedDirectory, { recursive: true })
  run(
    'tar',
    ['-xzf', record.tarballPath, '-C', installedDirectory, '--strip-components=1'],
  )
  return installedDirectory
}

async function createPackageConsumer(record, packagesByName, kernelPackages, consumersRoot) {
  const consumerRoot = await mkdtemp(path.join(consumersRoot, `${record.directoryName}-`))
  const consumerNodeModules = path.join(consumerRoot, 'node_modules')
  const closure = internalDependencyClosure(record.name, packagesByName)
  const requiredKernel = requiredKernelPackages(closure, packagesByName)
  await mkdir(path.join(consumerNodeModules, '@velaros-ai'), { recursive: true })
  await linkExternalDependencies(consumerNodeModules, closure, packagesByName)
  for (const dependencyName of closure) {
    await unpack(packagesByName.get(dependencyName), consumerNodeModules)
  }
  for (const dependencyName of requiredKernel) {
    await unpack(kernelPackages.get(dependencyName), consumerNodeModules)
  }

  for (const dependencyName of requiredKernel) {
    const installedManifest = await readJson(
      path.join(consumerNodeModules, ...dependencyName.split('/'), 'package.json'),
    )
    assert(
      installedManifest.version === expectedKernelVersions.get(dependencyName),
      `${record.name}: expected ${dependencyName}@${expectedKernelVersions.get(dependencyName)}, got ${installedManifest.version}`,
    )
  }

  const installedDirectory = path.join(consumerNodeModules, ...record.name.split('/'))
  const publicSpecifiers = await expandPublicExports(record.packedManifest, installedDirectory)
  await assertPackedCli(record.packedManifest, installedDirectory)
  const imports = publicSpecifiers
    .map((specifier, index) => `import * as api${index} from ${JSON.stringify(specifier)}`)
    .join('\n')
  const consumerTypeFixture = consumerTypeFixtures.get(record.name) ?? ''
  await writeFile(
    path.join(consumerRoot, 'consumer.ts'),
    `${imports}\n${consumerTypeFixture}\nvoid [${publicSpecifiers.map((_, index) => `api${index}`).join(', ')}]\n`,
  )
  await writeFile(
    path.join(consumerRoot, 'runtime.mjs'),
    `for (const specifier of ${JSON.stringify(publicSpecifiers, null, 2)}) {
  await import(specifier)
}
`,
  )
  const portableContractsFixture = portableContractsFixtures.get(record.name)
  if (portableContractsFixture) {
    await writePortableContractsFixture(
      consumerRoot,
      record.name,
      portableContractsFixture,
    )
  }
  await writeFile(
    path.join(consumerRoot, 'package.json'),
    JSON.stringify({
      name: `consumer-${record.directoryName}`,
      private: true,
      type: 'module',
      dependencies: { [record.name]: record.packedManifest.version },
    }, null, 2),
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
      include: ['*.ts'],
    }, null, 2),
  )
  run(
    process.execPath,
    [path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'],
    consumerRoot,
    { stdio: 'inherit' },
  )
  run(process.execPath, ['runtime.mjs'], consumerRoot, { stdio: 'inherit' })
  if (portableContractsFixture) {
    run(
      process.execPath,
      [path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.browser.json'],
      consumerRoot,
      { stdio: 'inherit' },
    )
    run(
      process.execPath,
      [viteCli, 'build', '--config', 'vite.config.mjs'],
      consumerRoot,
      { stdio: 'inherit' },
    )
    await assertPortableContractsBundle(consumerRoot, record.name)
  }
  console.info(`${record.name} isolated tarball consumer passed`)
}

async function writePortableContractsFixture(consumerRoot, packageName, fixture) {
  await writeFile(
    path.join(consumerRoot, 'browser-contracts.ts'),
    fixture.source,
  )
  await writeFile(
    path.join(consumerRoot, 'tsconfig.browser.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      },
      include: ['browser-contracts.ts'],
    }, null, 2),
  )
  await writeFile(
    path.join(consumerRoot, 'vite.config.mjs'),
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
      fileName: ${JSON.stringify(fixture.bundleName)},
    },
    outDir: 'browser-dist',
  },
  plugins: [
    {
      name: 'reject-node-builtins',
      enforce: 'pre',
      resolveId(source) {
        if (NodeBuiltins.has(source) || source === 'execa' || source.startsWith('execa/')) {
          throw new Error(
            \`${packageName}/contracts imported a host dependency: \${source}\`
          )
        }
        return null
      },
    },
  ],
}
`,
  )
}

async function assertPortableContractsBundle(consumerRoot, packageName) {
  const outputDirectory = path.join(consumerRoot, 'browser-dist')
  const outputFiles = await collectFiles(outputDirectory)
  assert(outputFiles.length > 0, `${packageName}/contracts Vite gate emitted no files`)

  for (const outputFile of outputFiles) {
    const output = await readFile(outputFile, 'utf8')
    assert(
      !/(?:__vite-browser-external|from\s*['"]node:|import\s*\(\s*['"]node:)/u.test(
        output,
      ),
      `${packageName}/contracts browser bundle externalized a Node builtin: ${outputFile}`,
    )
  }
  console.info(`${packageName}/contracts Vite browser bundle passed`)
}

async function createUiConflictProbe(consumerRoot) {
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
      exports: { '.': { types: './index.d.ts', import: './index.js' } },
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
  await safePackPackage({
    destination: probePack,
    packageDirectory: probeSource,
  })
  const tarballs = (await readdir(probePack)).filter((entry) => entry.endsWith('.tgz'))
  assert(tarballs.length === 1, 'UI conflict probe must produce exactly one tarball')
  return path.join(probePack, tarballs[0])
}

async function createCombinedConflictConsumer(
  packagesByName,
  kernelPackages,
  consumersRoot,
) {
  const targetName = '@velaros-ai/browser/runtime'
  const targetRecord = packagesByName.get(targetName)
  const consumerRoot = await mkdtemp(path.join(consumersRoot, 'combined-conflict-'))
  const consumerNodeModules = path.join(consumerRoot, 'node_modules')
  const closure = internalDependencyClosure(targetName, packagesByName)
  await mkdir(path.join(consumerNodeModules, '@velaros-ai'), { recursive: true })
  await linkExternalDependencies(consumerNodeModules, closure, packagesByName)
  for (const packageName of closure) {
    await unpack(packagesByName.get(packageName), consumerNodeModules)
  }
  for (const packageName of requiredKernelPackages(closure, packagesByName)) {
    await unpack(kernelPackages.get(packageName), consumerNodeModules)
  }

  const probeTarball = await createUiConflictProbe(consumerRoot)
  const probeInstall = path.join(
    consumerNodeModules,
    '@velaros-ai',
    'ui-conflict-probe',
  )
  await mkdir(probeInstall, { recursive: true })
  run('tar', ['-xzf', probeTarball, '-C', probeInstall, '--strip-components=1'])

  await writeFile(
    path.join(consumerRoot, 'consumer.ts'),
    `import { AppError } from '@velaros-ai/core'
import { BrowserSessionManager } from '${targetName}'
import {
  uiConflictProbe,
  type UiConflictProbe,
} from '@velaros-ai/ui-conflict-probe'

const probe: UiConflictProbe = { value: null, optional: undefined }
void [AppError, BrowserSessionManager, probe, uiConflictProbe]
`,
  )
  await writeFile(
    path.join(consumerRoot, 'runtime.mjs'),
    `await Promise.all([
  import('@velaros-ai/core'),
  import('@velaros-ai/kernel/contracts/abi'),
  import('@velaros-ai/browser/core'),
  import('${targetName}'),
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
  console.info('Core + Kernel SDK + capability + ambient UI tarball consumer passed')
}

async function packPackage(packageDirectory, packedDirectory) {
  const before = new Set(await readdir(packedDirectory))
  await safePackPackage({
    destination: packedDirectory,
    packageDirectory,
  })
  const tarball = (await readdir(packedDirectory)).find(
    (entry) => entry.endsWith('.tgz') && !before.has(entry),
  )
  assert(tarball, `${packageDirectory}: pack did not create exactly one tarball`)
  return path.join(packedDirectory, tarball)
}

const workspace = await mkdtemp(path.join(tmpdir(), 'velaros-capabilities-consumers-'))
const packedDirectory = path.join(workspace, 'packed')
const inspectionRoot = path.join(workspace, 'inspection')
const consumersRoot = path.join(workspace, 'consumers')

try {
  await mkdir(packedDirectory, { recursive: true })
  await mkdir(inspectionRoot, { recursive: true })
  await mkdir(consumersRoot, { recursive: true })
  const packagesByName = new Map()
  const kernelPackages = new Map()

  for (const [name, packageDirectory] of kernelPackageSources) {
    const manifest = await readJson(path.join(packageDirectory, 'package.json'))
    assert(
      manifest.version === expectedKernelVersions.get(name),
      `${name}: expected local version ${expectedKernelVersions.get(name)}, got ${manifest.version}`,
    )
    kernelPackages.set(name, {
      name,
      tarballPath: await packPackage(packageDirectory, packedDirectory),
    })
  }

  for (const expected of CapabilityPackages) {
    const packageDirectory = path.join(packagesRoot, expected.directory)
    const manifest = await readJson(path.join(packageDirectory, 'package.json'))
    assertManifestQuality(manifest, expected.directory)
    await assertDocumentation(packageDirectory, manifest.name)
    const tarballPath = await packPackage(packageDirectory, packedDirectory)
    const inspectionDirectory = path.join(inspectionRoot, expected.directory)
    await mkdir(inspectionDirectory, { recursive: true })
    run(
      'tar',
      ['-xzf', tarballPath, '-C', inspectionDirectory, '--strip-components=1'],
    )
    const packedManifest = await readJson(path.join(inspectionDirectory, 'package.json'))
    assertManifestQuality(packedManifest, expected.directory)
    assertPublishedDependencyPolicy(packedManifest)
    await assertNoAmbientHelperTypes(manifest.name, inspectionDirectory)
    await assertNoUserSpecificPaths(manifest.name, inspectionDirectory)
    await access(path.join(inspectionDirectory, 'README.md'), fsConstants.R_OK)
    packagesByName.set(manifest.name, {
      name: manifest.name,
      directoryName: expected.directory,
      packageDirectory,
      manifest,
      packedManifest,
      tarballPath,
    })
  }

  for (const record of packagesByName.values()) {
    await createPackageConsumer(record, packagesByName, kernelPackages, consumersRoot)
  }
  await createCombinedConflictConsumer(packagesByName, kernelPackages, consumersRoot)
  console.info(`isolated tarball consumers passed: ${packagesByName.size} packages`)
} finally {
  await rm(workspace, { recursive: true, force: true })
}
