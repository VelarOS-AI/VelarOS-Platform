import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'))
const readme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8')

for (const field of ['description', 'license', 'repository']) {
  if (!manifest[field]) throw new Error(`${manifest.name} is missing package.json#${field}`)
}
if (!manifest.engines?.node) throw new Error(`${manifest.name} is missing a Node.js engine range`)
if (manifest.sideEffects === undefined) throw new Error(`${manifest.name} must declare sideEffects`)
if (manifest.publishConfig?.access !== 'public') {
  throw new Error(`${manifest.name} must publish with public access`)
}
if (manifest.publishConfig?.registry !== 'https://npm.pkg.github.com') {
  throw new Error(`${manifest.name} must publish through GitHub Packages`)
}

const privatePackageClaims = [
  /\bprivate\b[^\n]{0,80}@velaros-ai/iu,
  /@velaros-ai[^\n]{0,80}\bprivate\b/iu,
  /私有[^\n]{0,80}@velaros-ai/u,
  /@velaros-ai[^\n]{0,80}私有/u,
]
// 本包是全仓唯一的公开包，最要紧的一条是「别把自己写成私有的」——装不上的人会照文档去申请
// 根本不需要的权限。文档合并成单份中文 README 后（2026-07-30 判决废除 api.zh-CN 与双语 README），
// 这条断言跟着收到 README.md 一处；章节标题不再钉，理由见 scripts/capabilities/check-arch-boundaries.mjs。
for (const pattern of privatePackageClaims) {
  if (pattern.test(readme)) {
    throw new Error('README.md must not describe the public package or scope as private')
  }
}
if (!readme.includes('公开包') || !readme.includes('read:packages')) {
  throw new Error('README.md must document public package visibility and GitHub npm authentication')
}

for (const [publicPath, declaration] of Object.entries(manifest.exports ?? {})) {
  for (const target of readExportTargets(declaration)) {
    try {
      await access(path.join(repositoryRoot, target))
    } catch {
      throw new Error(`${manifest.name} export ${publicPath} points to missing ${target}`)
    }
  }
}

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'velaros-html-consumer-'))
try {
  capture(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', temporaryDirectory],
    repositoryRoot
  )
  const tarballs = (await readdir(temporaryDirectory)).filter((file) => file.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`${manifest.name} produced ${tarballs.length} tarballs`)
  }
  const tarball = path.join(temporaryDirectory, tarballs[0])
  await writeFile(
    path.join(temporaryDirectory, 'package.json'),
    JSON.stringify({ private: true, type: 'module' })
  )
  await writeFile(
    path.join(temporaryDirectory, 'consumer.mjs'),
    Object.keys(manifest.exports)
      .map((publicPath, index) => {
        const specifier =
          publicPath === '.' ? manifest.name : `${manifest.name}/${publicPath.slice(2)}`
        return `import * as entry${index} from ${JSON.stringify(specifier)}\nvoid entry${index}\n`
      })
      .join('')
  )
  await writeFile(
    path.join(temporaryDirectory, 'consumer.ts'),
    Object.keys(manifest.exports)
      .map((publicPath, index) => {
        const specifier =
          publicPath === '.' ? manifest.name : `${manifest.name}/${publicPath.slice(2)}`
        return `import * as Entry${index} from ${JSON.stringify(specifier)}\nvoid Entry${index}\n`
      })
      .join('')
  )
  await writeFile(
    path.join(temporaryDirectory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        lib: ['ES2023', 'DOM', 'DOM.Iterable'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        target: 'ES2023',
      },
      files: ['./consumer.ts'],
    })
  )

  capture(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball],
    temporaryDirectory
  )
  capture(process.execPath, ['./consumer.mjs'], temporaryDirectory)
  capture(
    process.execPath,
    [path.join(repositoryRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    temporaryDirectory
  )

  const packedManifest = JSON.parse(
    await readFile(
      path.join(temporaryDirectory, 'node_modules', ...manifest.name.split('/'), 'package.json'),
      'utf8'
    )
  )
  for (const requiredFile of ['README.md']) {
    await access(
      path.join(
        temporaryDirectory,
        'node_modules',
        ...manifest.name.split('/'),
        requiredFile
      )
    )
  }
  if (packedManifest.version !== manifest.version) {
    throw new Error(`${manifest.name} packed version does not match source manifest`)
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}

console.info(
  'HTML Artifacts package contract: metadata, exports, docs, runtime imports, and strict external types are valid.'
)

function readExportTargets(declaration) {
  if (typeof declaration === 'string') return [declaration]
  if (!declaration || typeof declaration !== 'object') return []
  return Object.values(declaration).filter((value) => typeof value === 'string')
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stdout || ''}\n${result.stderr || ''}`
    )
  }
  return result.stdout.trim()
}
