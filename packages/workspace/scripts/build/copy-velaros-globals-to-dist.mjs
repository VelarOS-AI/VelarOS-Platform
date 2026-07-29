#!/usr/bin/env node
// Historical filename retained for package build-script compatibility.
// Converts repository-only ambient aliases into private module imports.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'

const distDirectory = join(process.cwd(), 'dist')
const ambientDeclaration = join(distDirectory, 'velaros-globals.d.ts')
const utilityDirectory = join(distDirectory, 'internal')
const utilityDeclaration = join(utilityDirectory, 'utility-types.d.ts')
const utilityTypeNames = [
  'JsonStringifyReplacer',
  'JsonStringifyReplacerValue',
  'LooseOptional',
  'Nullable',
  'Nullish',
  'PlainObject',
]

if (!existsSync(distDirectory)) {
  throw new Error(`Missing declaration output directory: ${distDirectory}`)
}

// Source triple-references remain an implementation detail of this monorepo.
// A published package must never add helper aliases to its consumer's global scope.
rmSync(ambientDeclaration, { force: true })
mkdirSync(utilityDirectory, { recursive: true })
writeFileSync(
  utilityDeclaration,
  `export type Nullish = undefined | null
export type Nullable<T> = T | null
export type PlainObject = Record<string, unknown>
export type JsonStringifyReplacerValue =
  | ((this: any, key: string, value: any) => any)
  | Array<string | number>
export type JsonStringifyReplacer = Nullable<JsonStringifyReplacerValue>
export type LooseOptional<T> = T | Nullish
`,
)

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

  const relativeUtilityPath = relative(
    dirname(declarationFile),
    utilityDeclaration,
  )
    .split('\\')
    .join('/')
    .replace(/\.d\.ts$/u, '.js')
  const moduleSpecifier = relativeUtilityPath.startsWith('.')
    ? relativeUtilityPath
    : `./${relativeUtilityPath}`
  const typeImport =
    `import type { ${referencedTypes.join(', ')} } from '${moduleSpecifier}'\n`

  if (!sourceText.startsWith(typeImport)) {
    writeFileSync(declarationFile, `${typeImport}${sourceText}`)
  }
}
