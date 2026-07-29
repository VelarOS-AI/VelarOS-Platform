#!/usr/bin/env node
// 用途：锁定 @velaros-ai/memory 三切片（主干 / knowledge / adapter-kernel）的职责与宿主无关边界。

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
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

// P7a 合包后:Memory 产品是**一个安装单元、三个切片**(主干 / knowledge / adapter-kernel)。
// 包清单层再也承载不了「主干不得依赖向量域」——knowledge 切片自己就要 lancedb;边界因此整条
// 下沉到**切片源码层**:每条规则只扫自己的源码子树,跨切片访问按 forbiddenReach / mustStayInSlice
// 方向矩阵裁决(相对说明符解析成绝对路径后比对)。这是「记忆与上下文永不合并」的接缝在合包后的
// 落点,方向与合包前逐条等价,不是放宽。
const MemoryPackageRoot = 'packages/memory'
const ProductRules = [
  {
    label: 'Memory 主干',
    sourceRoot: 'src',
    excludeRoots: ['src/knowledge', 'src/adapter-kernel'],
    forbidden: [
      '@velaros-ai/memory/knowledge',
      '@lancedb/lancedb',
      'apache-arrow',
    ],
    forbiddenReach: ['src/knowledge', 'src/adapter-kernel'],
    message: 'Memory 主干不得包含或依赖 Knowledge/向量域(也不得反向依赖 Kernel 适配器)。',
  },
  {
    label: 'Knowledge 切片',
    sourceRoot: 'src/knowledge',
    excludeRoots: [],
    forbidden: ['@velaros-ai/memory'],
    forbiddenReach: [],
    // 合包前 Knowledge 是独立包,物理上够不着记忆树;等价约束 = 相对说明符不得逃出本切片。
    mustStayInSlice: true,
    message: 'Knowledge 切片不得反向依赖长期记忆树或 Kernel 适配器。',
  },
  {
    label: 'Memory Kernel 适配器切片',
    sourceRoot: 'src/adapter-kernel',
    excludeRoots: [],
    forbidden: [
      '@velaros-ai/memory/knowledge',
      '@lancedb/lancedb',
      'apache-arrow',
    ],
    forbiddenReach: ['src/knowledge'],
    message: 'Memory Kernel 适配器不得依赖 Knowledge/向量域。',
  },
]
const PortableContractRules = [
  {
    packageName: '@velaros-ai/memory',
    packageRoot: 'packages/memory',
    exportKey: './contracts',
    contractsFile: 'src/contracts.ts',
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
    packageName: '@velaros-ai/memory/knowledge',
    packageRoot: 'packages/memory',
    exportKey: './knowledge/contracts',
    contractsFile: 'src/knowledge/contracts.ts',
    sourceModules: new Map([
      ['./knowledge/domain/Types.js', {
        path: 'src/knowledge/knowledge/domain/Types.ts',
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
  repoRoot = resolve(import.meta.dirname, '../..'),
) {
  const violations = []

  const packageRoot = resolve(repoRoot, MemoryPackageRoot)
  const manifestPath = resolve(packageRoot, 'package.json')
  if (!existsSync(manifestPath)) {
    violations.push(`${MemoryPackageRoot}/package.json：缺少包清单。`)
    return violations
  }

  for (const rule of ProductRules) {
    const sliceRoot = resolve(packageRoot, rule.sourceRoot)
    const excluded = rule.excludeRoots.map((entry) => resolve(packageRoot, entry))
    const forbiddenReach = rule.forbiddenReach.map((entry) => resolve(packageRoot, entry))

    for (const file of walkFiles(sliceRoot)) {
      if (!SourceFilePattern.test(file)) continue
      if (excluded.some((entry) => file.startsWith(`${entry}/`))) continue
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
        if (!specifier.startsWith('.')) continue
        const reached = resolve(dirname(file), specifier)
        if (rule.mustStayInSlice && !reached.startsWith(`${sliceRoot}/`)) {
          violations.push(
            `${relative(repoRoot, file)}：相对 import ${specifier} 逃出 ${rule.sourceRoot}/ 切片；${rule.message}`,
          )
        }
        if (forbiddenReach.some((entry) => reached.startsWith(`${entry}/`))) {
          violations.push(
            `${relative(repoRoot, file)}：相对 import ${specifier} 触达禁止切片；${rule.message}`,
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

  process.stdout.write('Memory 产品边界检查通过：三切片职责与宿主边界无漂移。\n')
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) run()
