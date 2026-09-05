#!/usr/bin/env node
// Tracks every published Agent entrypoint and declaration symbol. The package root remains a
// compatibility umbrella, while new host integrations use the explicit runtime/host subpaths.
import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const Here = dirname(fileURLToPath(import.meta.url))
const RepoRoot = resolve(Here, '../..')
const AgentRoot = resolve(RepoRoot, 'packages/agent')
const DistRoot = resolve(AgentRoot, 'dist')
const ManifestPath = resolve(AgentRoot, 'package.json')
const PolicyPath = resolve(AgentRoot, 'docs/public-api-policy.json')
const BaselinePath = resolve(RepoRoot, 'baselines/agent/public-api.json')
const UpdateBaseline = process.env.VELAROS_AGENT_PUBLIC_API_UPDATE === '1'
const ReviewedChangeKind = process.env.VELAROS_AGENT_PUBLIC_API_CHANGE

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function collectDeclarationFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) return collectDeclarationFiles(path)
    return path.endsWith('.d.ts') ? [path] : []
  })
}

function exportTarget(definition, condition) {
  if (typeof definition === 'string') return condition === 'import' ? definition : undefined
  if (!definition || typeof definition !== 'object') return undefined
  const value = definition[condition]
  return typeof value === 'string' ? value : undefined
}

function canonicalTokens(source) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source,
  )
  const tokens = []
  while (true) {
    const token = scanner.scan()
    if (token === ts.SyntaxKind.EndOfFileToken) break
    tokens.push(scanner.getTokenText())
  }
  return tokens.join('\u001f')
}

function unwrapAlias(checker, symbol) {
  const seen = new Set()
  let current = symbol
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current)
    const target = checker.getAliasedSymbol(current)
    if (!target || target === current) break
    current = target
  }
  return current
}

function symbolKind(symbol) {
  const kinds = []
  if ((symbol.flags & ts.SymbolFlags.Type) !== 0) kinds.push('type')
  if ((symbol.flags & ts.SymbolFlags.Value) !== 0) kinds.push('value')
  if ((symbol.flags & ts.SymbolFlags.Namespace) !== 0) kinds.push('namespace')
  return kinds.length > 0 ? kinds : ['unknown']
}

function symbolDeclarationHash(checker, exportedSymbol, fallbackSource) {
  const symbol = unwrapAlias(checker, exportedSymbol)
  const declarations = symbol.getDeclarations() ?? []
  const signatures = declarations.map((declaration) => canonicalTokens(declaration.getText()))
  if (signatures.length === 0) {
    const location = symbol.valueDeclaration ?? fallbackSource
    signatures.push(
      checker.typeToString(
        checker.getTypeOfSymbolAtLocation(symbol, location),
        location,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType,
      ),
    )
  }
  signatures.sort()
  return createHash('sha256').update(signatures.join('\n')).digest('hex')
}

function hasDeprecatedTag(symbol) {
  return (symbol.getDeclarations() ?? []).some((declaration) => {
    if (ts.getJSDocTags(declaration).some((tag) => tag.tagName.text === 'deprecated')) return true
    const exportDeclaration = ts.isExportSpecifier(declaration)
      ? declaration.parent.parent
      : declaration
    return /@deprecated\b/u.test(exportDeclaration.getFullText())
  })
}

function exportedAlias(symbol) {
  for (const declaration of symbol.getDeclarations() ?? []) {
    if (!ts.isExportSpecifier(declaration) || !declaration.propertyName) continue
    return declaration.propertyName.text
  }
  return undefined
}

function buildSnapshot(manifest) {
  const declarationFiles = collectDeclarationFiles(DistRoot)
  if (declarationFiles.length === 0) {
    throw new Error('Agent declarations are missing; run `bun run --cwd packages/agent build` first.')
  }
  const program = ts.createProgram(declarationFiles, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  })
  const checker = program.getTypeChecker()
  const entries = {}
  const entrySymbols = new Map()

  for (const entrypoint of Object.keys(manifest.exports ?? {}).sort()) {
    const definition = manifest.exports[entrypoint]
    const typesTarget = exportTarget(definition, 'types')
    const importTarget = exportTarget(definition, 'import')
    if (!typesTarget || !importTarget) {
      throw new Error(`${entrypoint}: Agent exports require explicit types and import targets.`)
    }
    const declarationPath = resolve(AgentRoot, typesTarget)
    const sourceFile = program.getSourceFile(declarationPath)
    if (!sourceFile) throw new Error(`${entrypoint}: missing declaration target ${typesTarget}`)
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
    if (!moduleSymbol) throw new Error(`${entrypoint}: cannot resolve declaration module symbol`)

    const symbols = []
    const exportedSymbols = checker
      .getExportsOfModule(moduleSymbol)
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    entrySymbols.set(entrypoint, exportedSymbols)
    for (const exportedSymbol of exportedSymbols) {
      const target = unwrapAlias(checker, exportedSymbol)
      symbols.push([
        exportedSymbol.name,
        symbolKind(target).join(','),
        symbolDeclarationHash(checker, exportedSymbol, sourceFile),
      ].join('\t'))
    }
    entries[entrypoint] = {
      types: typesTarget,
      import: importTarget,
      symbols,
    }
  }

  return {
    snapshot: {
      schemaVersion: 1,
      packageName: manifest.name,
      acceptedPackageVersion: manifest.version,
      entries,
    },
    entrySymbols,
  }
}

function validatePolicy(manifest, policy, entrySymbols) {
  if (policy.schemaVersion !== 1) throw new Error('Unsupported Agent public API policy schema.')
  if (policy.rootEntrypoint?.status !== 'compatibility-umbrella') {
    throw new Error('Agent root entrypoint must remain declared as a compatibility umbrella.')
  }
  const removalMajor = policy.rootEntrypoint.earliestRemovalMajor
  if (!Number.isSafeInteger(removalMajor) || removalMajor < 1) {
    throw new Error('Agent root compatibility removal major must be a positive integer.')
  }
  for (const entrypoint of policy.rootEntrypoint.recommendedEntrypoints ?? []) {
    if (!manifest.exports?.[entrypoint]) {
      throw new Error(`Recommended Agent entrypoint is not exported: ${entrypoint}`)
    }
  }

  const rootSymbols = entrySymbols.get('.') ?? []
  const rootByName = new Map(rootSymbols.map((symbol) => [symbol.name, symbol]))
  const declaredAliases = new Map()
  for (const symbol of rootSymbols) {
    const target = exportedAlias(symbol)
    if (target) declaredAliases.set(symbol.name, target)
  }

  const managedAliases = new Map()
  for (const alias of policy.deprecatedAliases ?? []) {
    if (managedAliases.has(alias.name)) throw new Error(`Duplicate alias policy: ${alias.name}`)
    if (alias.entrypoint !== '.') throw new Error(`Unsupported deprecated alias entry: ${alias.name}`)
    if (!rootByName.has(alias.name)) throw new Error(`Deprecated alias is not exported: ${alias.name}`)
    if (!rootByName.has(alias.replacement)) {
      throw new Error(`Deprecated alias replacement is not exported: ${alias.replacement}`)
    }
    if (declaredAliases.get(alias.name) !== alias.replacement) {
      throw new Error(`${alias.name}: declaration target does not match ${alias.replacement}`)
    }
    if (!hasDeprecatedTag(rootByName.get(alias.name))) {
      throw new Error(`${alias.name}: declaration is missing an @deprecated marker`)
    }
    if (!Number.isSafeInteger(alias.earliestRemovalMajor) || alias.earliestRemovalMajor < removalMajor) {
      throw new Error(`${alias.name}: removal major cannot precede the root compatibility window`)
    }
    managedAliases.set(alias.name, alias.replacement)
  }
  for (const alias of policy.supportedAliases ?? []) {
    if (managedAliases.has(alias.name)) throw new Error(`Duplicate alias policy: ${alias.name}`)
    if (alias.entrypoint !== '.') throw new Error(`Unsupported alias entry: ${alias.name}`)
    if (!rootByName.has(alias.name) || !rootByName.has(alias.target)) {
      throw new Error(`Supported alias or target is not exported: ${alias.name}`)
    }
    if (declaredAliases.get(alias.name) !== alias.target) {
      throw new Error(`${alias.name}: declaration target does not match ${alias.target}`)
    }
    if (hasDeprecatedTag(rootByName.get(alias.name))) {
      throw new Error(`${alias.name}: supported alias must not carry an @deprecated marker`)
    }
    managedAliases.set(alias.name, alias.target)
  }

  const unmanaged = [...declaredAliases]
    .filter(([name, target]) => managedAliases.get(name) !== target)
    .map(([name, target]) => `${name} -> ${target}`)
  const stale = [...managedAliases]
    .filter(([name, target]) => declaredAliases.get(name) !== target)
    .map(([name, target]) => `${name} -> ${target}`)
  if (unmanaged.length > 0 || stale.length > 0) {
    throw new Error(
      [
        unmanaged.length > 0 ? `unmanaged root aliases: ${unmanaged.join(', ')}` : '',
        stale.length > 0 ? `stale root alias policy: ${stale.join(', ')}` : '',
      ].filter(Boolean).join('; '),
    )
  }
}

function describeDiff(before, after) {
  const changes = []
  const additions = []
  const modifications = []
  const removals = []
  const beforeEntries = before.entries ?? {}
  const afterEntries = after.entries ?? {}
  for (const entrypoint of [...new Set([...Object.keys(beforeEntries), ...Object.keys(afterEntries)])].sort()) {
    const previous = beforeEntries[entrypoint]
    const current = afterEntries[entrypoint]
    if (!previous) {
      const message = `+ entry ${entrypoint}`
      changes.push(message)
      additions.push(message)
      continue
    }
    if (!current) {
      const message = `- entry ${entrypoint}`
      changes.push(message)
      removals.push(message)
      continue
    }
    if (previous.types !== current.types || previous.import !== current.import) {
      const message = `~ entry targets ${entrypoint}`
      changes.push(message)
      modifications.push(message)
    }
    const previousSymbols = new Map(
      (previous.symbols ?? []).map((record) => [record.split('\t', 1)[0], record]),
    )
    const currentSymbols = new Map(
      (current.symbols ?? []).map((record) => [record.split('\t', 1)[0], record]),
    )
    for (const name of [...new Set([...previousSymbols.keys(), ...currentSymbols.keys()])].sort()) {
      if (!previousSymbols.has(name)) {
        const message = `+ ${entrypoint} ${name}`
        changes.push(message)
        additions.push(message)
      } else if (!currentSymbols.has(name)) {
        const message = `- ${entrypoint} ${name}`
        changes.push(message)
        removals.push(message)
      } else if (previousSymbols.get(name) !== currentSymbols.get(name)) {
        const message = `~ ${entrypoint} ${name}`
        changes.push(message)
        modifications.push(message)
      }
    }
  }
  return { additions, changes, modifications, removals }
}

function parseVersion(version, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(String(version))
  if (!match) throw new Error(`${label} is not a supported semantic version: ${version}`)
  return match.slice(1).map(Number)
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function validateBaseline(baseline, manifest) {
  if (baseline.schemaVersion !== 1) {
    throw new Error(`Unsupported Agent public API baseline schema: ${baseline.schemaVersion}`)
  }
  if (baseline.packageName !== manifest.name) {
    throw new Error(
      `Agent public API baseline belongs to ${baseline.packageName ?? 'an unknown package'}, expected ${manifest.name}.`,
    )
  }
  parseVersion(baseline.acceptedPackageVersion, 'Baseline package version')
  if (!baseline.entries || typeof baseline.entries !== 'object' || Array.isArray(baseline.entries)) {
    throw new Error('Agent public API baseline entries must be an object.')
  }
}

const manifest = readJson(ManifestPath)
const policy = readJson(PolicyPath)
const { snapshot, entrySymbols } = buildSnapshot(manifest)
validatePolicy(manifest, policy, entrySymbols)
const serialized = `${JSON.stringify(snapshot, null, 2)}\n`

if (ReviewedChangeKind && !['additive', 'breaking'].includes(ReviewedChangeKind)) {
  throw new Error('VELAROS_AGENT_PUBLIC_API_CHANGE must be `additive` or `breaking`.')
}

if (!existsSync(BaselinePath)) {
  if (!UpdateBaseline) {
    throw new Error(
      'Agent public API baseline is missing. Review the surface, then run with VELAROS_AGENT_PUBLIC_API_UPDATE=1.',
    )
  }
  writeFileSync(BaselinePath, serialized)
  console.log(`Created ${relative(RepoRoot, BaselinePath)}.`)
  process.exit(0)
}

const baseline = readJson(BaselinePath)
validateBaseline(baseline, manifest)
const previousVersion = parseVersion(baseline.acceptedPackageVersion, 'Baseline package version')
const currentVersion = parseVersion(manifest.version, 'Agent package version')
const versionComparison = compareVersions(currentVersion, previousVersion)
if (versionComparison < 0) {
  throw new Error(
    `Agent package version ${manifest.version} precedes the reviewed API baseline ${baseline.acceptedPackageVersion}.`,
  )
}
const { additions, changes, modifications, removals } = describeDiff(baseline, snapshot)
if (changes.length === 0) {
  if (versionComparison > 0) {
    if (!UpdateBaseline) {
      throw new Error(
        `Agent public API declarations are unchanged, but the baseline is still bound to package version ${baseline.acceptedPackageVersion}. Run with VELAROS_AGENT_PUBLIC_API_UPDATE=1 to bind it to ${manifest.version}.`,
      )
    }
    writeFileSync(BaselinePath, serialized)
    console.log(
      `Updated ${relative(RepoRoot, BaselinePath)} package version binding (${baseline.acceptedPackageVersion} -> ${manifest.version}); declarations are unchanged.`,
    )
    process.exit(0)
  }
  console.log(`Agent public API matches ${relative(RepoRoot, BaselinePath)}.`)
  process.exit(0)
}

if (UpdateBaseline) {
  if (versionComparison <= 0) {
    throw new Error(
      `Agent public API changed without a package version increase (${baseline.acceptedPackageVersion} -> ${manifest.version}).`,
    )
  }
  if (removals.length > 0 && ReviewedChangeKind === 'additive') {
    throw new Error(`Removed declarations cannot be reviewed as additive:\n${removals.slice(0, 40).join('\n')}`)
  }
  const destructive = removals.length > 0 ||
    (modifications.length > 0 && ReviewedChangeKind !== 'additive')
  if (destructive && currentVersion[0] <= previousVersion[0]) {
    throw new Error(
      `Agent public API has destructive or unclassified declaration changes without a major version increase (${baseline.acceptedPackageVersion} -> ${manifest.version}):\n${[...removals, ...modifications].slice(0, 40).join('\n')}\nSet VELAROS_AGENT_PUBLIC_API_CHANGE=additive only after reviewing changed declarations as backward compatible.`,
    )
  }
  writeFileSync(BaselinePath, serialized)
  console.log(
    `Updated ${relative(RepoRoot, BaselinePath)} with ${additions.length} additive, ${modifications.length} modified and ${removals.length} removed declaration(s).`,
  )
  process.exit(0)
}

throw new Error(
  `Agent public API differs from the reviewed baseline (${changes.length} change(s)):\n${changes.slice(0, 60).join('\n')}${changes.length > 60 ? '\n…' : ''}\nReview compatibility, then run with VELAROS_AGENT_PUBLIC_API_UPDATE=1.`,
)
