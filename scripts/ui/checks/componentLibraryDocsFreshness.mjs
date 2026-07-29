// 用途：检查组件库公开 API、文档和示例是否保持同步。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = findProjectRoot(SCRIPT_DIR)
const TSCONFIG_PATH = resolve(ROOT_DIR, 'packages/ui/tsconfig.json')
const COMPONENT_LIBRARY_DIR = resolve(ROOT_DIR, 'component-library/src/componentLibrary')
const REGISTRY_ENTRIES_DIR = resolve(COMPONENT_LIBRARY_DIR, 'registry/entries')
const EXAMPLES_DIR = resolve(COMPONENT_LIBRARY_DIR, 'examples')
const INTERACTIVE_DEMOS_DIR = resolve(COMPONENT_LIBRARY_DIR, 'interactive-demos')
const GENERATED_API_PATH = resolve(COMPONENT_LIBRARY_DIR, 'generated/componentApi.generated.ts')
const UI_PACKAGE_SOURCE = realpathSync(resolve(ROOT_DIR, 'packages/ui/src'))
const PUBLIC_INDEX_FILES = [resolve(UI_PACKAGE_SOURCE, 'index.ts')]
const EXTRA_PUBLIC_COMPONENT_NAMES = new Set()
const SCAN_ROOTS = [UI_PACKAGE_SOURCE]
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])
const DOC_IMPORT_EXTENSIONS = ['.tsx', '.ts', '.md', '.mdx']

function findProjectRoot(startDir) {
  let currentDir = startDir

  while (true) {
    if (
      existsSync(resolve(currentDir, 'package.json')) &&
      existsSync(resolve(currentDir, 'packages/ui/src'))
    ) {
      return currentDir
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      throw new Error(`Unable to locate project root from ${startDir}`)
    }

    currentDir = parentDir
  }
}

function normalizePath(filePath) {
  return filePath.split(sep).join('/')
}

function toRepoPath(filePath) {
  return normalizePath(relative(ROOT_DIR, filePath))
}

function isInsideDirectory(filePath, directoryPath) {
  const normalizedFile = normalizePath(filePath)
  const normalizedDirectory = normalizePath(directoryPath)

  return (
    normalizedFile === normalizedDirectory || normalizedFile.startsWith(`${normalizedDirectory}/`)
  )
}

function collectSourceFiles(dir) {
  if (!existsSync(dir)) {
    return []
  }

  const entries = readdirSync(dir)
  const files = []

  for (const entry of entries) {
    const fullPath = resolve(dir, entry)
    const stats = statSync(fullPath)

    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(fullPath))
      continue
    }

    if (SOURCE_EXTENSIONS.has(extname(fullPath))) {
      files.push(fullPath)
    }
  }

  return files
}

function readProgram() {
  const config = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile)
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  }

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT_DIR)
  const analysisOptions = {
    ...parsed.options,
    paths: {
      ...parsed.options.paths,
      '@velaros-ai/ui': ['packages/ui/src/index.ts'],
      '@velaros-ai/ui/*': ['packages/ui/src/*'],
    },
  }
  const program = ts.createProgram(
    [...parsed.fileNames, ...SCAN_ROOTS.flatMap(collectSourceFiles)],
    analysisOptions
  )

  return { program, checker: program.getTypeChecker() }
}

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: ROOT_DIR,
    encoding: 'utf-8',
    ...options,
  })

  return result
}

function assertGitRepository() {
  const result = runGit(['rev-parse', '--is-inside-work-tree'])
  return result.status === 0 && result.stdout.trim() === 'true'
}

function getBaseRef() {
  const args = process.argv.slice(2)
  const baseIndex = args.findIndex((arg) => arg === '--base')
  const inlineBaseArg = args.find((arg) => arg.startsWith('--base='))

  if (inlineBaseArg) {
    return inlineBaseArg.slice('--base='.length)
  }

  if (baseIndex >= 0 && args[baseIndex + 1]) {
    return args[baseIndex + 1]
  }

  if (process.env.COMPONENT_LIBRARY_DOCS_BASE) {
    return process.env.COMPONENT_LIBRARY_DOCS_BASE
  }

  const githubBaseRef = process.env.GITHUB_BASE_REF
  if (githubBaseRef) {
    const detectedBase = detectMergeBase([
      `origin/${githubBaseRef}`,
      `refs/remotes/origin/${githubBaseRef}`,
      githubBaseRef,
    ])

    if (detectedBase) {
      return detectedBase
    }
  }

  return process.env.COMPONENT_LIBRARY_DOCS_BASE || 'HEAD'
}

function detectMergeBase(candidates) {
  for (const candidate of candidates) {
    const exists = runGit(['rev-parse', '--verify', '--quiet', candidate])
    if (exists.status !== 0) {
      continue
    }

    const mergeBase = runGit(['merge-base', 'HEAD', candidate])
    if (mergeBase.status === 0 && mergeBase.stdout.trim()) {
      return mergeBase.stdout.trim()
    }

    return candidate
  }

  return null
}

function parseNameStatusLine(line) {
  const parts = line.split('\t').filter(Boolean)
  if (!parts.length) {
    return []
  }

  const status = parts[0]
  if (status.startsWith('R') || status.startsWith('C')) {
    return parts.slice(1)
  }

  return parts.slice(1, 2)
}

function parseStatusPath(rawPath) {
  const path = rawPath.replace(/^"|"$/g, '')
  const renameArrow = ' -> '
  if (path.includes(renameArrow)) {
    return path.slice(path.indexOf(renameArrow) + renameArrow.length)
  }

  return path
}

function collectChangedFiles(baseRef) {
  const changed = new Set()

  const diff = runGit(['diff', '--name-status', baseRef, '--'])
  if (diff.status === 0) {
    for (const line of diff.stdout.split('\n')) {
      for (const path of parseNameStatusLine(line.trim())) {
        if (path) {
          changed.add(normalizePath(path))
        }
      }
    }
  }

  const status = runGit(['status', '--porcelain', '--untracked-files=all'])
  if (status.status === 0) {
    for (const line of status.stdout.split('\n')) {
      if (!line.trim()) {
        continue
      }

      const path = parseStatusPath(line.slice(3).trim())
      if (path) {
        changed.add(normalizePath(path))
      }
    }
  }

  return changed
}

function collectPublicExportNames(program, checker) {
  const names = new Set(EXTRA_PUBLIC_COMPONENT_NAMES)

  for (const indexFile of PUBLIC_INDEX_FILES) {
    const sourceFile = program.getSourceFile(indexFile)
    if (!sourceFile) {
      continue
    }

    const symbol = checker.getSymbolAtLocation(sourceFile)
    if (!symbol) {
      continue
    }

    for (const exported of checker.getExportsOfModule(symbol)) {
      if (/^[A-Z]/.test(exported.name)) {
        names.add(exported.name)
      }
    }
  }

  return names
}

function collectComponentSourceFiles(program, publicExportNames) {
  const scanFiles = new Set(
    SCAN_ROOTS.flatMap(collectSourceFiles).map((filePath) => normalizePath(filePath))
  )
  const sourceFilesByComponent = new Map()

  for (const sourceFile of program.getSourceFiles()) {
    if (!scanFiles.has(normalizePath(sourceFile.fileName))) {
      continue
    }

    function visit(node) {
      const isPropsDeclaration =
        (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
        node.name.text.endsWith('Props')

      if (isPropsDeclaration) {
        const componentName = node.name.text.replace(/Props$/, '')
        if (publicExportNames.has(componentName)) {
          const files = sourceFilesByComponent.get(componentName) ?? new Set()
          files.add(toRepoPath(sourceFile.fileName))
          sourceFilesByComponent.set(componentName, files)
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  }

  return sourceFilesByComponent
}

function collectEntryFiles() {
  return collectSourceFiles(REGISTRY_ENTRIES_DIR).filter((filePath) =>
    filePath.endsWith('.entry.tsx')
  )
}

function collectApiComponents(entryText) {
  const names = new Set()

  for (const match of entryText.matchAll(/apiComponents:\s*\[([\s\S]*?)\]/g)) {
    for (const componentMatch of match[1].matchAll(/['"`]([^'"`]+)['"`]/g)) {
      names.add(componentMatch[1])
    }
  }

  return names
}

function stripImportQuery(specifier) {
  return specifier.split('?')[0]
}

function resolveImportPath(specifier, fromFile) {
  const cleanSpecifier = stripImportQuery(specifier)
  let basePath

  if (cleanSpecifier.startsWith('.')) {
    basePath = resolve(dirname(fromFile), cleanSpecifier)
  } else if (cleanSpecifier.startsWith('@catalog/')) {
    basePath = resolve(COMPONENT_LIBRARY_DIR, cleanSpecifier.slice('@catalog/'.length))
  } else {
    return null
  }

  if (existsSync(basePath) && statSync(basePath).isFile()) {
    return basePath
  }

  if (extname(basePath)) {
    return existsSync(basePath) ? basePath : null
  }

  for (const extension of DOC_IMPORT_EXTENSIONS) {
    const candidate = `${basePath}${extension}`
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

function isDocumentationDependency(filePath) {
  return (
    isInsideDirectory(filePath, EXAMPLES_DIR) ||
    isInsideDirectory(filePath, INTERACTIVE_DEMOS_DIR) ||
    (isInsideDirectory(filePath, REGISTRY_ENTRIES_DIR) &&
      ['.md', '.mdx'].includes(extname(filePath)))
  )
}

function collectImportSpecifiers(text) {
  const specifiers = new Set()
  const importPattern = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g

  for (const match of text.matchAll(importPattern)) {
    specifiers.add(match[1])
  }

  return specifiers
}

function collectDocumentationDependencies(entryFile) {
  const dependencies = new Set([toRepoPath(entryFile)])
  const visited = new Set()

  function visit(filePath) {
    if (visited.has(filePath) || !existsSync(filePath)) {
      return
    }

    visited.add(filePath)

    const text = readFileSync(filePath, 'utf-8')
    for (const specifier of collectImportSpecifiers(text)) {
      const resolved = resolveImportPath(specifier, filePath)
      if (!resolved || !isDocumentationDependency(resolved)) {
        continue
      }

      dependencies.add(toRepoPath(resolved))
      if (SOURCE_EXTENSIONS.has(extname(resolved))) {
        visit(resolved)
      }
    }
  }

  visit(entryFile)

  return dependencies
}

function collectDocumentationPathsByComponent() {
  const docsByComponent = new Map()

  for (const entryFile of collectEntryFiles()) {
    const entryText = readFileSync(entryFile, 'utf-8')
    const apiComponents = collectApiComponents(entryText)
    const documentationPaths = collectDocumentationDependencies(entryFile)

    for (const componentName of apiComponents) {
      const docs = docsByComponent.get(componentName) ?? new Set()
      for (const documentationPath of documentationPaths) {
        docs.add(documentationPath)
      }
      docsByComponent.set(componentName, docs)
    }
  }

  return docsByComponent
}

function readBaseFile(baseRef, repoPath) {
  const result = runGit(['show', `${baseRef}:${repoPath}`], { maxBuffer: 10 * 1024 * 1024 })
  if (result.status !== 0) {
    return ''
  }

  return result.stdout
}

function extractGeneratedApiBlocks(text) {
  const blocks = new Map()
  const pattern = /\n {2}([A-Za-z_$][\w$]*): (\[[\s\S]*?\n {2}\]),/g

  for (const match of text.matchAll(pattern)) {
    blocks.set(match[1], match[2])
  }

  return blocks
}

function collectGeneratedApiChangedComponents(baseRef, changedFiles) {
  const generatedRepoPath = toRepoPath(GENERATED_API_PATH)
  if (!changedFiles.has(generatedRepoPath) || !existsSync(GENERATED_API_PATH)) {
    return new Set()
  }

  const previousBlocks = extractGeneratedApiBlocks(readBaseFile(baseRef, generatedRepoPath))
  const currentBlocks = extractGeneratedApiBlocks(readFileSync(GENERATED_API_PATH, 'utf-8'))
  const componentNames = new Set([...previousBlocks.keys(), ...currentBlocks.keys()])
  const changedComponents = new Set()

  for (const componentName of componentNames) {
    if ((previousBlocks.get(componentName) ?? '') !== (currentBlocks.get(componentName) ?? '')) {
      changedComponents.add(componentName)
    }
  }

  return changedComponents
}

function collectChangedPublicComponents(componentSourceFiles, changedFiles) {
  const changed = []

  for (const [componentName, sourceFiles] of componentSourceFiles.entries()) {
    const changedSourceFiles = [...sourceFiles].filter((sourceFile) => changedFiles.has(sourceFile))

    if (changedSourceFiles.length) {
      changed.push({
        componentName,
        sourceFiles: changedSourceFiles,
      })
    }
  }

  return changed.sort((left, right) => left.componentName.localeCompare(right.componentName))
}

function hasChangedDocumentation(
  componentName,
  docsByComponent,
  changedFiles,
  generatedApiChangedComponents
) {
  if (generatedApiChangedComponents.has(componentName)) {
    return true
  }

  const docs = docsByComponent.get(componentName) ?? new Set()
  return [...docs].some((docPath) => changedFiles.has(docPath))
}

function checkChangedComponentsDocsFreshness(baseRef, changedFiles) {
  const { program, checker } = readProgram()
  const publicExportNames = collectPublicExportNames(program, checker)
  const componentSourceFiles = collectComponentSourceFiles(program, publicExportNames)
  const changedComponents = collectChangedPublicComponents(componentSourceFiles, changedFiles)

  if (!changedComponents.length) {
    console.log('Component library docs freshness: no public component source changes found.')
    return
  }

  const docsByComponent = collectDocumentationPathsByComponent()
  const generatedApiChangedComponents = collectGeneratedApiChangedComponents(baseRef, changedFiles)
  const missingDocs = changedComponents.filter(
    ({ componentName }) =>
      !hasChangedDocumentation(
        componentName,
        docsByComponent,
        changedFiles,
        generatedApiChangedComponents
      )
  )

  if (!missingDocs.length) {
    console.log(
      `Component library docs freshness: ${changedComponents.length} changed public component(s) have matching docs/API updates.`
    )
    return
  }

  console.warn(
    [
      'Warning: component library docs may be stale for changed public components:',
      ...missingDocs.map(({ componentName, sourceFiles }) => {
        const sourceList = sourceFiles.map((sourceFile) => `    ${sourceFile}`).join('\n')
        return `  - ${componentName}\n${sourceList}`
      }),
      '',
      'Consider updating the matching registry entry, imported Markdown documentation,',
      'example/interactive demo fixture, or generated API rows if the component change affects docs.',
      '',
      'The warning compares changed files against:',
      `  ${baseRef}`,
      '',
      'Override with COMPONENT_LIBRARY_DOCS_BASE=<ref> or --base <ref> when running in CI.',
    ].join('\n')
  )
}

if (!assertGitRepository()) {
  console.log('Component library docs freshness: skipped outside a Git worktree.')
  process.exit(0)
}

const baseRef = getBaseRef()
const changedFiles = collectChangedFiles(baseRef)
checkChangedComponentsDocsFreshness(baseRef, changedFiles)
