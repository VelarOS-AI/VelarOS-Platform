import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const requiredDocumentSections = [
  '定位与非目标',
  '安装',
  '公共入口',
  '核心类与接口',
  '生命周期/并发',
  '依赖注入',
  '错误模型',
  '最小第三方示例',
  '扩展点',
  '兼容策略',
]
const utilityTypeModule = '@velaros-ai/ui/utility-types'
const utilityTypeNames = [
  'JsonStringifyReplacer',
  'JsonStringifyReplacerValue',
  'LooseOptional',
  'Nullable',
  'Nullish',
  'PlainObject',
]

for (const packageName of ['ui', 'conversation-ui']) {
  await verifyPackage(path.join(repositoryRoot, 'packages', packageName))
}
await verifyExternalConsumer()

console.info(
  'UI package contracts: metadata, exports, docs, strict external types, and browser bundles are valid.'
)

async function verifyPackage(packageDirectory) {
  const manifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'))
  for (const field of ['description', 'license', 'repository']) {
    if (!manifest[field]) throw new Error(`${manifest.name} is missing package.json#${field}`)
  }
  if (!manifest.engines?.node) throw new Error(`${manifest.name} is missing a Node.js engine range`)
  if (manifest.sideEffects === undefined) {
    throw new Error(`${manifest.name} must declare package.json#sideEffects`)
  }
  if (!manifest.files?.includes('docs')) throw new Error(`${manifest.name} does not publish docs`)

  const apiDocument = path.join(packageDirectory, 'docs/api.zh-CN.md')
  const documentation = await readFile(apiDocument, 'utf8')
  for (const section of requiredDocumentSections) {
    if (!documentation.includes(`## ${section}`)) {
      throw new Error(`${manifest.name} API documentation is missing "${section}"`)
    }
  }
  const readme = await readFile(path.join(packageDirectory, 'README.md'), 'utf8')
  if (!readme.includes('./docs/api.zh-CN.md')) {
    throw new Error(`${manifest.name} README must link the Chinese API documentation`)
  }

  for (const [publicPath, declaration] of Object.entries(manifest.exports ?? {})) {
    for (const target of readExportTargets(declaration)) {
      if (target.includes('*')) continue
      try {
        await access(path.join(packageDirectory, target))
      } catch {
        throw new Error(`${manifest.name} export ${publicPath} points to missing ${target}`)
      }
    }
  }
  await assertModuleScopedUtilityTypes(packageDirectory)

  const temporary = await mkdtemp(path.join(tmpdir(), 'velaros-ui-contract-'))
  try {
    capture('bun', ['pm', 'pack', '--destination', temporary, '--ignore-scripts'], packageDirectory)
    const tarballs = (await readdir(temporary)).filter((file) => file.endsWith('.tgz'))
    if (tarballs.length !== 1) {
      throw new Error(`${manifest.name} produced ${tarballs.length} tarballs`)
    }
    const files = capture('tar', ['-tzf', path.join(temporary, tarballs[0])], packageDirectory)
    if (files.split('\n').includes('package/dist/velaros-globals.d.ts')) {
      throw new Error(`${manifest.name} tarball leaks dist/velaros-globals.d.ts`)
    }
    for (const requiredFile of ['package/package.json', 'package/README.md', 'package/docs/api.zh-CN.md']) {
      if (!files.split('\n').includes(requiredFile)) {
        throw new Error(`${manifest.name} tarball is missing ${requiredFile}`)
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function verifyExternalConsumer() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'velaros-ui-consumer-'))
  try {
    const packageTarballs = []
    for (const packageName of ['ui', 'conversation-ui']) {
      const packageDirectory = path.join(repositoryRoot, 'packages', packageName)
      capture(
        'bun',
        ['pm', 'pack', '--destination', temporary, '--ignore-scripts'],
        packageDirectory
      )
    }
    for (const file of await readdir(temporary)) {
      if (file.endsWith('.tgz')) packageTarballs.push(path.join(temporary, file))
    }
    if (packageTarballs.length !== 2) {
      throw new Error(`Expected two UI tarballs, received ${packageTarballs.length}`)
    }
    const installTargets = [
      ...packageTarballs,
      ...(await packLocalHtmlArtifactsDependency(temporary)),
    ]

    await writeFile(
      path.join(temporary, 'package.json'),
      `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`
    )
    await writeFile(
      path.join(temporary, '.npmrc'),
      [
        '@velaros-ai:registry=https://npm.pkg.github.com',
        '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}',
        '',
      ].join('\n')
    )
    capture(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        ...installTargets,
        '@types/react@^19.0.0',
        '@types/react-dom@^19.0.0',
      ],
      temporary
    )
    await writeFile(
      path.join(temporary, 'consumer.tsx'),
      [
        "import * as UI from '@velaros-ai/ui'",
        "import * as Conversation from '@velaros-ai/conversation-ui'",
        ...(await buildEveryExportTypeImports()),
        "import { ToolCallBlock, ToolRendererRegistry } from '@velaros-ai/conversation-ui/tool-render'",
        "import type { ChatStreamEvent, ToolCallBlock as ToolCall } from '@velaros-ai/conversation-ui/contracts'",
        "import type { ChatStreamPacerOptions } from '@velaros-ai/conversation-ui/stream'",
        'const registry = new ToolRendererRegistry()',
        'const block = null as unknown as ToolCall',
        'const options = null as unknown as ChatStreamPacerOptions<ChatStreamEvent>',
        'void UI',
        'void Conversation',
        'void options',
        'void <ToolCallBlock block={block} registry={registry} />',
        '',
      ].join('\n')
    )
    await writeFile(
      path.join(temporary, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: {
            jsx: 'react-jsx',
            lib: ['ESNext', 'DOM', 'DOM.Iterable'],
            module: 'ESNext',
            moduleResolution: 'Bundler',
            noEmit: true,
            skipLibCheck: false,
            strict: true,
            target: 'ES2023',
          },
          files: ['./consumer.tsx'],
        },
        null,
        2
      )}\n`
    )
    capture(
      process.execPath,
      [path.join(repositoryRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
      temporary
    )
    capture(
      'bun',
      [
        'build',
        'consumer.tsx',
        '--target',
        'browser',
        '--format',
        'esm',
        '--external',
        'react',
        '--external',
        'react-dom',
        '--external',
        'react/jsx-runtime',
        '--outdir',
        'bundle',
      ],
      temporary
    )
    capture(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "await import('@velaros-ai/conversation-ui/contracts'); await import('@velaros-ai/conversation-ui/stream')",
      ],
      temporary
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function packLocalHtmlArtifactsDependency(destination) {
  const packageDirectory = path.join(
    path.dirname(repositoryRoot),
    'VelarOS-HTML-Artifacts'
  )
  try {
    await access(path.join(packageDirectory, 'package.json'))
  } catch {
    return []
  }

  const manifest = JSON.parse(
    await readFile(path.join(packageDirectory, 'package.json'), 'utf8')
  )
  const conversationManifest = JSON.parse(
    await readFile(
      path.join(repositoryRoot, 'packages/conversation-ui/package.json'),
      'utf8'
    )
  )
  const requiredVersion =
    conversationManifest.dependencies?.['@velaros-ai/html-artifacts']
  const normalizedRequiredVersion = requiredVersion?.replace(/^[~^]/u, '')
  if (
    manifest.name !== '@velaros-ai/html-artifacts' ||
    manifest.version !== normalizedRequiredVersion
  ) {
    throw new Error(
      `Local HTML Artifacts package ${manifest.name}@${manifest.version} does not satisfy ${requiredVersion}`
    )
  }

  const before = new Set(await readdir(destination))
  capture(
    'bun',
    ['pm', 'pack', '--destination', destination, '--ignore-scripts'],
    packageDirectory
  )
  const created = (await readdir(destination)).filter(
    (file) => file.endsWith('.tgz') && !before.has(file)
  )
  if (created.length !== 1) {
    throw new Error(
      `Expected one local HTML Artifacts tarball, received ${created.length}`
    )
  }
  return created.map((file) => path.join(destination, file))
}

async function buildEveryExportTypeImports() {
  const imports = []
  let index = 0
  for (const packageName of ['ui', 'conversation-ui']) {
    const packageDirectory = path.join(repositoryRoot, 'packages', packageName)
    const packageManifest = JSON.parse(
      await readFile(path.join(packageDirectory, 'package.json'), 'utf8')
    )
    for (const [publicPath, conditions] of Object.entries(packageManifest.exports ?? {})) {
      const typeTarget =
        typeof conditions === 'string'
          ? conditions.endsWith('.d.ts')
            ? conditions
            : undefined
          : conditions?.types
      if (!typeTarget) continue
      const specifier =
        publicPath === '.'
          ? packageManifest.name
          : `${packageManifest.name}/${publicPath.slice(2)}`
      imports.push(`import type * as Export${index} from ${JSON.stringify(specifier)}`)
      index += 1
    }
  }
  return imports
}

async function assertModuleScopedUtilityTypes(packageDirectory) {
  const declarations = await collectFiles(path.join(packageDirectory, 'dist'), '.d.ts')
  for (const declaration of declarations) {
    if (declaration.endsWith(`${path.sep}types${path.sep}utilityTypes.d.ts`)) continue
    const sourceText = await readFile(declaration, 'utf8')
    if (sourceText.includes('velaros-globals.d.ts') || sourceText.includes('declare global')) {
      throw new Error(
        `${path.relative(packageDirectory, declaration)} leaks ambient utility types`
      )
    }
    const importLine =
      sourceText
        .split('\n')
        .find((line) => line.includes(`from '${utilityTypeModule}'`)) ?? ''
    const declarationBody = sourceText.replace(importLine, '')
    for (const typeName of utilityTypeNames) {
      if (
        new RegExp(`\\b${typeName}\\b`, 'u').test(declarationBody) &&
        !new RegExp(`\\b${typeName}\\b`, 'u').test(importLine)
      ) {
        throw new Error(
          `${path.relative(packageDirectory, declaration)} uses ${typeName} without a module import`
        )
      }
    }
  }
}

async function collectFiles(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name)
      return entry.isDirectory()
        ? collectFiles(entryPath, suffix)
        : Promise.resolve(entryPath.endsWith(suffix) ? [entryPath] : [])
    })
  )
  return files.flat()
}

function readExportTargets(declaration) {
  if (typeof declaration === 'string') return [declaration]
  if (!declaration || typeof declaration !== 'object') return []
  return Object.values(declaration).filter((value) => typeof value === 'string')
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env })
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join('\n')
      .trim()
    throw new Error(`${command} ${args.join(' ')} failed:\n${output}`)
  }
  return result.stdout.trim()
}
