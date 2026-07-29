#!/usr/bin/env node
/**
 * 用途:内核宪章 §12.9「组件形态封闭」执法门——`@velaros-ai/ui` 组件的**逃生口**只降不升。
 *
 * 法条:组件库不搞通用、只做统一、可组合;**不开 className/style 逃生口**、**不做 ComponentProps
 * 全展开**(DOM-prop 展开面 = prop 爆炸的通用病征)。单点特殊设计走消费方本地外貌 + 复用能力层,禁回灌组件库。
 *
 * 本门只看 `packages/ui/src` 下的公开组件 props 契约(`*Props` 接口 / 类型别名),逐条记账两类逃生口:
 *   1. **ComponentProps 全展开**:props 继承 / 交叉了 `React.ComponentProps` / `ComponentPropsWithoutRef`
 *      / `HTMLAttributes` / `SVGProps` / `JSX.IntrinsicElements[...]` 等 DOM 全属性面(含 `Omit<…>` / `Pick<…>` 包裹)。
 *   2. **className/style 透传**:props 显式声明 `className` / `style` / `*ClassName` 成员。
 *
 * 自 monorepo arch-guard-velaros 的 uiComponentFormClosure(§12.9)收编,指纹形态(声明名锚定,行无关)
 * 逐字保形。存量由 baselines/ui-component-form-closure-baseline.json 逐条冻结,只降不升;新组件新增即红。
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

function reportPassthroughMembers(sourceFile, relativePath, declaration, entries) {
  if (!ts.isInterfaceDeclaration(declaration.node)) return
  for (const member of declaration.node.members) {
    if (!ts.isPropertySignature(member) || !member.name || !ts.isIdentifier(member.name)) continue
    const memberName = member.name.text
    if (!isPassthroughMember(memberName)) continue
    const line = lineOf(sourceFile, member)
    entries.push({
      fingerprint: `${relativePath}::${declaration.name}::passthrough::${memberName}`,
      message: `${relativePath}:${line}: ${declaration.name}.${memberName} 是 className/style 透传逃生口——§12.9 禁。形态由封闭 variant 枚举 + CSS 变量单源表达,勿开外部覆盖口。`,
    })
  }
}

function isInsideTokensDir(file) {
  return isInsideDirectory(file, `${UiSourceDir}/styles`)
}

function main() {
  const entries = []
  const files = collectFiles(UiSourceDir, SourceExtensions).filter(
    (file) => !basename(file).endsWith('.d.ts') && !isInsideTokensDir(file),
  )

  for (const file of files) {
    const source = ts.sys.readFile(file) ?? ''
    if (!source.includes(PropsDeclarationSuffix)) continue
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
  }

  const ok = runRatchet('ui-component-form-closure', 'UI component form closure(§12.9)', entries)
  if (!ok) process.exit(1)
}

main()
