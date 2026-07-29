#!/usr/bin/env node
// Historical filename retained for build-script compatibility.
// Converts repository-only ambient helper aliases into private module imports in published declarations.
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
const helperDirectory = join(distDirectory, 'internal')
const helperDeclaration = join(helperDirectory, 'utility-types.d.ts')
const helperTypeNames = [
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

// Source triple-references exist only to compile the monorepo. Published packages
// must never contribute ambient aliases to a consumer's global declaration scope.
rmSync(ambientDeclaration, { force: true })
mkdirSync(helperDirectory, { recursive: true })
writeFileSync(
  helperDeclaration,
  `export type Nullish = undefined | null
export type Nullable<T> = T | null
export type PlainObject = Record<string, unknown>
export type JsonStringifyReplacerValue =
  | ((this: any, key: string, value: any) => any)
  | Array<string | number>
export type JsonStringifyReplacer = Nullable<JsonStringifyReplacerValue>
export type LooseOptional<T> = T | Nullish
`
)

function collectDeclarationFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const filePath = join(directory, entry)
    return statSync(filePath).isDirectory()
      ? collectDeclarationFiles(filePath)
      : filePath.endsWith('.d.ts') && filePath !== helperDeclaration
        ? [filePath]
        : []
  })
}

for (const declarationFile of collectDeclarationFiles(distDirectory)) {
  const sourceText = readFileSync(declarationFile, 'utf8')
  const referencedTypes = helperTypeNames.filter((name) =>
    new RegExp(`\\b${name}\\b`, 'u').test(sourceText)
  )
  if (referencedTypes.length === 0) continue

  const relativeHelperPath = relative(
    dirname(declarationFile),
    helperDeclaration
  )
    .split('\\')
    .join('/')
    .replace(/\.d\.ts$/u, '.js')
  const moduleSpecifier = relativeHelperPath.startsWith('.')
    ? relativeHelperPath
    : `./${relativeHelperPath}`
  const typeImport =
    `import type { ${referencedTypes.join(', ')} } from '${moduleSpecifier}'\n`
  if (!sourceText.startsWith(typeImport)) {
    writeFileSync(declarationFile, `${typeImport}${sourceText}`)
  }
}
