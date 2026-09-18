#!/usr/bin/env node
// 用途：锁定 velar:memory 与 velar:knowledge 两个能力单元（都在 @velaros-ai/velar 里）的职责与宿主无关边界。

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const SourceFilePattern = /\.[cm]?[jt]sx?$/u
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
  '@velaros-ai/agent/protocol',
  '@velaros-ai/core/memory',
  '@velaros-ai/core/utils/EmbeddingModelSelection',
  '@velaros-ai/core/utils/PathContainmentHelper',
  '@velaros-ai/core/utils/PlatformCompatibilityHelper',
  '@velaros-ai/core/utils/ProviderRuntimeAvailability',
]
const ProductToolNames = [
  'workspace_add_root',
]

// 单元旁边的验收与测试不算源码：它们要读构建产物（../../dist/…）与仓里的生成物，本来就在单元外面。
const CompanionDirectories = new Set(['spec', 'test'])

// 「记忆与上下文永不合并」是域宪章级的判决。合包那一轮它靠切片源码层的方向矩阵守着，拆包之后靠包边界；
// 两边整包并进 @velaros-ai/velar 之后，这条接缝落在单元边界上——两个单元互不 import（包的子路径、代码面的模块名、
// 相对路径都不行），各自保持宿主无关。方向与并包前逐条等价，不是放宽。
const ProductRules = [
  {
    label: 'velar:memory 单元',
    packageRoot: 'packages/velar',
    sourceRoot: 'memory',
    forbidden: [
      '@velaros-ai/velar/knowledge',
      'velar:knowledge',
      '@lancedb/lancedb',
      'apache-arrow',
    ],
    message: '长期记忆不得包含或依赖 Knowledge/向量域。',
  },
  {
    label: 'velar:knowledge 单元',
    packageRoot: 'packages/velar',
    sourceRoot: 'knowledge',
    forbidden: ['@velaros-ai/velar/memory', 'velar:memory'],
    message: 'Knowledge 不得反向依赖长期记忆树或它的 Kernel 适配器。',
  },
]
const PortableContractRules = [
  {
    packageName: '@velaros-ai/velar/memory',
    packageRoot: 'packages/velar',
    exportKey: './memory/contracts',
    contractsFile: 'memory/contracts.ts',
    // 键是入口里 import 的原文（含 .js），不是磁盘路径：搬家时两者必须一起改，否则这道门必红。
    // `valueExport` 的是常量表与生成的模型面：它们随 ./memory/contracts 出包，入口里是值导出（不是 type-only）。
    sourceModules: new Map([
      ['./types/memory.js', {
        path: 'memory/types/memory.ts',
        allowedImports: new Set(['../contract/constants.js']),
      }],
      ['./contract/constants.js', {
        path: 'memory/contract/constants.ts',
        allowedImports: new Set(),
        valueExport: true,
      }],
      ['./contract/surface.js', {
        path: 'memory/contract/surface.ts',
        allowedImports: new Set(),
        valueExport: true,
      }],
    ]),
    requiredTypes: [
      'MemoryDreamRunResult',
      'MemoryTreeDiagnostics',
    ],
  },
  {
    packageName: '@velaros-ai/velar/knowledge',
    packageRoot: 'packages/velar',
    exportKey: './knowledge/contracts',
    contractsFile: 'knowledge/contracts.ts',
    // 键是入口里 import 的原文（含 .js），不是磁盘路径：搬家时两者必须一起改，否则这道门必红。
    sourceModules: new Map([
      ['./types/knowledge.js', {
        path: 'knowledge/types/knowledge.ts',
        allowedImports: new Set(['../contract/constants.js']),
      }],
      ['./contract/constants.js', {
        path: 'knowledge/contract/constants.ts',
        allowedImports: new Set(),
        valueExport: true,
      }],
      ['./contract/surface.js', {
        path: 'knowledge/contract/surface.ts',
        allowedImports: new Set(),
        valueExport: true,
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
  repoRoot = resolve(import.meta.dirname, '../..'),
) {
  const violations = []

  for (const rule of ProductRules) {
    const packageRoot = resolve(repoRoot, rule.packageRoot)
    const manifestPath = resolve(packageRoot, 'package.json')
    if (!existsSync(manifestPath)) {
      violations.push(`${rule.packageRoot}/package.json：缺少包清单。`)
      continue
    }
    const sliceRoot = resolve(packageRoot, rule.sourceRoot)

    for (const file of walkFiles(sliceRoot, CompanionDirectories)) {
      if (!SourceFilePattern.test(file)) continue
      const source = readFileSync(file, 'utf8')
      for (const toolName of ProductToolNames) {
        if (!source.includes(toolName)) continue
        violations.push(
          `${relative(repoRoot, file)}：引用宿主工具 ${toolName} 违反边界；${rule.label}只能描述自己的输入端口。`,
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
            `${relative(repoRoot, file)}：import ${specifier} 违反边界；${rule.label}必须保持宿主无关。`,
          )
        }
        if (matchesAnySpecifier(specifier, KernelConcreteDomainSpecifiers)) {
          violations.push(
            `${relative(repoRoot, file)}：import ${specifier} 违反边界；${rule.label}必须自持领域 DTO，并通过宿主端口注入 Model/Workspace/Chat 语义。`,
          )
        }
        if (!specifier.startsWith('.')) continue
        // 并包之后，「逃不出自己的单元目录」就是单元边界本身：相对 import 不许跨单元。
        const reached = resolve(dirname(file), specifier)
        if (!reached.startsWith(`${sliceRoot}${sep}`)) {
          violations.push(
            `${relative(repoRoot, file)}：相对 import ${specifier} 逃出 ${rule.packageRoot}/${rule.sourceRoot}/；${rule.message}`,
          )
        }
      }
    }
  }

  return violations
}

export function collectPortableContractViolations(
  repoRoot = resolve(import.meta.dirname, '../..'),
) {
  const violations = []
  for (const rule of PortableContractRules) {
    const packageRoot = resolve(repoRoot, rule.packageRoot)
    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
    )
    const contractsExport = manifest.exports?.[rule.exportKey]
    const contractsDist = `./dist/${rule.contractsFile.replace(/^src\//u, '').replace(/\.ts$/u, '')}`
    if (
      contractsExport?.types !== `${contractsDist}.d.ts`
      || contractsExport?.import !== `${contractsDist}.js`
    ) {
      violations.push(
        `${rule.packageName}/contracts：必须显式发布 ${contractsDist}.d.ts 与 ${contractsDist}.js。`,
      )
    }

    const contractsPath = resolve(packageRoot, rule.contractsFile)
    if (!existsSync(contractsPath)) {
      violations.push(`${rule.packageName}/contracts：缺少 ${rule.contractsFile}。`)
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
        || !statement.moduleSpecifier
        || !ts.isStringLiteralLike(statement.moduleSpecifier)
      ) {
        violations.push(
          `${rule.packageName}/contracts：入口只能包含显式模块导出。`,
        )
        continue
      }
      const sourceRule = rule.sourceModules.get(statement.moduleSpecifier.text)
      if (!sourceRule) {
        violations.push(
          `${rule.packageName}/contracts：禁止导出实现模块 ${statement.moduleSpecifier.text}。`,
        )
        continue
      }
      if (!statement.isTypeOnly && !sourceRule.valueExport) {
        violations.push(
          `${rule.packageName}/contracts：${statement.moduleSpecifier.text} 只能 type-only 导出。`,
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
        // 常量表本身就是运行时值（Object.freeze 的表与 as const 字符串身份），它随 ./contracts 出包。
        if (sourceRule.valueExport && ts.isVariableStatement(statement)) {
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

function walkFiles(root, skippedDirectories = new Set()) {
  if (!existsSync(root)) return []
  const files = []
  for (const entry of readdirSync(root)) {
    const path = resolve(root, entry)
    if (statSync(path).isDirectory()) {
      if (!skippedDirectories.has(entry)) files.push(...walkFiles(path))
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

  process.stdout.write('Memory 产品边界检查通过：记忆与知识两个单元的职责与宿主边界无漂移。\n')
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) run()
