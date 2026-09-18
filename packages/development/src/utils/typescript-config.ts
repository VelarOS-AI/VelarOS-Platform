import { createHash } from 'node:crypto'
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import * as ts from 'typescript'

import { isEmpty, isNonBlankString, isPlainObject, isPresent, isTrue, toNullable } from '@velaros-ai/core'

import type {
  ParseTypeScriptConfig,
  PooledTypeScriptProject,
  TypeScriptProjectConfig,
} from '../types/typescript.js'

import { isPathTextInsideRoot } from './project-paths.js'
import { DevelopmentTuning } from './tuning.js'

/** 能进 TypeScript 程序的扩展名（带点、小写）。 */
export const TypeScriptExtensions = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.cts', '.mts', '.cjs', '.mjs',
])

/** 其中属于 JavaScript 的那几个：命中时强制 `allowJs`，并优先找 jsconfig。 */
const JavaScriptExtensions = new Set(['.js', '.jsx', '.cjs', '.mjs'])

/** 枚举磁盘源码时直接剪枝的目录名：依赖、构建产物与工具缓存。 */
export const SkippedDirectoryNames = new Set([
  '.data',
  '.git',
  '.idea',
  '.velaros',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
])

/** 同一份跳过名单的 glob 写法，交给内核遍历用。 */
export const SkippedDirectoryGlobs = [...SkippedDirectoryNames].map((name) => `**/${name}`)

/** 取路径的扩展名（带点、小写）；没有扩展名给空串。 */
export function extensionWithDot(path: string): string {
  const index = path.lastIndexOf('.')
  return index === -1 ? '' : path.slice(index).toLowerCase()
}

/** 读一个文件；不存在、不是文件或读不动都按缺席处理。 */
export function safeReadFile(path: string): Nullable<string> {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null
    return readFileSync(path, 'utf8')
  } catch {
    // arch-guard:silent-catch-ok safe 前缀语义：文件不可读按缺席处理
    return null
  }
}

/** 文件的大小与修改时间指纹；不存在时给 `missing`，一样能进缓存键。 */
function fileStatFingerprint(path: string): string {
  try {
    const stats = statSync(path, { bigint: true })
    return `${stats.size}:${stats.mtimeNs}`
  } catch {
    // arch-guard:silent-catch-ok 文件不存在或不可读时，以 missing 进入缓存指纹。
    return 'missing'
  }
}

/** 从请求文件往上找最近的 package.json，不越出项目根。 */
export function findNearestPackageJsonPath(
  projectRoot: string,
  requestAbsolutePath: string
): Nullable<string> {
  let directory = dirname(requestAbsolutePath)

  while (isPathTextInsideRoot(projectRoot, directory)) {
    const packageJsonPath = resolve(directory, 'package.json')
    if (existsSync(packageJsonPath)) return packageJsonPath

    if (directory === projectRoot) break
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  return null
}

/** 参与模块类型推断的 package.json：最近的那个，再加项目根的那个。 */
function collectPackageJsonPaths(projectRoot: string, requestAbsolutePath: string): string[] {
  const packageJsonPaths: string[] = []
  const nearestPackageJsonPath = findNearestPackageJsonPath(projectRoot, requestAbsolutePath)
  const rootPackageJsonPath = resolve(projectRoot, 'package.json')

  if (nearestPackageJsonPath) packageJsonPaths.push(nearestPackageJsonPath)
  if (existsSync(rootPackageJsonPath) && !packageJsonPaths.includes(rootPackageJsonPath)) {
    packageJsonPaths.push(rootPackageJsonPath)
  }

  return packageJsonPaths
}

/** 读 package.json 的 `type`；读不出或损坏时给 null，由缺省推断兜底。 */
function readPackageModuleType(packageJsonPath?: string): Nullable<'module' | 'commonjs'> {
  if (!packageJsonPath) return null
  const content = safeReadFile(packageJsonPath)
  if (!content) return null

  try {
    const packageJson = JSON.parse(content) as { type?: unknown }
    return packageJson.type === 'module' ? 'module' : 'commonjs'
  } catch {
    // arch-guard:silent-catch-ok package.json 损坏按未知模块类型处理，走缺省推断
    return null
  }
}

/** 读并展开一个 tsconfig / jsconfig；读不动就给 null。 */
export function parseTypeScriptConfigFile(configPath: string): Nullable<ts.ParsedCommandLine> {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error) return null

  return ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath
  )
}

/** 沿项目引用往下找真正拥有这个文件的配置。 */
function findOwningReferencedConfigPath(
  configPath: string,
  requestAbsolutePath: string,
  parseConfig: ParseTypeScriptConfig,
  visited = new Set<string>()
): Nullable<string> {
  if (visited.has(configPath)) return null
  visited.add(configPath)

  const parsed = parseConfig(configPath)
  if (!parsed) return null

  for (const reference of parsed.projectReferences ?? []) {
    const referencedConfigPath = ts.resolveProjectReferencePath(reference)
    const owningConfigPath = findOwningReferencedConfigPath(
      referencedConfigPath,
      requestAbsolutePath,
      parseConfig,
      visited
    )
    if (owningConfigPath) return owningConfigPath
  }

  return parsed.fileNames.includes(requestAbsolutePath) ? configPath : null
}

/** 从请求文件往上找它所属的 tsconfig / jsconfig，不越出项目根；都不拥有它时退到最近的那个。 */
export function findTypeScriptConfigPath(
  projectRoot: string,
  requestAbsolutePath: string,
  parseConfig: ParseTypeScriptConfig = parseTypeScriptConfigFile
): Nullable<string> {
  const isJavaScript = JavaScriptExtensions.has(extensionWithDot(requestAbsolutePath))
  const configNames = isJavaScript
    ? (['jsconfig.json', 'tsconfig.json'] as const)
    : (['tsconfig.json', 'jsconfig.json'] as const)
  let directory = dirname(requestAbsolutePath)
  let nearestConfigPath: Nullable<string> = null

  while (isPathTextInsideRoot(projectRoot, directory)) {
    for (const configName of configNames) {
      const configPath = resolve(directory, configName)
      if (!existsSync(configPath)) continue

      nearestConfigPath ??= configPath
      const owningConfigPath = findOwningReferencedConfigPath(
        configPath,
        requestAbsolutePath,
        parseConfig
      )
      if (owningConfigPath) return owningConfigPath
    }

    if (directory === projectRoot) break
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  // 新建且尚未写入 config include 的文件仍应继承最近配置；已存在并被某个配置拥有的文件
  // 会在上面的包含关系检查中优先命中，避免同时存在 tsconfig/jsconfig 时选错项目。
  return nearestConfigPath
}

/** `.cjs` / `.cts` 这类写死 CommonJS 的路径。 */
function isExplicitCommonJsPath(path: string): boolean {
  const extension = extensionWithDot(path)
  return extension === '.cjs' || extension === '.cts'
}

/**
 * 把一批文件按各自所属的 TypeScript 项目分组，组内任一文件发起 acquire 都得到同一份配置与编译选项。
 *
 * 归属判定与 acquire 同用 {@link findTypeScriptConfigPath}，所以整组诊断与逐个单独诊断同源，
 * 不会借用恰好先把文件拉进来的外层程序。编译选项里随请求文件变化的只有两处——JS 请求强制
 * `allowJs`、`.cjs/.cts` 推断改用 Node16——它们与普通 TS 文件分开成组，否则同一配置的服务会在
 * 组间交替时反复重建。一次分组内每个配置只解析一次：无 include 的根配置会展开整个仓库。
 */
export function groupFilesByTypeScriptProject(
  projectRoot: string,
  absolutePaths: readonly string[]
): string[][] {
  const parsedConfigs = new Map<string, Nullable<ts.ParsedCommandLine>>()
  const parseConfig: ParseTypeScriptConfig = (configPath) => {
    if (!parsedConfigs.has(configPath)) {
      parsedConfigs.set(configPath, parseTypeScriptConfigFile(configPath))
    }
    return toNullable(parsedConfigs.get(configPath))
  }

  const groups = new Map<string, string[]>()
  for (const absolutePath of absolutePaths) {
    const configPath = findTypeScriptConfigPath(projectRoot, absolutePath, parseConfig)
    const projectKey = [
      configPath ?? `inferred:${findNearestPackageJsonPath(projectRoot, absolutePath) ?? ''}`,
      JavaScriptExtensions.has(extensionWithDot(absolutePath)),
      isExplicitCommonJsPath(absolutePath),
    ].join('\0')
    const group = groups.get(projectKey)
    if (group) group.push(absolutePath)
    else groups.set(projectKey, [absolutePath])
  }
  return [...groups.values()]
}

/** 磁盘上属于这个项目目录的源文件路径，按上限截断。 */
function collectTypeScriptFilePathsFromDisk(projectDirectory: string): string[] {
  const paths: string[] = []

  const visit = (directory: string): void => {
    if (paths.length >= DevelopmentTuning.typescriptProject.maxFiles) return

    let entries: Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      // arch-guard:silent-catch-ok 目录不可读即跳过该子树，属文件枚举的容错
      return
    }

    for (const entry of entries) {
      if (paths.length >= DevelopmentTuning.typescriptProject.maxFiles) return

      if (entry.isDirectory()) {
        if (!SkippedDirectoryNames.has(entry.name)) visit(resolve(directory, entry.name))
        continue
      }

      if (!entry.isFile()) continue

      const absolutePath = resolve(directory, entry.name)
      if (!TypeScriptExtensions.has(extensionWithDot(absolutePath))) continue

      paths.push(absolutePath)
    }
  }

  visit(projectDirectory)
  return paths
}

/** 磁盘上属于这个项目目录的源文件正文。 */
function collectTypeScriptFilesFromDisk(projectDirectory: string): Map<string, string> {
  const files = new Map<string, string>()
  for (const path of collectTypeScriptFilePathsFromDisk(projectDirectory)) {
    const content = safeReadFile(path)
    if (isPresent(content)) files.set(path, content)
  }
  return files
}

/** 解析出一个（项目根，请求文件）对应的项目配置，连同判失效用的指纹。 */
export function parseTypeScriptProjectConfig(
  projectRoot: string,
  requestAbsolutePath: string
): TypeScriptProjectConfig {
  const configPath = findTypeScriptConfigPath(projectRoot, requestAbsolutePath)
  const packageJsonPaths = collectPackageJsonPaths(projectRoot, requestAbsolutePath)
  const packageModuleType = readPackageModuleType(packageJsonPaths[0])
  const isExplicitCommonJs = isExplicitCommonJsPath(requestAbsolutePath)
  const projectDirectory = configPath
    ? dirname(configPath)
    : packageJsonPaths[0]
      ? dirname(packageJsonPaths[0])
      : projectRoot
  const fallbackOptions: ts.CompilerOptions = {
    allowJs: true,
    allowImportingTsExtensions: true,
    allowSyntheticDefaultImports: true,
    checkJs: false,
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: isExplicitCommonJs ? ts.ModuleKind.Node16 : ts.ModuleKind.Preserve,
    moduleDetection:
      packageModuleType === 'module' ? ts.ModuleDetectionKind.Force : ts.ModuleDetectionKind.Auto,
    moduleResolution: isExplicitCommonJs
      ? ts.ModuleResolutionKind.Node16
      : ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  }

  const createConfig = (
    compilerOptions: ts.CompilerOptions,
    fileNames: string[],
    projectReferences?: readonly ts.ProjectReference[]
  ): TypeScriptProjectConfig => {
    const fingerprint = createHash('sha1')
      .update(configPath ?? 'inferred')
      .update(projectDirectory)
      .update(JSON.stringify(compilerOptions))
      .update(fileNames.join('\0'))
    for (const packageJsonPath of packageJsonPaths) {
      fingerprint.update(packageJsonPath)
      fingerprint.update(fileStatFingerprint(packageJsonPath))
    }
    const sourcePaths = !isEmpty(fileNames)
      ? fileNames
      : collectTypeScriptFilePathsFromDisk(projectDirectory)
    for (const sourcePath of sourcePaths) {
      fingerprint.update(sourcePath)
      fingerprint.update(fileStatFingerprint(sourcePath))
    }

    return {
      projectRoot,
      projectDirectory,
      configPath,
      compilerOptions,
      fileNames,
      projectReferences,
      packageJsonPaths,
      fingerprint: fingerprint.digest('hex'),
    }
  }

  if (!configPath) return createConfig(fallbackOptions, [])

  const parsed = parseTypeScriptConfigFile(configPath)
  if (!parsed) return createConfig(fallbackOptions, [])

  return createConfig(
    {
      ...parsed.options,
      allowJs: JavaScriptExtensions.has(extensionWithDot(requestAbsolutePath))
        ? true
        : parsed.options.allowJs,
      noEmit: true,
      skipLibCheck: parsed.options.skipLibCheck ?? true,
    },
    parsed.fileNames,
    parsed.projectReferences
  )
}

/** 项目里声明过的依赖包名，按上限截断。 */
function readPackageDependencyNames(packageJsonPaths: readonly string[]): string[] {
  const dependencyNames = new Set<string>()

  for (const packageJsonPath of packageJsonPaths) {
    const content = safeReadFile(packageJsonPath)
    if (!content) continue

    try {
      const packageJson = JSON.parse(content) as Record<string, unknown>
      for (const field of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ]) {
        const dependencies = packageJson[field]
        if (!isPlainObject(dependencies)) continue
        for (const dependencyName of Object.keys(dependencies)) dependencyNames.add(dependencyName)
      }
    } catch {
      // arch-guard:silent-catch-ok 无效 package.json 由编辑器诊断负责；语言服务退化为项目内符号，不中断请求。
    }
  }

  return [...dependencyNames].slice(0, DevelopmentTuning.typescriptProject.maxPackageTypeEntries)
}

/** 依赖包的类型入口文件：把它们作为根文件注入，自动导入候选才认得出第三方 API。 */
function collectPackageTypeEntryPaths(
  config: TypeScriptProjectConfig,
  requestAbsolutePath: string
): string[] {
  const entryPaths = new Set<string>()

  for (const packageName of readPackageDependencyNames(config.packageJsonPaths)) {
    const resolvedModule = ts.resolveModuleName(
      packageName,
      requestAbsolutePath,
      config.compilerOptions,
      ts.sys
    ).resolvedModule
    if (
      !resolvedModule ||
      !TypeScriptExtensions.has(extensionWithDot(resolvedModule.resolvedFileName))
    ) {
      continue
    }

    entryPaths.add(resolvedModule.resolvedFileName)
  }

  return [...entryPaths]
}

/** 装配一个项目的源码快照：优先文件、请求文件、依赖类型入口，再补配置或磁盘上的源文件。 */
export function collectTypeScriptFilesFromConfig(
  config: TypeScriptProjectConfig,
  requestAbsolutePath: string,
  priorityPaths: readonly string[]
): Map<string, string> {
  const files = new Map<string, string>()
  const seen = new Set<string>()

  const addFile = (absolutePath: string): void => {
    if (files.size >= DevelopmentTuning.typescriptProject.maxFiles || seen.has(absolutePath)) return
    if (!TypeScriptExtensions.has(extensionWithDot(absolutePath))) return

    const content = safeReadFile(absolutePath)
    if (!isPresent(content)) return

    seen.add(absolutePath)
    files.set(absolutePath, content)
  }

  for (const path of priorityPaths) addFile(path)

  addFile(requestAbsolutePath)

  // Standalone LanguageService 没有 tsserver 的 auto-import provider；把依赖包的类型入口作为
  // 项目根文件注入，React/Vue/Vite 等包导出的 API 才会进入自动导入候选。
  for (const entryPath of collectPackageTypeEntryPaths(config, requestAbsolutePath)) {
    addFile(entryPath)
  }

  if (!isEmpty(config.fileNames)) {
    for (const fileName of config.fileNames) addFile(fileName)
    return files
  }

  for (const [path, content] of collectTypeScriptFilesFromDisk(config.projectDirectory)) {
    if (files.size >= DevelopmentTuning.typescriptProject.maxFiles) break
    if (seen.has(path)) continue
    seen.add(path)
    files.set(path, content)
  }

  return files
}

/** 池与配置缓存共用的键：项目根加配置路径。 */
export function projectCacheKeyOf(config: TypeScriptProjectConfig): string {
  return `${config.projectRoot}\0${config.configPath ?? `inferred:${config.projectDirectory}`}`
}

/** 缓存键属于这个项目根吗（释放某个项目时按前缀挑）。 */
export function cacheKeyBelongsToProject(cacheKey: string, projectRoot: string): boolean {
  return cacheKey.startsWith(`${projectRoot}\0`)
}

/** 写一个文件的正文；内容没变就不动版本号，TS 才会复用该文件已有的解析与类型结果。 */
export function setPooledFile(
  project: PooledTypeScriptProject,
  fileName: string,
  content: string
): void {
  // 无条件 +1 会让每次请求都重建整个 program：版本号是增量缓存的开关。
  if (project.liveFiles.get(fileName) === content) return
  project.liveFiles.set(fileName, content)
  project.fileVersions.set(fileName, (project.fileVersions.get(fileName) ?? 0) + 1)
}

/** Electron 宿主按约定携带标准库的目录；Node / Bun 下读不到 `process.resourcesPath`，给 null。 */
function electronResourcesLibraryDirectory(): Nullable<string> {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return isNonBlankString(resourcesPath) ? resolve(resourcesPath, 'typescript', 'lib') : null
}

/** 这个目录是否提供了整套标准库（含 `/// <reference lib>` 传递引用到的文件）。 */
function hasCompleteLibraryClosure(directory: string, rootLibFileNames: readonly string[]): boolean {
  const pending = [...rootLibFileNames]
  const visited = new Set<string>()
  for (let libFileName = pending.pop(); isPresent(libFileName); libFileName = pending.pop()) {
    if (visited.has(libFileName)) continue
    visited.add(libFileName)
    const content = safeReadFile(resolve(directory, libFileName))
    if (!isPresent(content)) return false
    // 标准库内部引用一律用规范名（`es2015.collection`），与文件名 `lib.<名>.d.ts` 一一对应。
    for (const reference of ts.preProcessFile(content, false, false).libReferenceDirectives) {
      pending.push(`lib.${reference.fileName.toLowerCase()}.d.ts`)
    }
  }
  return true
}

/**
 * 选出第一个能提供完整标准库的候选目录，返回其中的默认库文件路径。
 *
 * 程序实际加载的是 `compilerOptions.lib` 列出的文件（未设置时为默认库），再加上它们经
 * `/// <reference lib>` 传递引用的文件，全部从同一目录解析。只查默认库文件在不在不够：
 * 目录里有 `lib.es2022.full.d.ts` 却缺它引用的 `lib.es2015.collection.d.ts` 时，`Set`
 * 照样被报成缺失。所以逐目录校验整个引用闭包，缺任何一个文件就换下一个目录。
 */
export function resolveDefaultLibFilePath(
  options: ts.CompilerOptions,
  configuredDirectory: Nullable<string>
): Nullable<string> {
  const defaultLibFileName = ts.getDefaultLibFileName(options)
  const requiredLibFileNames = isTrue(options.noLib) ? [] : (options.lib ?? [defaultLibFileName])
  const libraryDirectories = [
    dirname(ts.getDefaultLibFilePath(options)),
    configuredDirectory,
    electronResourcesLibraryDirectory(),
  ]
  const libraryDirectory = libraryDirectories.find(
    (directory) =>
      isPresent(directory) && hasCompleteLibraryClosure(directory, requiredLibFileNames)
  )
  return isPresent(libraryDirectory) ? resolve(libraryDirectory, defaultLibFileName) : null
}

/** 用池里的文件表与版本表装出一个 `ts.LanguageServiceHost`。 */
export function createLanguageServiceHost(
  project: Omit<PooledTypeScriptProject, 'service'>
): ts.LanguageServiceHost {
  return {
    getCompilationSettings: () => project.compilerOptions,
    getScriptFileNames: () => [...project.liveFiles.keys()],
    getScriptVersion: (fileName) => String(project.fileVersions.get(fileName) ?? 0),
    getScriptSnapshot: (fileName) => {
      const content =
        project.liveFiles.get(fileName) ?? safeReadFile(fileName) ?? ts.sys.readFile(fileName)
      return !isPresent(content) ? undefined : ts.ScriptSnapshot.fromString(content)
    },
    getCurrentDirectory: () => project.projectDirectory,
    // TS 从该文件所在目录解析 `compilerOptions.lib` 与 `/// <reference lib>`。标准库缺席时仍须
    // 返回一个路径，程序照常构建但没有标准库；调用方凭 `standardLibraryAvailable` 识别这种状态。
    getDefaultLibFileName: (options) =>
      project.defaultLibFilePath ?? ts.getDefaultLibFilePath(options),
    fileExists: (fileName) => project.liveFiles.has(fileName) || ts.sys.fileExists(fileName),
    readFile: (fileName) => project.liveFiles.get(fileName) ?? ts.sys.readFile(fileName),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
    getProjectReferences: () => project.projectReferences,
  }
}
