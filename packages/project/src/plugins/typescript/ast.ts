import * as ts from 'typescript'

import { isUndefined } from '@velaros-ai/core'

import type { SymbolInfo } from '../../types/adapter.js'
import type { Range } from '../../types/common.js'
import { sha256 } from '../../utils/hash.js'
import { rangeFromOffsets } from '../../utils/text.js'

export interface TsAstSymbol extends SymbolInfo {
  kind: 'function' | 'method' | 'class' | 'interface' | 'type' | 'variable' | 'import' | 'unknown'
  nodeKind: string
  bodyRange?: Range
}

export interface ParseTsResult {
  sourceFile: ts.SourceFile
  symbols: TsAstSymbol[]
  diagnostics: ts.Diagnostic[]
}

export function scriptKindForPath(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (path.endsWith('.mjs') || path.endsWith('.cjs') || path.endsWith('.js'))
    return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function nameText(name: Optional<ts.PropertyName | ts.BindingName>): Optional<string> {
  if (!name) return undefined
  if (ts.isIdentifier(name)) return name.text
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  if (ts.isComputedPropertyName(name)) return name.expression.getText()
  return undefined
}

function nodeRange(content: string, sf: ts.SourceFile, node: ts.Node): Range {
  return rangeFromOffsets(content, node.getStart(sf), node.getEnd())
}

function bodyRange(content: string, sf: ts.SourceFile, node: ts.Node): Range | undefined {
  const maybe = node as
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
  const body = maybe.body
  if (!body) return undefined
  const start = body.getStart(sf)
  const end = body.getEnd()
  return rangeFromOffsets(content, start, end)
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false
  return (ts.getModifiers(node) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
  )
}

// 解析结果按 (path, 内容哈希) 内容寻址缓存：resolve→prepare→validate 常对同一文件反复解析。
// 内容寻址保证不会返回陈旧 AST；带 LRU 上限避免常驻内存无界增长。结果仅被只读消费（取 symbols/positions/fileName）。
const MaxCachedParseResults = 200;
const parseCache = new Map<string, ParseTsResult>();

export function parseTs(path: string, content: string): ParseTsResult {
  const cacheKey = `${path}\u0000${sha256(content)}`;
  const cached = parseCache.get(cacheKey);
  if (cached) {
    // LRU：命中后挪到队尾，保证最近使用的最后被淘汰。
    parseCache.delete(cacheKey);
    parseCache.set(cacheKey, cached);
    return cached;
  }
  const result = parseTsUncached(path, content);
  parseCache.set(cacheKey, result);
  while (parseCache.size > MaxCachedParseResults) {
    const oldest = parseCache.keys().next().value;
    if (isUndefined(oldest)) break;
    parseCache.delete(oldest);
  }
  return result;
}

function parseTsUncached(path: string, content: string): ParseTsResult {
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(path)
  )
  const symbols: TsAstSymbol[] = []

  function push(
    kind: TsAstSymbol['kind'],
    name: Optional<string>,
    node: ts.Node,
    container?: string,
    exported = false
  ): void {
    if (!name) return
    symbols.push({
      kind,
      name,
      container,
      exported,
      range: nodeRange(content, sourceFile, node),
      bodyRange: bodyRange(content, sourceFile, node),
      signatureHash: sha256(node.getText(sourceFile).slice(0, 500)),
      nodeKind: ts.SyntaxKind[node.kind],
      metadata: {
        jsTs: true,
        nodeKind: ts.SyntaxKind[node.kind],
        exported,
      },
    })
  }

  function visit(node: ts.Node, container?: string): void {
    if (ts.isFunctionDeclaration(node)) {
      push('function', node.name?.text, node, container, hasExportModifier(node))
    } else if (ts.isClassDeclaration(node)) {
      const className = node.name?.text
      push('class', className, node, container, hasExportModifier(node))
      for (const member of node.members) {
        if (
          ts.isMethodDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member)
        ) {
          push('method', nameText(member.name), member, className)
        } else if (ts.isConstructorDeclaration(member)) {
          push('method', 'constructor', member, className)
        }
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      push('interface', node.name.text, node, container, hasExportModifier(node))
    } else if (ts.isTypeAliasDeclaration(node)) {
      push('type', node.name.text, node, container, hasExportModifier(node))
    } else if (ts.isImportDeclaration(node)) {
      const moduleName = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : node.moduleSpecifier.getText(sourceFile)
      push('import', moduleName, node, container)
    } else if (ts.isVariableStatement(node)) {
      const exported = hasExportModifier(node)
      const declarations = node.declarationList.declarations
      for (const decl of declarations) {
        const name = nameText(decl.name)
        const init = decl.initializer
        const isCallable = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        // 单声明用整条语句范围（含 const/;）；多声明 `const a = …, b = …` 时每个绑定用自身声明范围，
        // 避免 replace_symbol 改其中一个变量却连带替换同一语句里的其它变量。
        const rangeNode = declarations.length > 1 ? decl : node
        push(isCallable ? 'function' : 'variable', name, rangeNode, container, exported)
      }
    }
    ts.forEachChild(node, (child) => visit(child, container))
  }

  visit(sourceFile)
  symbols.sort((a, b) => (a.range.startOffset ?? 0) - (b.range.startOffset ?? 0))
  return { sourceFile, symbols, diagnostics: (sourceFile as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [] }
}

export function findTsSymbols(
  content: string,
  path: string,
  query?: { name?: string; kind?: string; container?: string }
): TsAstSymbol[] {
  const parsed = parseTs(path, content)
  return parsed.symbols.filter((symbol) => {
    if (query?.name && symbol.name !== query.name) return false
    if (query?.kind && query.kind !== 'unknown' && symbol.kind !== query.kind) return false
    if (query?.container && symbol.container !== query.container) return false
    return true
  })
}
