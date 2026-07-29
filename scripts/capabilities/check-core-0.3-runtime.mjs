import { existsSync } from 'node:fs'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const packagesRoot = join(repositoryRoot, 'packages')
const removedCoreModules = [
  'CommandExecutionPolicy',
  'PathContainmentHelper',
  'PlatformCompatibilityHelper',
  'SystemProcessParsers',
]
const forbiddenImportPatterns = [
  /@velaros-ai\/core\/utils\/(?:CommandExecutionPolicy|PathContainmentHelper|PlatformCompatibilityHelper|SystemProcessParsers)/,
  /\bappResourceRuntime\b/,
]

function fail(message) {
  throw new Error(`Core 0.3 compatibility gate failed: ${message}`)
}

async function packageDirectories() {
  const entries = await readdir(packagesRoot, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, 'package.json')))
    .map((entry) => join(packagesRoot, entry.name))
    .sort()
}

async function resolveCoreRoot(packageDirs) {
  const configured = process.env.VELAROS_CORE_0_3_DIR?.trim()
  if (configured) return realpath(resolve(configured))

  for (const packageDir of packageDirs) {
    const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
    if (!packageJson.dependencies?.['@velaros-ai/core']) continue
    const coreEntry = fileURLToPath(
      import.meta.resolve('@velaros-ai/core', pathToFileURL(join(packageDir, 'package.json')).href)
    )
    return realpath(resolve(dirname(coreEntry), '..'))
  }
  fail('no package resolves @velaros-ai/core')
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${result.status}`)
}

async function collectFiles(root, output = []) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) await collectFiles(path, output)
    else if (/\.(?:[cm]?js|d\.ts|ts|tsx)$/.test(entry.name)) output.push(path)
  }
  return output
}

const packageDirs = await packageDirectories()
const coreRoot = await resolveCoreRoot(packageDirs)
const coreManifest = JSON.parse(await readFile(join(coreRoot, 'package.json'), 'utf8'))
if (!/^0\.3\./.test(coreManifest.version)) {
  fail(`expected Core 0.3.x, resolved ${coreManifest.version ?? '<unknown>'} at ${coreRoot}`)
}
if (!existsSync(join(coreRoot, 'dist', 'index.js'))) fail(`Core dist is missing at ${coreRoot}`)

for (const removedModule of removedCoreModules) {
  for (const extension of ['js', 'd.ts']) {
    if (existsSync(join(coreRoot, 'dist', 'utils', `${removedModule}.${extension}`))) {
      fail(`removed Core module still exists: dist/utils/${removedModule}.${extension}`)
    }
  }
}

for (const packageDir of packageDirs) {
  const packageJsonPath = join(packageDir, 'package.json')
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  if (!packageJson.dependencies?.['@velaros-ai/core']) continue
  const coreEntry = fileURLToPath(
    import.meta.resolve('@velaros-ai/core', pathToFileURL(packageJsonPath).href)
  )
  const resolvedRoot = await realpath(resolve(dirname(coreEntry), '..'))
  if (resolvedRoot !== coreRoot) {
    fail(`${packageJson.name} resolves Core from ${resolvedRoot}, expected ${coreRoot}`)
  }
}

run('bun', ['run', 'build'])
run('bun', ['run', 'typecheck'])

for (const packageDir of packageDirs) {
  for (const sourceRoot of [join(packageDir, 'src'), join(packageDir, 'dist')]) {
    if (!existsSync(sourceRoot)) continue
    for (const file of await collectFiles(sourceRoot)) {
      const source = await readFile(file, 'utf8')
      for (const pattern of forbiddenImportPatterns) {
        if (pattern.test(source)) fail(`forbidden Core 0.2 semantic import in ${relative(repositoryRoot, file)}`)
      }
    }
  }
}

for (const packageDir of packageDirs) {
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  const entry = packageJson.main ?? packageJson.exports?.['.']?.import
  if (!entry) fail(`${packageJson.name} has no runtime entry`)
  await import(pathToFileURL(resolve(packageDir, entry)).href)
}

const browserCore = await import(pathToFileURL(join(packagesRoot, 'browser-core', 'dist', 'index.js')).href)
const workspace = await import(pathToFileURL(join(packagesRoot, 'workspace', 'dist', 'index.js')).href)
const system = await import(pathToFileURL(join(packagesRoot, 'system-tools', 'dist', 'index.js')).href)
if (browserCore.getRelativePathInsideRoot('/tmp/root', '/tmp/root/file') !== 'file') {
  fail('browser path-containment runtime smoke failed')
}
if (workspace.getRelativePathInsideWorkspaceRoot('/tmp/root', '/tmp/root/file') !== 'file') {
  fail('workspace path-containment runtime smoke failed')
}
if (!system.analyzeCommandExecution('pwd').isReadOnly) {
  fail('system command-policy runtime smoke failed')
}

console.log(`Core 0.3 compile/runtime compatibility passed with ${coreRoot}`)
