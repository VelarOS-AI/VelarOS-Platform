#!/usr/bin/env node
// 用途：锁定 Memory、Knowledge、Kernel 适配器三包及宿主无关边界。

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const SourceFilePattern = /\.[cm]?[jt]sx?$/u
const DependencySections = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
]
const HostSpecifierPrefixes = [
  'electron',
  '@electron/',
  '@velaros/ipc',
  '@shared/',
  '@/',
  '@preload',
  '@main/',
]
const KernelConcreteDomainSpecifiers = [
  '@velaros-ai/core/types',
  '@velaros-ai/core/constants/chat',
  '@velaros-ai/core/constants/storage',
  '@velaros-ai/core/constants/workspaceSpaces',
  '@velaros-ai/core/constants/workspaceVisibility',
  '@velaros-ai/core/memory',
  '@velaros-ai/core/utils/EmbeddingModelSelection',
  '@velaros-ai/core/utils/PathContainmentHelper',
  '@velaros-ai/core/utils/PlatformCompatibilityHelper',
  '@velaros-ai/core/utils/ProviderRuntimeAvailability',
]
const ProductToolNames = [
  'workspace_add_root',
]

const ProductRules = [
  {
    label: 'Memory',
    packageRoot: 'packages/memory',
    forbidden: [
      '@velaros-ai/knowledge',
      '@lancedb/lancedb',
      'apache-arrow',
    ],
    message: 'Memory 包不得包含或依赖 Knowledge/向量域。',
  },
  {
    label: 'Knowledge',
    packageRoot: 'packages/knowledge',
    forbidden: [
      '@velaros-ai/memory',
      '@velaros-ai/memory-adapter-kernel',
    ],
    message: 'Knowledge 包不得反向依赖长期记忆树或 Kernel 适配器。',
  },
  {
    label: 'Memory Kernel 适配器',
    packageRoot: 'packages/memory-adapter-kernel',
    forbidden: [
      '@velaros-ai/knowledge',
      '@lancedb/lancedb',
      'apache-arrow',
    ],
    message: 'Memory Kernel 适配器不得依赖 Knowledge/向量域。',
  },
]
const PortableContractRules = [
  {
    packageName: '@velaros-ai/memory',
    packageRoot: 'packages/memory',
    sourceModules: new Map([
      ['./memory-tree/Types.js', {
        path: 'src/memory-tree/Types.ts',
        allowedImports: new Set(),
      }],
    ]),
    requiredTypes: [
      'MemoryDreamRunResult',
      'MemoryTreeDiagnostics',
    ],
  },
  {
    packageName: '@velaros-ai/knowledge',
    packageRoot: 'packages/knowledge',
    sourceModules: new Map([
      ['./knowledge/domain/Types.js', {
        path: 'src/knowledge/domain/Types.ts',
        allowedImports: new Set(['../../Constants']),
      }],
    ]),
    requiredTypes: [
      'KnowledgeDiagnostics',
      'KnowledgeReindexOptions',
      'KnowledgeReindexResult',
      'KnowledgeWorkspaceSyncOptions',
      'KnowledgeWorkspaceSyncResult',
    ],
  },
]

export function collectProductBoundaryViolations(
  repoRoot = resolve(import.meta.dirname, '..'),
) {
  const violations = []

  for (const rule of ProductRules) {
    const packageRoot = resolve(repoRoot, rule.packageRoot)
    const manifestPath = resolve(packageRoot, 'package.json')
    if (!existsSync(manifestPath)) {
      violations.push(`${rule.packageRoot}/package.json：缺少包清单。`)
      continue
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const section of DependencySections) {
      for (const dependency of Object.keys(manifest[section] ?? {})) {
        if (!matchesAnySpecifier(dependency, rule.forbidden)) continue
        violations.push(
          `${relative(repoRoot, manifestPath)}：${section} 中的 ${dependency} 违反边界；${rule.message}`,
        )
      }
    }

    for (const file of walkFiles(resolve(packageRoot, 'src'))) {
      if (!SourceFilePattern.test(file)) continue
      const source = readFileSync(file, 'utf8')
      for (const toolName of ProductToolNames) {
        if (!source.includes(toolName)) continue
        violations.push(
          `${relative(repoRoot, file)}：引用宿主工具 ${toolName} 违反边界；${rule.label} 包只能描述自己的输入端口。`,
        )
      }
      for (const specifier of extractModuleSpecifiers(source, file)) {
        if (matchesAnySpecifier(specifier, rule.forbidden)) {
          violations.push(
            `${relative(repoRoot, file)}：import ${specifier} 违反边界；${rule.message}`,
          )
        }
        if (isHostSpecifier(specifier)) {
          violations.push(
            `${relative(repoRoot, file)}：import ${specifier} 违反边界；${rule.label} 包必须保持宿主无关。`,
          )
        }
        if (matchesAnySpecifier(specifier, KernelConcreteDomainSpecifiers)) {
          violations.push(
            `${relative(repoRoot, file)}：import ${specifier} 违反边界；${rule.label} 必须自持领域 DTO，并通过宿主端口注入 Model/Workspace/Chat 语义。`,
          )
        }
      }
    }
  }

  return violations
}

export function collectPortableContractViolations(
  repoRoot = resolve(import.meta.dirname, '..'),
) {
  const violations = []
  for (const rule of PortableContractRules) {
    const packageRoot = resolve(repoRoot, rule.packageRoot)
    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
    )
    const contractsExport = manifest.exports?.['./contracts']
    if (
      contractsExport?.types !== './dist/contracts.d.ts'
      || contractsExport?.import !== './dist/contracts.js'
    ) {
      violations.push(
        `${rule.packageName}/contracts：必须显式发布 dist/contracts.d.ts 与 dist/contracts.js。`,
      )
    }

    const contractsPath = resolve(packageRoot, 'src/contracts.ts')
    if (!existsSync(contractsPath)) {
      violations.push(`${rule.packageName}/contracts：缺少 src/contracts.ts。`)
      continue
    }

    const contractsSource = readFileSync(contractsPath, 'utf8')
    const contractsFile = ts.createSourceFile(
      contractsPath,
      contractsSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    for (const statement of contractsFile.statements) {
      if (
        !ts.isExportDeclaration(statement)
        || !statement.isTypeOnly
        || !statement.moduleSpecifier
        || !ts.isStringLiteralLike(statement.moduleSpecifier)
      ) {
        violations.push(
          `${rule.packageName}/contracts：入口只能包含显式 type-only 模块导出。`,
        )
        continue
      }
      if (!rule.sourceModules.has(statement.moduleSpecifier.text)) {
        violations.push(
          `${rule.packageName}/contracts：禁止导出实现模块 ${statement.moduleSpecifier.text}。`,
        )
      }
    }

    const typeSources = []
    for (const [specifier, sourceRule] of rule.sourceModules) {
      const sourcePath = resolve(packageRoot, sourceRule.path)
      const source = readFileSync(sourcePath, 'utf8')
      typeSources.push(source)
      const sourceFile = ts.createSourceFile(
        sourcePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
      for (const statement of sourceFile.statements) {
        if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
          continue
        }
        if (
          ts.isImportDeclaration(statement)
          && statement.importClause?.isTypeOnly
          && ts.isStringLiteralLike(statement.moduleSpecifier)
          && sourceRule.allowedImports.has(statement.moduleSpecifier.text)
        ) {
          continue
        }
        violations.push(
          `${rule.packageName}/contracts：类型源 ${specifier} 含有运行时声明或未授权 import。`,
        )
      }
    }

    const joinedTypeSources = typeSources.join('\n')
    for (const typeName of rule.requiredTypes) {
      const declaration = new RegExp(
        `\\bexport\\s+(?:interface|type)\\s+${typeName}\\b`,
        'u',
      )
      if (!declaration.test(joinedTypeSources)) {
        violations.push(
          `${rule.packageName}/contracts：缺少必须的公共类型 ${typeName}。`,
        )
      }
    }
  }
  return violations
}

export function extractModuleSpecifiers(source, fileName = 'module.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    resolveScriptKind(fileName),
  )
  const specifiers = new Set()

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.add(node.moduleReference.expression.text)
    } else if (
      ts.isCallExpression(node)
      && node.arguments.length > 0
      && ts.isStringLiteralLike(node.arguments[0])
      && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      )
    ) {
      specifiers.add(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return [...specifiers]
}

function matchesAnySpecifier(specifier, forbidden) {
  return forbidden.some(
    (candidate) =>
      specifier === candidate || specifier.startsWith(`${candidate}/`),
  )
}

function isHostSpecifier(specifier) {
  return (
    HostSpecifierPrefixes.some(
      (prefix) =>
        specifier === prefix || specifier.startsWith(prefix),
    )
    || specifier.includes('apps/desktop/')
  )
}

function resolveScriptKind(fileName) {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.TS
}

function walkFiles(root) {
  if (!existsSync(root)) return []
  const files = []
  for (const entry of readdirSync(root)) {
    const path = resolve(root, entry)
    if (statSync(path).isDirectory()) {
      files.push(...walkFiles(path))
    } else {
      files.push(path)
    }
  }
  return files
}

function run() {
  const violations = [
    ...collectProductBoundaryViolations(),
    ...collectPortableContractViolations(),
  ]
  if (violations.length > 0) {
    process.stderr.write(
      `Memory 产品边界检查失败：\n${violations
        .map((item) => `- ${item}`)
        .join('\n')}\n`,
    )
    process.exitCode = 1
    return
  }

  process.stdout.write('Memory 产品边界检查通过：三包职责与宿主边界无漂移。\n')
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) run()
