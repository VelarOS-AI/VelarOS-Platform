#!/usr/bin/env bun
// 把顶层声明从一个文件搬到另一个文件，并改好全仓引用方的 import / export from。不依赖语言服务的重构，结果可预期。
//
// 用法：bun scripts/ownership/move-declarations.mjs <包目录> <计划.json> [--dry-run]
// 计划是数组：[{ "from": "src/utils/a.ts", "symbols": ["Foo", "Bar"], "to": "src/types/a.ts" }]，路径相对包目录。
//
// 每一步：
//   1. 从源文件取出声明原文（连同紧挨着的注释），插到目标文件的 import 之后；目标文件不存在就新建；
//   2. 被搬的声明里用到的名字：源文件从别处 import 的，照原模块给目标文件补 import；源文件里留下的声明，给目标文件补从源文件的 import；
//      目标文件原来从源文件 import 这些名字的，删掉（不自己引自己）；
//   3. 源文件里剩下的代码还用到被搬的名字，就从目标文件 import 回来；
//   4. 全仓其余文件：import / export from 源文件的，把被搬的名字改成从目标文件取；`export * from 源文件` 补一条显式的转发，导出面不变。
// 只用 type 位置的名字一律 import type。任何一步出错就整批不落盘。
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import ts from 'typescript'

const RepoRoot = resolve(import.meta.dir, '../..')
const [packageArg, planArg, ...flags] = process.argv.slice(2)
if (!packageArg || !planArg) {
  console.error('用法：bun scripts/ownership/move-declarations.mjs <包目录> <计划.json> [--dry-run]')
  process.exit(2)
}
const dryRun = flags.includes('--dry-run')
const packageRoot = resolve(RepoRoot, packageArg)
const plan = JSON.parse(readFileSync(resolve(planArg), 'utf8'))

/** 递归列出源文件，跳过 node_modules、dist 与隐藏目录。 */
function walk(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) return []
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? walk(path) : /\.(?:ts|tsx|mts|mjs)$/u.test(entry) && !entry.endsWith('.d.ts') ? [path] : []
  })
}
const allFiles = [...walk(join(RepoRoot, 'packages')), ...walk(join(RepoRoot, 'tests'))]
const contents = new Map()
const read = (file) => contents.has(file) ? contents.get(file) : existsSync(file) ? readFileSync(file, 'utf8') : ''
const write = (file, text) => contents.set(file, text)
const parse = (file) => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true)

/** 把一个相对模块路径解析成真实文件；解析不到返回 null。 */
function resolveSpecifier(fromFile, specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith('.')) return null
  const base = resolve(dirname(fromFile), specifier)
  const candidates = [base, base.replace(/\.js$/u, '.ts'), `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]
  return candidates.find((candidate) => (contents.has(candidate) && contents.get(candidate) !== undefined) || (existsSync(candidate) && statSync(candidate).isFile())) ?? null
}

/** 生成从 fromFile 指向 targetFile 的相对模块路径，统一写 .js 扩展名。 */
function specifierFor(fromFile, targetFile) {
  let path = relative(dirname(fromFile), targetFile).split(sep).join('/').replace(/\.tsx?$/u, '.js')
  if (!path.startsWith('.')) path = `./${path}`
  return path
}

/** 顶层语句声明了哪些名字。 */
function declaredNames(statement) {
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap((declaration) => ts.isIdentifier(declaration.name) ? [declaration.name.text] : [])
  if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) return [statement.name.text]
  return []
}

/** 声明是否只存在于类型层（接口、类型别名）。 */
const isTypeOnlyDeclaration = (statement) => ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)

/** 语句连同它上方紧挨着的注释的起点。 */
function statementStart(sourceFile, statement) {
  const text = sourceFile.text
  const ranges = ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []
  if (ranges.length === 0) return statement.getStart(sourceFile)
  // 只要和语句之间没有空行的那几段注释；空行以上的注释属于前面。
  let start = statement.getStart(sourceFile)
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const gap = text.slice(ranges[index].end, start)
    if (/\n\s*\n/u.test(gap)) break
    start = ranges[index].pos
  }
  return start
}

/** 这个标识符是不是在引用别处的名字（而不是属性名、参数名、声明自己的名字）。 */
function isReference(node) {
  const parent = node.parent
  if (!parent) return false
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false
  if (ts.isQualifiedName(parent) && parent.right === node) return false
  if (ts.isShorthandPropertyAssignment(parent)) return true
  if ('name' in parent && parent.name === node && !ts.isTypeReferenceNode(parent)) return false
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isLabeledStatement(parent)) return false
  return true
}

/** 收集一段语法树里引用到的全部名字，并区分是否只出现在类型位置。 */
function collectIdentifiers(node, into = new Map()) {
  const visit = (child, inType) => {
    const typeContext = inType || ts.isTypeNode(child) || ts.isHeritageClause(child) && child.token === ts.SyntaxKind.ImplementsKeyword
    if (ts.isIdentifier(child) && isReference(child)) {
      const previous = into.get(child.text)
      into.set(child.text, previous === undefined ? typeContext : previous && typeContext)
    }
    ts.forEachChild(child, (grandChild) => visit(grandChild, typeContext))
  }
  visit(node, false)
  return into
}

/** 文件里的 import 表：本地名 → { 模块路径, 原名, 是否只是类型 }。 */
function importTable(sourceFile) {
  const table = new Map()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue
    const clause = statement.importClause
    const module = statement.moduleSpecifier.text
    if (clause.name) table.set(clause.name.text, { module, imported: 'default', typeOnly: clause.isTypeOnly })
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        table.set(element.name.text, { module, imported: (element.propertyName ?? element.name).text, typeOnly: clause.isTypeOnly || element.isTypeOnly })
      }
    } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      table.set(clause.namedBindings.name.text, { module, imported: '*', typeOnly: clause.isTypeOnly })
    }
  }
  return table
}

/** 在文件的 import 区之后插入一段文本（没有 import 就插在文件头注释之后）。 */
function insertAfterImports(text, addition) {
  const sourceFile = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true)
  const imports = sourceFile.statements.filter((statement) => ts.isImportDeclaration(statement))
  if (imports.length > 0) {
    const end = imports.at(-1).getEnd()
    return `${text.slice(0, end)}\n\n${addition.trim()}\n${text.slice(end)}`.replace(/\n{3,}/gu, '\n\n')
  }
  const first = sourceFile.statements[0]
  if (!first) return `${text.trimEnd()}${text.trim() ? '\n\n' : ''}${addition.trim()}\n`
  const start = first.getStart(sourceFile)
  return `${text.slice(0, start)}${addition.trim()}\n\n${text.slice(start)}`
}

/** 给文件补一组 import：同模块同类型性的并进已有语句，否则新起一行。imports 是 [{ module, name, imported, typeOnly }]。 */
function addImports(text, imports) {
  if (imports.length === 0) return text
  let sourceFile = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true)
  const existing = importTable(sourceFile)
  const local = new Set(sourceFile.statements.flatMap((statement) => declaredNames(statement)))
  const pending = imports.filter((entry) => !existing.has(entry.name) && !local.has(entry.name))
  const byModule = new Map()
  for (const entry of pending) {
    const key = `${entry.module}\0${entry.typeOnly}`
    byModule.set(key, [...(byModule.get(key) ?? []), entry])
  }
  let output = text
  for (const [key, entries] of byModule) {
    const [module, typeOnlyText] = key.split('\0')
    const typeOnly = typeOnlyText === 'true'
    // 命名空间与默认导入各自单独成行，不能塞进花括号。
    for (const entry of entries.filter((item) => item.imported === '*' || item.imported === 'default')) {
      const line = entry.imported === '*'
        ? `import ${typeOnly ? 'type ' : ''}* as ${entry.name} from '${module}'`
        : `import ${typeOnly ? 'type ' : ''}${entry.name} from '${module}'`
      sourceFile = ts.createSourceFile('x.ts', output, ts.ScriptTarget.Latest, true)
      const imports = sourceFile.statements.filter((statement) => ts.isImportDeclaration(statement))
      output = imports.length > 0
        ? `${output.slice(0, imports.at(-1).getEnd())}\n${line}${output.slice(imports.at(-1).getEnd())}`
        : insertAfterImports(output, line)
    }
    const named = entries.filter((item) => item.imported !== '*' && item.imported !== 'default')
    if (named.length === 0) continue
    sourceFile = ts.createSourceFile('x.ts', output, ts.ScriptTarget.Latest, true)
    const namedTarget = sourceFile.statements.find((statement) => ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === module
      && statement.importClause && !statement.importClause.name && statement.importClause.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
      && statement.importClause.isTypeOnly === typeOnly)
    const specifiers = named.map((entry) => entry.imported === entry.name ? entry.name : `${entry.imported} as ${entry.name}`)
    const target = namedTarget
    if (target) {
      const bindings = target.importClause.namedBindings
      const names = [...bindings.elements.map((element) => element.getText(sourceFile)), ...specifiers]
      output = output.slice(0, bindings.getStart(sourceFile)) + `{ ${names.join(', ')} }` + output.slice(bindings.getEnd())
    } else {
      const line = `import ${typeOnly ? 'type ' : ''}{ ${specifiers.join(', ')} } from '${module}'`
      const imports = sourceFile.statements.filter((statement) => ts.isImportDeclaration(statement))
      if (imports.length > 0) {
        const end = imports.at(-1).getEnd()
        output = `${output.slice(0, end)}\n${line}${output.slice(end)}`
      } else {
        output = insertAfterImports(output, line).replace(`${line}\n\n`, `${line}\n\n`)
      }
    }
  }
  return output
}

/** 从一条 import / export from 语句里去掉一组名字；全去掉了就删整条语句。返回新文本和被去掉的说明符。 */
function removeSpecifiers(text, statementNode, sourceFile, names) {
  const clause = ts.isImportDeclaration(statementNode) ? statementNode.importClause?.namedBindings : statementNode.exportClause
  if (!clause || !(ts.isNamedImports(clause) || ts.isNamedExports(clause))) return { text, removed: [] }
  const keep = []
  const removed = []
  for (const element of clause.elements) {
    const original = (element.propertyName ?? element.name).text
    if (names.has(original)) removed.push({ element, original, local: element.name.text, typeOnly: element.isTypeOnly })
    else keep.push(element.getText(sourceFile))
  }
  if (removed.length === 0) return { text, removed }
  const hasDefault = ts.isImportDeclaration(statementNode) && statementNode.importClause?.name
  if (keep.length === 0 && !hasDefault) {
    let end = statementNode.getEnd()
    if (text[end] === '\n') end += 1
    return { text: text.slice(0, statementNode.getStart(sourceFile)) + text.slice(end), removed }
  }
  return { text: text.slice(0, clause.getStart(sourceFile)) + `{ ${keep.join(', ')} }` + text.slice(clause.getEnd()), removed }
}

let movedCount = 0
const touched = new Set()
for (const step of plan) {
  const from = resolve(packageRoot, step.from)
  const to = resolve(packageRoot, step.to)
  const names = new Set(step.symbols)
  if (!existsSync(from) && !contents.has(from)) throw new Error(`源文件不存在：${step.from}`)
  if (!contents.has(to) && !existsSync(to)) contents.set(to, '')
  if (!allFiles.includes(to)) allFiles.push(to)

  // 1. 从源文件取出声明。
  let sourceFile = parse(from)
  const moving = sourceFile.statements.filter((statement) => declaredNames(statement).some((name) => names.has(name)))
  for (const name of names) if (!moving.some((statement) => declaredNames(statement).includes(name))) throw new Error(`${step.from} 里找不到顶层声明 ${name}`)
  for (const statement of moving) if (declaredNames(statement).some((name) => !names.has(name))) throw new Error(`${step.from} 的一条语句同时声明了 ${declaredNames(statement).join('、')}，要一起搬`)
  const typeOnlyMoved = new Map(moving.flatMap((statement) => declaredNames(statement).map((name) => [name, isTypeOnlyDeclaration(statement)])))
  const exported = (statement) => statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  const movedText = moving.map((statement) => {
    const start = statementStart(sourceFile, statement)
    const declarationStart = statement.getStart(sourceFile)
    const leading = sourceFile.text.slice(start, declarationStart)
    const body = sourceFile.text.slice(declarationStart, statement.getEnd())
    return leading + (exported(statement) ? body : `export ${body}`)
  }).join('\n\n')

  // 2. 被搬的声明用到的名字。
  const used = new Map()
  for (const statement of moving) collectIdentifiers(statement, used)
  const sourceImports = importTable(sourceFile)
  const staying = new Map(sourceFile.statements.filter((statement) => !moving.includes(statement)).flatMap((statement) => declaredNames(statement).map((name) => [name, isTypeOnlyDeclaration(statement)])))
  const targetImports = []
  for (const [name, onlyInTypes] of used) {
    if (names.has(name)) continue
    const imported = sourceImports.get(name)
    if (imported) {
      const resolved = resolveSpecifier(from, imported.module)
      if (resolved === to) continue
      const module = resolved ? specifierFor(to, resolved) : imported.module
      targetImports.push({ module, name, imported: imported.imported, typeOnly: imported.typeOnly || onlyInTypes })
    } else if (staying.has(name)) {
      targetImports.push({ module: specifierFor(to, from), name, imported: name, typeOnly: staying.get(name) || onlyInTypes })
    }
  }

  // 源文件去掉声明；剩下的代码还用到被搬的名字就从目标文件引回来。
  let sourceText = sourceFile.text
  for (const statement of [...moving].sort((a, b) => b.getStart(sourceFile) - a.getStart(sourceFile))) {
    let end = statement.getEnd()
    while (sourceText[end] === '\n') end += 1
    sourceText = sourceText.slice(0, statementStart(sourceFile, statement)) + sourceText.slice(end)
  }
  write(from, sourceText)
  sourceFile = parse(from)
  const forwarded = []
  for (const statement of [...sourceFile.statements].reverse()) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier || !statement.exportClause) continue
    const { text: next, removed } = removeSpecifiers(sourceText, statement, sourceFile, names)
    if (removed.length === 0) continue
    sourceText = next
    sourceFile = ts.createSourceFile(from, sourceText, ts.ScriptTarget.Latest, true)
    forwarded.push(...removed)
  }
  if (forwarded.length > 0) {
    const types = forwarded.filter((entry) => typeOnlyMoved.get(entry.original)).map((entry) => entry.original)
    const values = forwarded.filter((entry) => !typeOnlyMoved.get(entry.original)).map((entry) => entry.original)
    if (types.length > 0) sourceText = `${sourceText.trimEnd()}\nexport type { ${types.join(', ')} } from '${specifierFor(from, to)}'\n`
    if (values.length > 0) sourceText = `${sourceText.trimEnd()}\nexport { ${values.join(', ')} } from '${specifierFor(from, to)}'\n`
  }
  write(from, sourceText)
  sourceFile = parse(from)
  const remainingUse = collectIdentifiers(sourceFile)
  const backImports = [...names].filter((name) => remainingUse.has(name)).map((name) => ({ module: specifierFor(from, to), name, imported: name, typeOnly: typeOnlyMoved.get(name) || remainingUse.get(name) }))
  write(from, addImports(read(from), backImports))

  // 目标文件：去掉原来从源文件引这些名字的说明符，插入声明，补 import。
  let targetFile = parse(to)
  let targetText = targetFile.text
  for (const statement of [...targetFile.statements].reverse()) {
    const fromSource = (ts.isImportDeclaration(statement) || (ts.isExportDeclaration(statement) && statement.moduleSpecifier && statement.exportClause))
      && resolveSpecifier(to, statement.moduleSpecifier.text) === from
    if (!fromSource) continue
    targetText = removeSpecifiers(targetText, statement, targetFile, names).text
    targetFile = ts.createSourceFile(to, targetText, ts.ScriptTarget.Latest, true)
  }
  targetText = insertAfterImports(targetText, movedText)
  write(to, addImports(targetText, targetImports))

  // 3. 其余文件的 import / export from。
  for (const file of allFiles) {
    if (file === from || file === to) continue
    const text = read(file)
    if (!text.includes(step.from.split('/').at(-1).replace(/\.ts$/u, ''))) continue
    let current = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    let output = text
    const additions = []
    const reexports = []
    for (const statement of [...current.statements].reverse()) {
      const isImport = ts.isImportDeclaration(statement)
      const isExport = ts.isExportDeclaration(statement) && statement.moduleSpecifier
      if (!isImport && !isExport) continue
      if (resolveSpecifier(file, statement.moduleSpecifier.text) !== from) continue
      if (isExport && !statement.exportClause) {
        reexports.push({ typeOnly: statement.isTypeOnly })
        continue
      }
      const { text: next, removed } = removeSpecifiers(output, statement, current, names)
      if (removed.length === 0) continue
      output = next
      current = ts.createSourceFile(file, output, ts.ScriptTarget.Latest, true)
      const declarationTypeOnly = isImport ? statement.importClause.isTypeOnly : statement.isTypeOnly
      for (const entry of removed) additions.push({ kind: isImport ? 'import' : 'export', module: specifierFor(file, to), name: entry.local, imported: entry.original, typeOnly: declarationTypeOnly || entry.typeOnly || typeOnlyMoved.get(entry.original) })
    }
    const importAdds = additions.filter((entry) => entry.kind === 'import')
    output = addImports(output, importAdds)
    const exportAdds = additions.filter((entry) => entry.kind === 'export')
    for (const typeOnly of [true, false]) {
      const group = exportAdds.filter((entry) => !!entry.typeOnly === typeOnly)
      if (group.length === 0) continue
      output = `${output.trimEnd()}\nexport ${typeOnly ? 'type ' : ''}{ ${group.map((entry) => entry.imported === entry.name ? entry.name : `${entry.imported} as ${entry.name}`).join(', ')} } from '${specifierFor(file, to)}'\n`
    }
    if (reexports.length > 0) {
      const types = [...names].filter((name) => typeOnlyMoved.get(name))
      const values = [...names].filter((name) => !typeOnlyMoved.get(name))
      if (types.length > 0) output = `${output.trimEnd()}\nexport type { ${types.join(', ')} } from '${specifierFor(file, to)}'\n`
      if (values.length > 0) output = `${output.trimEnd()}\nexport { ${values.join(', ')} } from '${specifierFor(file, to)}'\n`
    }
    if (output !== text) {
      write(file, output)
      touched.add(file)
    }
  }
  touched.add(from)
  touched.add(to)
  movedCount += moving.length
}

const changed = [...contents.keys()].filter((file) => contents.get(file) !== (existsSync(file) ? readFileSync(file, 'utf8') : undefined))
const emptied = changed.filter((file) => {
  const sourceFile = ts.createSourceFile(file, contents.get(file), ts.ScriptTarget.Latest, true)
  return sourceFile.statements.every((statement) => ts.isImportDeclaration(statement))
})
if (emptied.length > 0) console.info(`这些文件搬空了（只剩 import 或什么都没有），要手工删掉或合并：\n  ${emptied.map((file) => relative(RepoRoot, file)).join('\n  ')}`)
console.info(`搬了 ${movedCount} 条声明，改动 ${changed.length} 个文件${dryRun ? '（演练，不落盘）' : ''}`)
if (dryRun) {
  for (const file of changed) console.info(`  ${relative(RepoRoot, file)}`)
  process.exit(0)
}
for (const file of changed) writeFileSync(file, contents.get(file))
