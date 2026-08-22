#!/usr/bin/env node
// 将仓库内的 ambient 工具类型改写为包内私有类型导入，避免污染消费者的全局作用域。
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'

const distDirectory = join(process.cwd(), 'dist')
const ambientDeclaration = join(distDirectory, 'velaros-globals.d.ts')
const utilityDirectory = join(distDirectory, 'internal')
const utilityDeclaration = join(utilityDirectory, 'utility-types.d.ts')
const utilityModuleArgumentIndex = process.argv.indexOf('--utility-module')
const configuredUtilityModule = utilityModuleArgumentIndex >= 0
  ? process.argv[utilityModuleArgumentIndex + 1]
  : undefined
if (utilityModuleArgumentIndex >= 0 && !configuredUtilityModule) {
  throw new Error('--utility-module requires a module specifier')
}
const utilityTypeNames = [
  'JsonStringifyReplacer',
  'JsonStringifyReplacerValue',
  'LooseOptional',
  'Nullable',
  'Nullish',
  'Optional',
  'PlainObject',
]

if (!existsSync(distDirectory)) {
  throw new Error(`Missing declaration output directory: ${distDirectory}`)
}

rmSync(ambientDeclaration, { force: true })
if (!configuredUtilityModule) {
  mkdirSync(utilityDirectory, { recursive: true })
  writeFileSync(
    utilityDeclaration,
    `export type Nullish = undefined | null
export type Optional<T> = T | undefined
export type Nullable<T> = T | null
export type PlainObject = Record<string, unknown>
export type JsonStringifyReplacerValue =
  | ((this: any, key: string, value: any) => any)
  | Array<string | number>
export type JsonStringifyReplacer = Nullable<JsonStringifyReplacerValue>
export type LooseOptional<T> = T | Nullish
`,
  )
}

function collectDeclarationFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const filePath = join(directory, entry)
    return statSync(filePath).isDirectory()
      ? collectDeclarationFiles(filePath)
      : /\.d\.[cm]?ts$/u.test(filePath) && filePath !== utilityDeclaration
        ? [filePath]
        : []
  })
}

for (const declarationFile of collectDeclarationFiles(distDirectory)) {
  const sourceText = readFileSync(declarationFile, 'utf8')
  const locallyDeclaredTypes = new Set(
    utilityTypeNames.filter((name) =>
      new RegExp(`\\b(?:export\\s+)?type\\s+${name}\\b`, 'u').test(sourceText),
    ),
  )
  const referencedTypes = utilityTypeNames.filter((name) =>
    !locallyDeclaredTypes.has(name)
    && new RegExp(`\\b${name}\\b`, 'u').test(sourceText),
  )
  if (referencedTypes.length === 0) continue

  const relativeUtilityPath = relative(dirname(declarationFile), utilityDeclaration)
    .split('\\')
    .join('/')
    .replace(/\.d\.ts$/u, '.js')
  const moduleSpecifier = configuredUtilityModule
    ?? (relativeUtilityPath.startsWith('.') ? relativeUtilityPath : `./${relativeUtilityPath}`)
  const typeImport =
    `import type { ${referencedTypes.join(', ')} } from '${moduleSpecifier}'\n`

  if (!sourceText.startsWith(typeImport)) {
    writeFileSync(declarationFile, `${typeImport}${sourceText}`)
  }
}
