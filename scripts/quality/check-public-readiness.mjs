#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packageRoot = join(repositoryRoot, 'packages')
const officialRepository = 'https://github.com/VelarOS-AI/VelarOS-Platform.git'
const canonicalIssues = 'https://github.com/VelarOS-AI/VelarOS-Platform/issues'
const requiredPackageNoticeFiles = new Map([
  ['browser', [
    'THIRD_PARTY_NOTICES.md',
    'vendor/devtools-performance-engine/LICENSE.chrome-devtools-frontend',
    'vendor/devtools-performance-engine/LICENSE.chrome-devtools-mcp',
    'vendor/devtools-performance-engine/NOTICE.md',
  ]],
  ['office', [
    'THIRD_PARTY_NOTICES.md',
    'third-party-licenses/pptxgenjs-MIT.txt',
    'vendor/pptxgenjs/README.md',
  ]],
  ['ui', [
    'THIRD_PARTY_NOTICES.md',
    'third-party-licenses/tailwindcss-MIT.txt',
  ]],
])
const ignoredDirectoryNames = new Set([
  '.git',
  '.idea',
  '.turbo',
  '.velaros-workspace',
  '.vite',
  'coverage',
  'demo-dist',
  'dist',
  'dist-document-renderer',
  'node_modules',
  'out',
])
const ignoredRootDirectories = new Set(['release'])
const requiredRootFiles = [
  '.github/CODEOWNERS',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'GOVERNANCE.md',
  'LICENSE',
  'NOTICE',
  'README.md',
  'README.zh-CN.md',
  'SECURITY.md',
  'SUPPORT.md',
  'THIRD_PARTY_NOTICES.md',
]
const forbiddenText = [
  {
    label: 'developer-local macOS user path',
    pattern: /\/Users\/(?!(?:example|plaintext|velaros)(?=\/|[^A-Za-z0-9._-]|$))[^/\s"'`]+/gi,
  },
  { label: 'personal Gmail address', pattern: /\b[A-Z0-9._%+-]+@gmail\.com\b/gi },
  { label: 'retired license metadata', pattern: new RegExp(`\\b${['UN', 'LICENSED'].join('')}\\b`, 'g') },
  {
    label: 'retired split repository URL',
    pattern: /github\.com\/VelarOS-AI\/VelarOS-HTML-Artifacts\b/gi,
  },
  {
    label: 'non-public VelarOS repository URL',
    pattern: /github\.com\/VelarOS-AI\/(?:VelarOS-(?:Cloud|Desktop|Extension|Labs|Termel|Workbench|Workspace|Website)|VelarScript-Website)\b/gi,
  },
  { label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { label: 'OpenAI API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'Slack token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
]
// 文本文件里的原始 C0 控制字符（U+0000–U+001F）只放行制表、换行、回车。原始 NUL 会让 git 把整个
// 文件当成二进制，diff、blame 与代码审查随之失效；其余控制字符同样只会是误写进来的字节。确需这类
// 字符时在源码里写转义序列（`\x1b`、`\0`），JSON 规范本身也禁止字符串里出现原始控制字符——所以这条
// 规则不设白名单。判定按码位比较，本脚本自身不必出现任何控制字符或其转义。
const allowedControlCharacterCodes = new Set([0x09, 0x0a, 0x0d])
const failures = []

function fail(message) {
  failures.push(message)
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function walk(directory, root = repositoryRoot) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name)
    if (
      entry.isDirectory()
      && (
        ignoredDirectoryNames.has(entry.name)
        || (directory === root && ignoredRootDirectories.has(entry.name))
      )
    ) continue
    if (entry.isDirectory()) files.push(...walk(entryPath, root))
    else if (entry.isFile()) files.push(entryPath)
  }
  return files
}

function lineAt(content, index) {
  return content.slice(0, index).split('\n').length
}

/** 文本里第一个不被放行的原始 C0 控制字符：返回位置与码位，没有则返回 undefined。 */
export function findRawControlCharacter(content) {
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index)
    if (code < 0x20 && !allowedControlCharacterCodes.has(code)) return { index, code }
  }
  return undefined
}

function isTextFile(filePath) {
  const extension = extname(filePath).toLowerCase()
  if (
    new Set([
      '.cjs', '.css', '.html', '.js', '.json', '.jsonl', '.jsx', '.md', '.mjs',
      '.py', '.scss', '.sh', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
    ]).has(extension)
  ) {
    return true
  }
  return ['.gitignore', '.npmrc'].includes(basename(filePath))
}

function checkRootFiles() {
  for (const file of requiredRootFiles) {
    if (!existsSync(join(repositoryRoot, file))) fail(`missing required root file: ${file}`)
  }

  const readme = readFileSync(join(repositoryRoot, 'README.md'), 'utf8')
  const chineseReadme = readFileSync(join(repositoryRoot, 'README.zh-CN.md'), 'utf8')
  const governance = readFileSync(join(repositoryRoot, 'GOVERNANCE.md'), 'utf8')
  const codeowners = readFileSync(join(repositoryRoot, '.github/CODEOWNERS'), 'utf8')
  if (!readme.includes('public source repository for VelarOS Platform')) {
    fail('README.md does not identify the repository as public source')
  }
  if (!chineseReadme.includes('VelarOS Platform 的公开源码仓库')) {
    fail('README.zh-CN.md does not identify the repository as public source')
  }
  if (!governance.includes('[Error-Zhang](https://github.com/Error-Zhang)')) {
    fail('GOVERNANCE.md does not publish the current maintainer roster')
  }
  if (!/^\*\s+@Error-Zhang\s*$/mu.test(codeowners)) {
    fail('.github/CODEOWNERS does not assign the public maintainer')
  }

  const pptxPatchRecord = readFileSync(
    join(repositoryRoot, 'packages/office/vendor/pptxgenjs/README.md'),
    'utf8',
  )
  for (const marker of ['reviewed local security patches', "UUID helper's", 'relationship paths']) {
    if (!pptxPatchRecord.includes(marker)) {
      fail(`PptxGenJS public patch record is missing: ${marker}`)
    }
  }
}

function checkPackageMetadata() {
  const rootManifest = readJson(join(repositoryRoot, 'package.json'))
  const expectedDirectories = new Set(
    Object.values(rootManifest.velaros?.domainPackages ?? {}).flat(),
  )
  const actualDirectories = new Set(
    readdirSync(packageRoot)
      .filter((directory) => existsSync(join(packageRoot, directory, 'package.json'))),
  )

  for (const directory of expectedDirectories) {
    if (!actualDirectories.has(directory)) fail(`registered package is missing: packages/${directory}`)
  }
  for (const directory of actualDirectories) {
    if (!expectedDirectories.has(directory)) fail(`unregistered package exists: packages/${directory}`)
  }

  if (rootManifest.private !== true) fail('root workspace must remain private to prevent accidental publication')
  if (rootManifest.license !== 'Apache-2.0') fail('root license must be Apache-2.0')
  if (rootManifest.repository?.url !== officialRepository) fail('root repository URL is not canonical')

  const rootLicense = readFileSync(join(repositoryRoot, 'LICENSE'), 'utf8')
  for (const directory of [...expectedDirectories].sort()) {
    const directoryPath = join(packageRoot, directory)
    const manifest = readJson(join(directoryPath, 'package.json'))
    const label = manifest.name ?? `packages/${directory}`
    const publishable = manifest.private !== true
    const expectedHomepage = `https://github.com/VelarOS-AI/VelarOS-Platform/tree/main/packages/${directory}#readme`
    const licensePath = join(directoryPath, 'LICENSE')
    const noticePath = join(directoryPath, 'NOTICE')

    if (manifest.name !== `@velaros-ai/${directory}`) fail(`${label}: package name does not match its directory`)
    if (manifest.license !== 'Apache-2.0') fail(`${label}: license must be Apache-2.0`)
    if (publishable && manifest.publishConfig?.access !== 'public') fail(`${label}: publish access must be public`)
    if (publishable && manifest.publishConfig?.registry !== 'https://npm.pkg.github.com') fail(`${label}: registry is not canonical`)
    if (manifest.repository?.url !== rootManifest.repository.url) fail(`${label}: repository URL is not canonical`)
    if (manifest.repository?.directory !== `packages/${directory}`) fail(`${label}: repository directory is not canonical`)
    if (publishable && manifest.homepage !== expectedHomepage) fail(`${label}: homepage is not canonical`)
    if (publishable && manifest.bugs?.url !== canonicalIssues) fail(`${label}: issue tracker is not canonical`)
    if (!manifest.files?.includes('LICENSE')) fail(`${label}: package files do not include LICENSE`)
    if (!manifest.files?.includes('NOTICE')) fail(`${label}: package files do not include NOTICE`)
    if (!existsSync(join(directoryPath, 'README.md'))) fail(`${label}: README.md is missing`)
    if (!existsSync(licensePath)) fail(`${label}: LICENSE is missing`)
    else if (readFileSync(licensePath, 'utf8') !== rootLicense) fail(`${label}: LICENSE differs from the root license`)
    if (!existsSync(noticePath)) fail(`${label}: NOTICE is missing`)
    else if (!readFileSync(noticePath, 'utf8').includes('Copyright 2026 VelarOS-AI contributors')) {
      fail(`${label}: NOTICE is missing the project attribution`)
    }

    for (const noticeFile of requiredPackageNoticeFiles.get(directory) ?? []) {
      const topLevelEntry = noticeFile.split('/', 1)[0]
      if (!existsSync(join(directoryPath, noticeFile))) {
        fail(`${label}: required third-party notice file is missing (${noticeFile})`)
      }
      if (!manifest.files?.includes(topLevelEntry)) {
        fail(`${label}: package files do not ship ${topLevelEntry}`)
      }
    }
  }

  for (const noticeFile of [
    'third-party-licenses/buffers-0.1.1-MIT.txt',
    'third-party-licenses/dependency-license-overrides.json',
    'packages/ui/third-party-licenses/tailwindcss-MIT.txt',
  ]) {
    if (!existsSync(join(repositoryRoot, noticeFile))) {
      fail(`missing third-party license text: ${noticeFile}`)
    }
  }
}

function checkRuntimeDependencyOwnership() {
  const runtimeSections = ['dependencies', 'optionalDependencies']
  const capabilityDirectories = readdirSync(packageRoot)
    .filter((directory) => existsSync(join(packageRoot, directory, 'package.json')))

  for (const directory of capabilityDirectories) {
    const manifest = readJson(join(packageRoot, directory, 'package.json'))
    if (manifest.name !== '@velaros-ai/agent') {
      for (const section of runtimeSections) {
        if (manifest[section]?.['@velaros-ai/agent']) {
          fail(
            `${manifest.name}: @velaros-ai/agent must be a peer owned by the host, not a private ${section} runtime`,
          )
        }
      }
    }

    for (const section of runtimeSections) {
      for (const dependency of Object.keys(manifest[section] ?? {})) {
        if (/^(?:@huggingface\/transformers|onnxruntime(?:-|$))/u.test(dependency)) {
          fail(`${manifest.name}: optional inference stack must not be a bundled ${section} dependency (${dependency})`)
        }
      }
    }
  }

  const memoryManifest = readJson(join(packageRoot, 'memory', 'package.json'))
  if (memoryManifest.peerDependencies?.['@lancedb/lancedb'] !== '^0.27.2') {
    fail('@velaros-ai/memory: LanceDB must remain an injected peer runtime')
  }
  for (const section of runtimeSections) {
    if (memoryManifest[section]?.['@lancedb/lancedb']) {
      fail(`@velaros-ai/memory: LanceDB must not be installed through ${section}`)
    }
  }

  const cliManifest = readJson(join(packageRoot, 'cli', 'package.json'))
  for (const dependency of ['@velaros-ai/remote-host', '@velaros-ai/serve-host']) {
    for (const section of [...runtimeSections, 'peerDependencies']) {
      if (cliManifest[section]?.[dependency]) {
        fail(`@velaros-ai/cli: retired host ${dependency} must not return through ${section}`)
      }
    }
  }

  const rendererManifest = readJson(join(packageRoot, 'document-renderer', 'package.json'))
  for (const dependency of ['@napi-rs/canvas', 'pdfjs-dist']) {
    for (const section of [...runtimeSections, 'peerDependencies']) {
      if (rendererManifest[section]?.[dependency]) {
        fail(
          `@velaros-ai/document-renderer: ${dependency} belongs to @velaros-ai/office and must not be duplicated in ${section}`,
        )
      }
    }
  }
}

/** 扫描 root 下的文本文件，返回禁用文本与原始控制字符的违规描述；测试用临时目录作 root。 */
export function collectTextHygieneFailures(root = repositoryRoot) {
  const hygieneFailures = []
  for (const filePath of walk(root, root).filter(isTextFile)) {
    const content = readFileSync(filePath, 'utf8')
    const displayPath = relative(root, filePath)
    for (const { label, pattern } of forbiddenText) {
      pattern.lastIndex = 0
      const match = pattern.exec(content)
      if (!match) continue
      if (/^gh[pousr]_x+$/i.test(match[0])) continue
      hygieneFailures.push(`${displayPath}:${lineAt(content, match.index)}: ${label}`)
    }
    const controlCharacter = findRawControlCharacter(content)
    if (controlCharacter) {
      const codePoint = controlCharacter.code.toString(16).toUpperCase().padStart(4, '0')
      hygieneFailures.push(
        `${displayPath}:${lineAt(content, controlCharacter.index)}: raw control character U+${codePoint} (only tab, LF and CR are allowed)`,
      )
    }
  }
  return hygieneFailures
}

function checkTextHygiene() {
  for (const failure of collectTextHygieneFailures()) fail(failure)
}

function resolveMarkdownTarget(markdownPath, rawTarget) {
  const target = rawTarget.trim().replace(/^<|>$/g, '').split('#', 1)[0].split('?', 1)[0]
  if (!target || /^(?:[a-z]+:|\/)/i.test(target)) return undefined
  try {
    return resolve(dirname(markdownPath), decodeURIComponent(target))
  } catch {
    return resolve(dirname(markdownPath), target)
  }
}

function checkMarkdownLinks() {
  for (const markdownPath of walk(repositoryRoot).filter((file) => extname(file) === '.md')) {
    const content = readFileSync(markdownPath, 'utf8')
    const scannableContent = content.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ' '))
    for (const match of scannableContent.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = resolveMarkdownTarget(markdownPath, match[1])
      if (!target || existsSync(target)) continue
      const line = content.slice(0, match.index).split('\n').length
      fail(`${relative(repositoryRoot, markdownPath)}:${line}: broken relative link (${match[1]})`)
    }
  }
}

function run() {
  checkRootFiles()
  checkPackageMetadata()
  checkRuntimeDependencyOwnership()
  checkTextHygiene()
  checkMarkdownLinks()

  if (failures.length) {
    console.error(`Public-readiness check failed with ${failures.length} issue(s):`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
  } else {
    console.log('Public-readiness check passed.')
  }
}

// 只在直接执行时跑门；测试 import 本模块时只取导出的判定函数。两侧都取 realpath：经软链路径执行时
// import.meta.url 已被解析成真实路径，只比 resolve 的结果会让门什么都不跑就以 0 退出。
const invokedPath = process.argv[1] ? realpathSync(resolve(process.argv[1])) : undefined
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) run()
