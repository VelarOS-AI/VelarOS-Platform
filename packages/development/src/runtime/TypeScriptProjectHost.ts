import { createHash } from 'node:crypto'
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import * as ts from 'typescript'

import {
  isEmpty,
  isNonBlankString,
  isPlainObject,
  isPresent,
  isTrue,
  toNullable,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

/**
 * TypeScript 项目宿主 —— `project:query-code` 内置基线背后的 `ts.LanguageService` 池。
 *
 * ## 为什么要池化（而不是每次调用建一个 program）
 * `ts.createLanguageService` 本身很便宜，贵的是它第一次 `getSemanticDiagnostics` 时把整个程序
 * （项目源码 + `lib.*.d.ts` + `node_modules` 类型）解析并类型检查一遍——数百毫秒到数秒。
 * 池化让**同一项目的连续工具调用共用增量缓存**，这是这个文件全部复杂度的唯一理由。
 *
 * ## 两级缓存，同一把键（`projectRoot\0configPath`）
 * | 表 | 存什么 | 何时失效 |
 * |---|---|---|
 * | `projectCache` | 解析好的 `tsconfig` 配置 + 源码快照 `diskFiles` | 配置、源码或依赖清单指纹变化 |
 * | `pooledProjects` | 活的 `ts.LanguageService` + 文件版本表 | 随 `projectCache` 失效而 `dispose` |
 *
 * 两表必须同生共死：配置变了却留着旧 service，等于用旧 `compilerOptions` 回答新问题。
 * 所以 {@link getOrCreateProjectCache} 在指纹不匹配时**先 dispose 池中 service 再重建快照**。
 *
 * ## 版本号是增量缓存的开关（改这里最容易把性能整没）
 * `getScriptVersion` 返回的号一变，TS 就丢弃该文件的解析与类型结果。因此
 * {@link setPooledFile} **只在内容真的变了才 +1**；写成"每次 acquire 都 bump"会让池化彻底失效，
 * 表面看不出错，只是每次调用都慢回未池化的水平。
 *
 * ## overlay = 脏缓冲区，非 overlay 文件在一次 acquire 结束后必须回落磁盘态
 * 调用方把"当前内容"作为 overlay 传进来（编辑器缓冲 / 刚读出的磁盘正文）。
 * 上一轮的 overlay 若不在这一轮的集合里，会被还原成 `diskFiles` 里的内容（磁盘上没有则整条删）——
 * 否则某次调用临时塞进去的正文会永久污染后续所有查询。`preserveExistingOverlays` 是显式跳过这步
 * 的逃生口，给"多次 acquire 组成一次逻辑操作"的调用方。
 *
 * 源文件指纹使用 `size + mtimeNs`。未变化时保留增量缓存；任何项目源码变化都会重建对应
 * project service，避免一次编辑后依赖文件仍停留在旧快照。
 *
 * ## 标准库（`lib.*.d.ts`）按候选目录定位，找不到时显式降级
 * `ts.getDefaultLibFilePath` 只认 `typescript` 包自身所在目录。Electron 打包会剔除 `node_modules`
 * 里的 `.d.ts`，于是那里只剩 `typescript.js`：标准库静默缺席，每个 `Record`/`Set`/`string.trim`
 * 都被报成类型错误，诊断整体失真。候选目录依次是：`typescript` 包自身目录 →
 * {@link configureTypeScriptLibraryDirectory} 声明的目录 → Electron 约定目录
 * `<process.resourcesPath>/typescript/lib`（宿主以 extraResources 携带 `lib*.d.ts`）。目录必须
 * 含编译选项所需标准库的完整引用闭包才算命中。没有目录命中时
 * {@link acquireTypeScriptLanguageService} 报告 `standardLibraryAvailable: false`，
 * 由调用方放弃依赖类型检查的结果，而不是把伪错误当真结论返回。
 */
const TypeScriptExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.cts', '.mts', '.cjs', '.mjs'])
const JavaScriptExtensions = new Set(['.js', '.jsx', '.cjs', '.mjs'])
const MaxTypeScriptProjectFiles = 2000
const MaxPackageTypeEntries = 256
const SkippedDirectoryNames = new Set([
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

export interface TypeScriptProjectConfig {
  projectRoot: string
  projectDirectory: string
  configPath: Nullable<string>
  compilerOptions: ts.CompilerOptions
  fileNames: string[]
  projectReferences?: readonly ts.ProjectReference[]
  packageJsonPaths: string[]
  fingerprint: string
}

interface TypeScriptProjectCacheEntry {
  cacheKey: string
  config: TypeScriptProjectConfig
  diskFiles: Map<string, string>
}

interface PooledTypeScriptProject {
  projectRoot: string
  projectDirectory: string
  compilerOptions: ts.CompilerOptions
  projectReferences?: readonly ts.ProjectReference[]
  diskFiles: Map<string, string>
  liveFiles: Map<string, string>
  fileVersions: Map<string, number>
  overlayPaths: Set<string>
  /** 本项目编译选项对应的默认标准库文件；`null` 表示没有候选目录能提供完整的标准库。 */
  defaultLibFilePath: Nullable<string>
  service: ts.LanguageService
}

const projectCache = new Map<string, TypeScriptProjectCacheEntry>()
const pooledProjects = new Map<string, PooledTypeScriptProject>()
let configuredLibraryDirectory: Nullable<string> = null

function extensionWithDot(path: string): string {
  const index = path.lastIndexOf('.')
  return index === -1 ? '' : path.slice(index).toLowerCase()
}

function safeReadFile(path: string): Nullable<string> {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null
    return readFileSync(path, 'utf8')
  } catch {
    // arch-guard:silent-catch-ok safe 前缀语义：文件不可读按缺席处理
    return null
  }
}

function fileStatFingerprint(path: string): string {
  try {
    const stats = statSync(path, { bigint: true })
    return `${stats.size}:${stats.mtimeNs}`
  } catch {
    // arch-guard:silent-catch-ok 文件不存在或不可读时，以 missing 进入缓存指纹。
    return 'missing'
  }
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const childRelativePath = relative(parentPath, childPath)
  return (
    isEmpty(childRelativePath) ||
    (childRelativePath !== '..' &&
      !childRelativePath.startsWith(`..${sep}`) &&
      !isAbsolute(childRelativePath))
  )
}

function findNearestPackageJsonPath(
  projectRoot: string,
  requestAbsolutePath: string
): Nullable<string> {
  let directory = dirname(requestAbsolutePath)

  while (isPathInside(projectRoot, directory)) {
    const packageJsonPath = resolve(directory, 'package.json')
    if (existsSync(packageJsonPath)) return packageJsonPath

    if (directory === projectRoot) break
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  return null
}

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

type ParseTypeScriptConfig = (configPath: string) => Nullable<ts.ParsedCommandLine>

function findTypeScriptConfigPath(
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

  while (isPathInside(projectRoot, directory)) {
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

function parseTypeScriptConfigFile(configPath: string): Nullable<ts.ParsedCommandLine> {
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

function isExplicitCommonJsPath(path: string): boolean {
  const extension = extensionWithDot(path)
  return extension === '.cjs' || extension === '.cts'
}

function parseTypeScriptProjectConfig(
  projectRoot: string,
  requestAbsolutePath: string
): TypeScriptProjectConfig {
  const discoveredConfigPath = findTypeScriptConfigPath(projectRoot, requestAbsolutePath)
  const configPath = discoveredConfigPath
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

function collectTypeScriptFilePathsFromDisk(projectDirectory: string): string[] {
  const paths: string[] = []

  const visit = (directory: string): void => {
    if (paths.length >= MaxTypeScriptProjectFiles) return

    let entries: Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      // arch-guard:silent-catch-ok 目录不可读即跳过该子树，属文件枚举的容错
      return
    }

    for (const entry of entries) {
      if (paths.length >= MaxTypeScriptProjectFiles) return

      if (entry.isDirectory()) {
        if (!SkippedDirectoryNames.has(entry.name)) {
          visit(resolve(directory, entry.name))
        }
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

function collectTypeScriptFilesFromDisk(projectDirectory: string): Map<string, string> {
  const files = new Map<string, string>()
  for (const path of collectTypeScriptFilePathsFromDisk(projectDirectory)) {
    const content = safeReadFile(path)
    if (isPresent(content)) files.set(path, content)
  }
  return files
}

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

  return [...dependencyNames].slice(0, MaxPackageTypeEntries)
}

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

function collectTypeScriptFilesFromConfig(
  config: TypeScriptProjectConfig,
  requestAbsolutePath: string,
  priorityPaths: string[]
): Map<string, string> {
  const files = new Map<string, string>()
  const seen = new Set<string>()

  const addFile = (absolutePath: string): void => {
    if (files.size >= MaxTypeScriptProjectFiles || seen.has(absolutePath)) return
    if (!TypeScriptExtensions.has(extensionWithDot(absolutePath))) return

    const content = safeReadFile(absolutePath)
    if (!isPresent(content)) return

    seen.add(absolutePath)
    files.set(absolutePath, content)
  }

  for (const path of priorityPaths) {
    addFile(path)
  }

  addFile(requestAbsolutePath)

  // Standalone LanguageService 没有 tsserver 的 auto-import provider；把依赖包的类型入口作为
  // 项目根文件注入，React/Vue/Vite 等包导出的 API 才会进入自动导入候选。
  for (const entryPath of collectPackageTypeEntryPaths(config, requestAbsolutePath)) {
    addFile(entryPath)
  }

  if (!isEmpty(config.fileNames)) {
    for (const fileName of config.fileNames) {
      addFile(fileName)
    }
    return files
  }

  for (const [path, content] of collectTypeScriptFilesFromDisk(config.projectDirectory)) {
    if (files.size >= MaxTypeScriptProjectFiles) break
    if (seen.has(path)) continue
    seen.add(path)
    files.set(path, content)
  }

  return files
}

function getProjectCacheKey(config: TypeScriptProjectConfig): string {
  return `${config.projectRoot}\0${config.configPath ?? `inferred:${config.projectDirectory}`}`
}

function getOrCreateProjectCache(
  projectRoot: string,
  requestAbsolutePath: string,
  priorityPaths: string[]
): TypeScriptProjectCacheEntry {
  const config = parseTypeScriptProjectConfig(projectRoot, requestAbsolutePath)
  const cacheKey = getProjectCacheKey(config)
  const cached = projectCache.get(cacheKey)
  if (cached?.config.fingerprint === config.fingerprint) return cached

  const pooledProject = pooledProjects.get(cacheKey)
  pooledProject?.service.dispose()
  pooledProjects.delete(cacheKey)

  const diskFiles = collectTypeScriptFilesFromConfig(config, requestAbsolutePath, priorityPaths)
  const entry: TypeScriptProjectCacheEntry = { cacheKey, config, diskFiles }
  projectCache.set(cacheKey, entry)
  return entry
}

function setPooledFile(project: PooledTypeScriptProject, fileName: string, content: string): void {
  // 内容没变就不动版本号：版本稳定，TS 才会复用该文件已有的解析/类型结果。
  // 无条件 +1 会让每次请求都重建整个 program（见文件头「版本号是增量缓存的开关」）。
  if (project.liveFiles.get(fileName) === content) return
  project.liveFiles.set(fileName, content)
  project.fileVersions.set(fileName, (project.fileVersions.get(fileName) ?? 0) + 1)
}

function electronResourcesLibraryDirectory(): Nullable<string> {
  // `process.resourcesPath` 只在 Electron 进程里存在，Node/Bun 下读到 undefined。
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return isNonBlankString(resourcesPath) ? resolve(resourcesPath, 'typescript', 'lib') : null
}

/**
 * 选出第一个能提供完整标准库的候选目录，返回其中的默认库文件路径。
 *
 * 程序实际加载的是 `compilerOptions.lib` 列出的文件（未设置时为默认库），再加上它们经
 * `/// <reference lib>` 传递引用的文件，全部从同一目录解析。只查默认库文件在不在不够：
 * 目录里有 `lib.es2022.full.d.ts` 却缺它引用的 `lib.es2015.collection.d.ts` 时，`Set`
 * 照样被报成缺失。所以逐目录校验整个引用闭包，缺任何一个文件就换下一个目录。
 */
function resolveDefaultLibFilePath(options: ts.CompilerOptions): Nullable<string> {
  const defaultLibFileName = ts.getDefaultLibFileName(options)
  const requiredLibFileNames = isTrue(options.noLib) ? [] : (options.lib ?? [defaultLibFileName])
  const libraryDirectories = [
    dirname(ts.getDefaultLibFilePath(options)),
    configuredLibraryDirectory,
    electronResourcesLibraryDirectory(),
  ]
  const libraryDirectory = libraryDirectories.find(
    (directory) => isPresent(directory) && hasCompleteLibraryClosure(directory, requiredLibFileNames)
  )
  return isPresent(libraryDirectory) ? resolve(libraryDirectory, defaultLibFileName) : null
}

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

function createLanguageServiceHost(
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

/**
 * 声明宿主携带的 TypeScript 标准库目录（内含 `lib.*.d.ts`），传 `null` 撤销声明。
 *
 * 只在 `typescript` 包自身目录找不到标准库时生效。Electron 宿主若按约定把
 * `node_modules/typescript/lib/lib*.d.ts` 作为 extraResources 放到
 * `<process.resourcesPath>/typescript/lib`，无需调用本函数。已池化的语言服务绑定了旧的
 * 标准库位置，所以声明变化后整池重建。
 */
export function configureTypeScriptLibraryDirectory(directory: Nullable<string>): void {
  if (isPresent(directory) && !isAbsolute(directory)) {
    throw new AppError('VALIDATION', `TypeScript 标准库目录必须是绝对路径：${directory}`)
  }
  configuredLibraryDirectory = directory
  clearTypeScriptProjectCache()
}

export function clearTypeScriptProjectCache(projectRoot?: string): void {
  if (!projectRoot) {
    for (const project of pooledProjects.values()) project.service.dispose()
    projectCache.clear()
    pooledProjects.clear()
    return
  }

  for (const key of projectCache.keys()) {
    if (key.startsWith(`${projectRoot}\0`)) {
      projectCache.delete(key)
    }
  }

  for (const key of pooledProjects.keys()) {
    if (key.startsWith(`${projectRoot}\0`)) {
      pooledProjects.get(key)?.service.dispose()
      pooledProjects.delete(key)
    }
  }
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

export function acquireTypeScriptLanguageService(
  projectRoot: string,
  requestAbsolutePath: string,
  priorityPaths: string[],
  overlayFiles: Map<string, string>,
  preserveExistingOverlays = false
): {
  service: ts.LanguageService
  files: Map<string, string>
  compilerOptions: ts.CompilerOptions
  config: TypeScriptProjectConfig
  /** 为 `false` 时语义诊断会把标准库全局名报成缺失，调用方只能信任语法层结果。 */
  standardLibraryAvailable: boolean
  /**
   * 该服务是否仍是池中的活服务。跨 `await` 持有结果的调用方在继续使用前必须检查：
   * 期间并发的 acquire 可能因指纹变化 dispose 了它，而被 dispose 的服务一调用就崩。
   */
  isCurrent(): boolean
} {
  const cacheEntry = getOrCreateProjectCache(projectRoot, requestAbsolutePath, priorityPaths)
  const poolKey = cacheEntry.cacheKey

  let project = pooledProjects.get(poolKey)
  if (!project) {
    const liveFiles = new Map(cacheEntry.diskFiles)
    const fileVersions = new Map<string, number>()
    for (const [path] of liveFiles) {
      fileVersions.set(path, 1)
    }

    // 先装配 host 所需的状态切片，再补 service——host 只读文件/版本表，与 service 无环。
    const draft: Omit<PooledTypeScriptProject, 'service'> = {
      projectRoot,
      projectDirectory: cacheEntry.config.projectDirectory,
      compilerOptions: cacheEntry.config.compilerOptions,
      projectReferences: cacheEntry.config.projectReferences,
      diskFiles: cacheEntry.diskFiles,
      liveFiles,
      fileVersions,
      overlayPaths: new Set(),
      defaultLibFilePath: resolveDefaultLibFilePath(cacheEntry.config.compilerOptions),
    }
    project = {
      ...draft,
      service: ts.createLanguageService(createLanguageServiceHost(draft)),
    }
    pooledProjects.set(poolKey, project)
  }

  // 只对账脏文件（overlay）：磁盘文件保持原版本号不动，TS 的增量缓存才留得住。
  const nextOverlayPaths = preserveExistingOverlays
    ? new Set(project.overlayPaths)
    : new Set<string>()
  for (const [path, content] of overlayFiles) {
    if (!TypeScriptExtensions.has(extensionWithDot(path))) continue
    setPooledFile(project, path, content)
    nextOverlayPaths.add(path)
  }

  for (const path of preserveExistingOverlays ? [] : project.overlayPaths) {
    if (nextOverlayPaths.has(path)) continue

    const diskContent = project.diskFiles.get(path)
    if (!isPresent(diskContent)) {
      project.liveFiles.delete(path)
      project.fileVersions.delete(path)
    } else {
      setPooledFile(project, path, diskContent)
    }
  }

  project.overlayPaths = nextOverlayPaths

  const acquiredProject = project
  return {
    service: project.service,
    files: project.liveFiles,
    compilerOptions: project.compilerOptions,
    config: cacheEntry.config,
    standardLibraryAvailable: isPresent(project.defaultLibFilePath),
    isCurrent: () => pooledProjects.get(poolKey) === acquiredProject,
  }
}

export { extensionWithDot, safeReadFile, SkippedDirectoryNames, TypeScriptExtensions }
