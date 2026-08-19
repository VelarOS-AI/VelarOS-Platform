#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packageRoot = join(repositoryRoot, 'packages')
const canonicalRepository = 'git+https://github.com/VelarOS-AI/VelarOS-Platform.git'
const canonicalIssues = 'https://github.com/VelarOS-AI/VelarOS-Platform/issues'
const ignoredDirectories = new Set([
  '.git',
  '.idea',
  '.turbo',
  '.velaros-workspace',
  '.vite',
  'coverage',
  'demo-dist',
  'dist',
  'node_modules',
  'out',
])
const requiredRootFiles = [
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
  { label: 'developer-local workspace path', pattern: /\/Users\/mac\/WebstormProjects\//g },
  { label: 'private author email', pattern: /zhenglian0906@gmail\.com/gi },
  { label: 'retired license metadata', pattern: new RegExp(`\\b${['UN', 'LICENSED'].join('')}\\b`, 'g') },
  {
    label: 'retired split repository URL',
    pattern: /github\.com\/VelarOS-AI\/VelarOS-HTML-Artifacts\b/gi,
  },
  { label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { label: 'OpenAI API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'Slack token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
]
const failures = []

function fail(message) {
  failures.push(message)
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function walk(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(entryPath))
    else if (entry.isFile()) files.push(entryPath)
  }
  return files
}

function isTextFile(filePath) {
  const extension = extname(filePath).toLowerCase()
  if (
    new Set([
      '.cjs', '.css', '.html', '.js', '.json', '.jsonl', '.jsx', '.md', '.mjs',
      '.scss', '.sh', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml',
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
  if (rootManifest.repository?.url !== canonicalRepository) fail('root repository URL is not canonical')

  const rootLicense = readFileSync(join(repositoryRoot, 'LICENSE'), 'utf8')
  for (const directory of [...expectedDirectories].sort()) {
    const directoryPath = join(packageRoot, directory)
    const manifest = readJson(join(directoryPath, 'package.json'))
    const label = manifest.name ?? `packages/${directory}`
    const publishable = manifest.private !== true
    const expectedHomepage = `https://github.com/VelarOS-AI/VelarOS-Platform/tree/main/packages/${directory}#readme`
    const licensePath = join(directoryPath, 'LICENSE')

    if (manifest.name !== `@velaros-ai/${directory}`) fail(`${label}: package name does not match its directory`)
    if (manifest.license !== 'Apache-2.0') fail(`${label}: license must be Apache-2.0`)
    if (publishable && manifest.publishConfig?.access !== 'public') fail(`${label}: publish access must be public`)
    if (publishable && manifest.publishConfig?.registry !== 'https://npm.pkg.github.com') fail(`${label}: registry is not canonical`)
    if (manifest.repository?.url !== canonicalRepository) fail(`${label}: repository URL is not canonical`)
    if (manifest.repository?.directory !== `packages/${directory}`) fail(`${label}: repository directory is not canonical`)
    if (publishable && manifest.homepage !== expectedHomepage) fail(`${label}: homepage is not canonical`)
    if (publishable && manifest.bugs?.url !== canonicalIssues) fail(`${label}: issue tracker is not canonical`)
    if (!manifest.files?.includes('LICENSE')) fail(`${label}: package files do not include LICENSE`)
    if (!existsSync(join(directoryPath, 'README.md'))) fail(`${label}: README.md is missing`)
    if (!existsSync(licensePath)) fail(`${label}: LICENSE is missing`)
    else if (readFileSync(licensePath, 'utf8') !== rootLicense) fail(`${label}: LICENSE differs from the root license`)
  }
}

function checkTextHygiene() {
  for (const filePath of walk(repositoryRoot).filter(isTextFile)) {
    const content = readFileSync(filePath, 'utf8')
    const displayPath = relative(repositoryRoot, filePath)
    for (const { label, pattern } of forbiddenText) {
      pattern.lastIndex = 0
      const match = pattern.exec(content)
      if (!match) continue
      if (/^gh[pousr]_x+$/i.test(match[0])) continue
      const line = content.slice(0, match.index).split('\n').length
      fail(`${displayPath}:${line}: ${label}`)
    }
  }
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

checkRootFiles()
checkPackageMetadata()
checkTextHygiene()
checkMarkdownLinks()

if (failures.length) {
  console.error(`Public-readiness check failed with ${failures.length} issue(s):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('Public-readiness check passed.')
}
