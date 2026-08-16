#!/usr/bin/env node
/**
 * 用途:内核宪章 §12.9「组件形态封闭」执法门——`@velaros-ai/ui` 组件的**逃生口**只降不升。
 *
 * 法条:组件库不搞通用、只做统一、可组合;**不开 className/style 逃生口**、**不做 ComponentProps
 * 全展开**(DOM-prop 展开面 = prop 爆炸的通用病征)。单点特殊设计走消费方本地外貌 + 复用能力层,禁回灌组件库。
 *
 * 本门看 `packages/ui/src` 下的组件 props 契约,逐条记账两类逃生口:
 *   1. **ComponentProps 全展开**:props 继承 / 交叉了 `React.ComponentProps` / `ComponentPropsWithoutRef`
 *      / `HTMLAttributes` / `SVGProps` / `JSX.IntrinsicElements[...]` 等 DOM 全属性面(含 `Omit<…>` / `Pick<…>` 包裹)。
 *   2. **className/style 透传**:props 声明 `className` / `style` / `*ClassName` 成员。
 *
 * 扫描面覆盖以下三类等价写法：
 *   ① **内联对象字面量 props**:`({ className }: { className?: string })`(CardKit 六件即此形态);
 *   ② **`Pick<X,'className'>` / `Omit<DOM,…> & { className?: string }` 转发**:出现在参数标注上或
 *      `*Props` 类型别名右侧,不是 interface 成员,原成员扫描直接跳过;
 *   ③ **导出 className 拼接函数**:`export function getXxxClassName(className?: string): string`
 *      ——把透传口从 prop 挪到函数签名,逃生口本质不变(TopBarControlFrame 四个)。
 * 契约面因此是 `*Props` 声明、全部参数类型标注与导出的 `*ClassName` 函数。指纹锚定
 * 声明名且与行号无关；基线只允许收缩。
 */
import { basename } from 'node:path'

import ts from 'typescript'

import {
  collectFiles,
  isInsideDirectory,
  runRatchet,
  toRelativePath,
  UiSourceDir,
} from './archGateLib.mjs'

const SourceExtensions = new Set(['.ts', '.tsx'])
const PropsDeclarationSuffix = 'Props'
const DomSpreadHeritageNames = new Set([
  'ComponentProps',
  'ComponentPropsWithoutRef',
  'ComponentPropsWithRef',
  'HTMLAttributes',
  'HTMLProps',
  'DetailedHTMLProps',
  'AllHTMLAttributes',
  'SVGProps',
  'SVGAttributes',
])
const ClassNamePassthroughMembers = new Set(['className', 'style'])

function collectPropsDeclarations(sourceFile) {
  const declarations = []
  function visit(node) {
    if (
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      node.name.text.endsWith(PropsDeclarationSuffix)
    ) {
      declarations.push({ name: node.name.text, node })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return declarations
}

function collectHeritageText(node) {
  if (ts.isInterfaceDeclaration(node)) {
    const clauses = node.heritageClauses
    if (!clauses || clauses.length === 0) return null
    return clauses.map((clause) => clause.getText()).join(' ')
  }
  // 类型别名:只有 RHS 引用了 DOM 全属性面才算(如 `type FooProps = React.ComponentProps<'code'>`)。
  return node.type.getText()
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function reportDomSpread(sourceFile, relativePath, declaration, entries) {
  const heritageText = collectHeritageText(declaration.node)
  if (!heritageText) return
  const matchedHeritage = [...DomSpreadHeritageNames].find((name) =>
    new RegExp(`\\b${name}\\b`).test(heritageText),
  )
  const matchesIntrinsic = /JSX\.IntrinsicElements\s*\[/.test(heritageText)
  const matched = matchedHeritage ?? (matchesIntrinsic ? 'JSX.IntrinsicElements' : null)
  if (!matched) return
  const line = lineOf(sourceFile, declaration.node)
  entries.push({
    fingerprint: `${relativePath}::${declaration.name}::dom-spread`,
    message: `${relativePath}:${line}: ${declaration.name} 展开了 DOM 全属性面(${matched})——§12.9 禁 ComponentProps 全展开逃生口。组件只暴露预设形态 prop;需要转发 DOM 属性时改为在消费方本地外貌层组合,勿回灌组件库。`,
  })
}

function isPassthroughMember(memberName) {
  return ClassNamePassthroughMembers.has(memberName) || /ClassName$/.test(memberName)
}

function pushPassthrough(relativePath, declarationName, memberName, line, entries) {
  entries.push({
    fingerprint: `${relativePath}::${declarationName}::passthrough::${memberName}`,
    message: `${relativePath}:${line}: ${declarationName}.${memberName} 是 className/style 透传逃生口——§12.9 禁。形态由封闭 variant 枚举 + CSS 变量单源表达,勿开外部覆盖口。`,
  })
}

function reportPassthroughMembers(sourceFile, relativePath, declaration, entries) {
  // 类型别名右侧(`type FooProps = Pick<Bar,'className'> & { style?: … }`)没有 interface 成员,
  // 走类型节点面识别——这正是原口径漏掉的第 ② 类逃生口。
  if (ts.isTypeAliasDeclaration(declaration.node)) {
    const line = lineOf(sourceFile, declaration.node)
    const members = new Set([
      ...inlineLiteralPassthroughMembers(declaration.node.type),
      ...pickedPassthroughMembers(declaration.node.type),
    ])
    for (const memberName of members) {
      pushPassthrough(relativePath, declaration.name, memberName, line, entries)
    }
    return
  }
  if (!ts.isInterfaceDeclaration(declaration.node)) return
  for (const member of declaration.node.members) {
    if (!ts.isPropertySignature(member) || !member.name || !ts.isIdentifier(member.name)) continue
    const memberName = member.name.text
    if (!isPassthroughMember(memberName)) continue
    pushPassthrough(relativePath, declaration.name, memberName, lineOf(sourceFile, member), entries)
  }
}

function isInsideTokensDir(file) {
  return isInsideDirectory(file, `${UiSourceDir}/styles`)
}

/** 内联标注没有声明名,锚点取最近的具名宿主(组件常量 / 函数 / 方法),使指纹与行号无关。 */
function enclosingAnchorName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      (ts.isVariableDeclaration(current) ||
        ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isPropertyAssignment(current) ||
        ts.isPropertyDeclaration(current)) &&
      current.name &&
      ts.isIdentifier(current.name)
    ) {
      return current.name.text
    }
  }
  return null
}

/** `Pick<X, 'className' | 'style'>` 形态的透传成员名(Omit 是排除,不算透传)。 */
function pickedPassthroughMembers(typeNode) {
  const picked = []
  const visit = (node) => {
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      node.typeName.text === 'Pick' &&
      node.typeArguments?.length === 2
    ) {
      const selector = node.typeArguments[1]
      const literals = ts.isUnionTypeNode(selector) ? selector.types : [selector]
      for (const literal of literals) {
        if (!ts.isLiteralTypeNode(literal) || !ts.isStringLiteral(literal.literal)) continue
        if (isPassthroughMember(literal.literal.text)) picked.push(literal.literal.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(typeNode)
  return picked
}

/** 类型节点内联出现的 TypeLiteral 成员(`{ className?: string }`,含交叉类型里的分支)。 */
function inlineLiteralPassthroughMembers(typeNode) {
  const members = []
  const visit = (node) => {
    if (ts.isTypeLiteralNode(node)) {
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || !member.name || !ts.isIdentifier(member.name)) continue
        if (isPassthroughMember(member.name.text)) members.push(member.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(typeNode)
  return members
}

function matchedDomSpreadName(typeText) {
  const matched = [...DomSpreadHeritageNames].find((name) => new RegExp(`\\b${name}\\b`).test(typeText))
  if (matched) return matched
  return /JSX\.IntrinsicElements\s*\[/.test(typeText) ? 'JSX.IntrinsicElements' : null
}

/**
 * 逃生口 ①②:参数类型标注面。
 *
 * 纯 `TypeReference`(`(props: FooProps)`)跳过——它指向的声明已由 `*Props` 面记账,重复记会双计。
 */
function reportParameterAnnotations(sourceFile, relativePath, entries) {
  const anonymousOrdinal = new Map()

  const visit = (node) => {
    if (ts.isParameter(node) && node.type && !ts.isTypeReferenceNode(node.type)) {
      const typeNode = node.type
      const anchorName =
        enclosingAnchorName(node) ??
        (() => {
          const seen = anonymousOrdinal.get(relativePath) ?? 0
          anonymousOrdinal.set(relativePath, seen + 1)
          return `anonymous#${seen}`
        })()
      const line = lineOf(sourceFile, node)
      const domSpread = matchedDomSpreadName(typeNode.getText())
      if (domSpread) {
        entries.push({
          fingerprint: `${relativePath}::${anchorName}::dom-spread`,
          message: `${relativePath}:${line}: ${anchorName} 的内联 props 标注展开了 DOM 全属性面(${domSpread})——§12.9 禁 ComponentProps 全展开逃生口。组件只暴露预设形态 prop;需要转发 DOM 属性时改为在消费方本地外貌层组合,勿回灌组件库。`,
        })
      }
      const passthrough = [
        ...inlineLiteralPassthroughMembers(typeNode),
        ...pickedPassthroughMembers(typeNode),
      ]
      for (const memberName of new Set(passthrough)) {
        entries.push({
          fingerprint: `${relativePath}::${anchorName}::passthrough::${memberName}`,
          message: `${relativePath}:${line}: ${anchorName}.${memberName} 是 className/style 透传逃生口(内联 props 标注)——§12.9 禁。形态由封闭 variant 枚举 + CSS 变量单源表达,勿开外部覆盖口。`,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

/** 逃生口 ③:导出的 `*ClassName` 拼接函数——透传口从 prop 挪到函数签名,本质不变。 */
function reportExportedClassNameHelpers(sourceFile, relativePath, entries) {
  const isExported = (node) =>
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true

  const report = (name, node) => {
    if (!/ClassName$/.test(name)) return
    entries.push({
      fingerprint: `${relativePath}::${name}::classname-helper`,
      message: `${relativePath}:${lineOf(sourceFile, node)}: 导出函数 ${name}() 是 className 拼接逃生口——§12.9 禁。把 className 透传口挪到函数签名不改变性质;外貌覆盖需求下沉到消费方本地外貌层。`,
    })
  }

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement)) {
      report(statement.name.text, statement)
      continue
    }
    if (!ts.isVariableStatement(statement) || !isExported(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      if (
        !ts.isArrowFunction(declaration.initializer) &&
        !ts.isFunctionExpression(declaration.initializer)
      ) {
        continue
      }
      report(declaration.name.text, declaration)
    }
  }
}

function main() {
  const entries = []
  const files = collectFiles(UiSourceDir, SourceExtensions).filter(
    (file) => !basename(file).endsWith('.d.ts') && !isInsideTokensDir(file),
  )

  for (const file of files) {
    const source = ts.sys.readFile(file) ?? ''
    // 三条扫描面各自的最小充分线索;都没有就整文件跳过(保持全量扫描的成本不变)。
    if (
      !source.includes(PropsDeclarationSuffix) &&
      !source.includes('className') &&
      !source.includes('style')
    ) {
      continue
    }
    const relativePath = toRelativePath(file)
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    for (const declaration of collectPropsDeclarations(sourceFile)) {
      reportDomSpread(sourceFile, relativePath, declaration, entries)
      reportPassthroughMembers(sourceFile, relativePath, declaration, entries)
    }
    reportParameterAnnotations(sourceFile, relativePath, entries)
    reportExportedClassNameHelpers(sourceFile, relativePath, entries)
  }

  const ok = runRatchet('ui-component-form-closure', 'UI component form closure(§12.9)', entries)
  if (!ok) process.exit(1)
}

main()
