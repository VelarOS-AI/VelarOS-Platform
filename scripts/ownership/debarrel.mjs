#!/usr/bin/env bun
// 去掉一个包里的中间转发：import / export from 一律直接指向名字真正声明所在的文件，入口文件改成逐个名字的显式转发，
// 再删掉没人引用的中间 barrel。名字解析到哪个声明，以 TypeScript 类型检查器为准。
//
// 用法：bun scripts/ownership/debarrel.mjs <包目录，如 packages/agent> <步骤> [--dry-run] [--no-sort]
//
// 步骤：
//   imports  包内 src、test、spec 下的 import / export from（只有转发语句的文件除外，它们归后两步）：
//            经包名自引用的改成相对路径；经 barrel、入口或别的文件转发的，按名字拆到各自声明所在的文件，
//            同一文件里已有指向那里的同类语句就并进去。`import type` 与行内 `type` 照原样保留，
//            拆出来的一组全是类型时写成 `import type`；export from 的转发链上有一环只转发类型，就补上 `type`。
//            默认导入、命名空间导入、副作用导入、`export *` 拆不了，原样留下并报告（包名自引用只把包名改成相对路径）。
//   entries  package.json exports 指向的入口文件，只有转发语句的，改写成逐个名字的显式转发：
//            `export { a, b as c } from './x'`、`export type { T } from './y'`。导出的名字、指向的声明、值还是只有类型、
//            别名指向（`export { 甲 as 乙 }` 里的甲）逐个不变；转发链上贴在单条转发语句上方的注释（例如 @deprecated）
//            跟着名字带进入口，入口原来的文件头注释留在文件头。
//   barrels  删掉不是入口、只有转发语句、而且全仓再没有文件引用（相对路径、包名子路径或写死的路径字符串）的文件。
//   all      依次做 imports、entries、barrels，每步之间按改后的文件重建程序。
//
// 相对路径照包里现有相对 import 的多数写法：不带扩展名、写 .js 或写 .ts，哪种多用哪种；不带扩展名时指向目录 index 的写目录。
// 落盘前在内存里按改后的文本重建程序核对：每个改过的名字仍解析到原来的声明，入口导出面逐个不变，类型诊断不增加；
// 任何一处不符就整批不落盘。落盘后用仓库 ESLint 配置里的 simple-import-sort 两条规则重排改过的文件（--no-sort 跳过）。
// 自引用要靠包的 tsconfig paths 把包名映射到 src 才解析得到；解析不到的原样留下并报告。
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

import { ESLint } from 'eslint'
import ts from 'typescript'

const RepoRoot = resolve(import.meta.dir, '../..')
const Steps = ['imports', 'entries', 'barrels', 'all']
const [packageArg, stepArg, ...flags] = process.argv.slice(2)
if (!packageArg || !Steps.includes(stepArg)) {
  console.error(
    '用法：bun scripts/ownership/debarrel.mjs <包目录> <imports|entries|barrels|all> [--dry-run] [--no-sort]'
  )
  process.exit(2)
}
const dryRun = flags.includes('--dry-run')
const sortAfterWrite = !flags.includes('--no-sort')
const packageRoot = resolve(RepoRoot, packageArg)
if (
  !packageRoot.startsWith(`${RepoRoot}${sep}packages${sep}`) ||
  !existsSync(join(packageRoot, 'package.json'))
) {
  console.error(`包目录必须是 packages/ 下带 package.json 的目录：${packageRoot}`)
  process.exit(2)
}
const sourceRoot = join(packageRoot, 'src')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const packageName = manifest.name
const ScannedDirectories = ['src', 'test', 'spec']
/** 单行写得下就写一行，超过这个宽度的 import / export 改成一行一个名字。 */
const MaxSingleLineWidth = 100

/** 包内相对路径，报告用。 */
const show = (file) => relative(packageRoot, file).split(sep).join('/')

/** 递归列出 TypeScript 源文件（含 .d.ts），跳过 node_modules、dist 与隐藏目录。 */
function walk(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) return []
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return walk(path)
    return /\.(?:ts|tsx|mts|cts)$/u.test(entry) ? [path] : []
  })
}

/** 读包的 tsconfig，拿编译选项（含把包名映射到 src 的 paths）。 */
function loadCompilerOptions() {
  const configPath = join(packageRoot, 'tsconfig.json')
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile)
  if (error)
    throw new Error(
      `读不了 ${configPath}：${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`
    )
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, packageRoot)
  return { ...parsed.options, noEmit: true }
}
const compilerOptions = loadCompilerOptions()

/** package.json exports 的每个入口对应 src 里的哪个源文件（dist/x.js → src/x.ts）。 */
function entryFiles() {
  const entries = new Map()
  for (const [subpath, definition] of Object.entries(manifest.exports ?? {})) {
    const target =
      typeof definition === 'string'
        ? definition
        : (definition?.import ?? definition?.default ?? definition?.types)
    if (typeof target !== 'string' || !target.startsWith('./dist/')) continue
    const source = resolve(
      packageRoot,
      target.replace(/^\.\/dist\//u, 'src/').replace(/\.d\.ts$|\.js$/u, '.ts')
    )
    if (!existsSync(source)) throw new Error(`入口 ${subpath} 找不到源文件 ${show(source)}`)
    entries.set(source, subpath)
  }
  return entries
}
const entries = entryFiles()

/** 包里现有相对 import 的多数写法：'js' 写 .js 扩展名，'ts' 写 .ts 扩展名，'none' 不写。 */
function detectSpecifierStyle(files) {
  const counts = { js: 0, ts: 0, none: 0 }
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(
      /\bfrom\s+['"](\.{1,2}\/[^'"]*)['"]/gu
    )) {
      if (/\.js$/u.test(match[1])) counts.js += 1
      else if (/\.tsx?$/u.test(match[1])) counts.ts += 1
      else if (!/\.[cm]?[jt]sx?$|\.json$/u.test(match[1])) counts.none += 1
    }
  }
  return Object.entries(counts).sort((left, right) => right[1] - left[1])[0][0]
}

/** 按改后的内容（覆盖表：文件 → 新文本，null 表示删掉）建一个程序。 */
function createProgram(overlay = new Map()) {
  const host = ts.createCompilerHost(compilerOptions, true)
  const readFile = host.readFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  host.readFile = (fileName) =>
    overlay.has(resolve(fileName))
      ? (overlay.get(resolve(fileName)) ?? undefined)
      : readFile(fileName)
  host.fileExists = (fileName) =>
    overlay.has(resolve(fileName)) ? overlay.get(resolve(fileName)) !== null : fileExists(fileName)
  const rootNames = ScannedDirectories.flatMap((directory) =>
    walk(join(packageRoot, directory))
  ).filter((file) => overlay.get(file) !== null)
  const program = ts.createProgram({ rootNames, options: compilerOptions, host })
  return { program, checker: program.getTypeChecker(), cache: new Map() }
}

/** 文件在不在包的 src 里（.d.ts 不算：它们不是 import 的目标）。 */
const isPackageSource = (file) => file.startsWith(`${sourceRoot}${sep}`) && !file.endsWith('.d.ts')
/** 模块路径是不是包名自引用。 */
const isSelfReference = (specifier) =>
  specifier === packageName || specifier.startsWith(`${packageName}/`)

/** 模块路径被类型检查器解析到的源文件；解析不到或是环境模块声明时返回 null。 */
function moduleFileOf(context, moduleSpecifier) {
  const symbol = context.checker.getSymbolAtLocation(moduleSpecifier)
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
  return declaration && ts.isSourceFile(declaration) ? resolve(declaration.fileName) : null
}

/** 语句是不是带模块路径的 import / export from。 */
const isModuleStatement = (statement) =>
  (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
  statement.moduleSpecifier &&
  ts.isStringLiteral(statement.moduleSpecifier)

/** 文件里是不是只有转发语句（export … from），也就是 barrel 或纯转发入口。 */
function isForwardingOnly(sourceFile) {
  return (
    sourceFile.statements.length > 0 &&
    sourceFile.statements.every(
      (statement) => ts.isExportDeclaration(statement) && statement.moduleSpecifier
    )
  )
}

/** 绑定模式里声明的全部名字（`export const { a, b } = …`）。 */
function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
  )
}

/** 顶层语句自己声明并导出的名字。 */
function exportedDeclarationNames(statement) {
  if (ts.isExportAssignment(statement)) return statement.isExportEquals ? [] : ['default']
  const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : []
  if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return []
  if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword))
    return ['default']
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingNames(declaration.name)
    )
  const named =
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  return named && statement.name && ts.isIdentifier(statement.name) ? [statement.name.text] : []
}

/** 本地名在文件里是从哪条 import 进来的：{ statement, imported, typeOnly }，不是 import 的返回 null。 */
function importBinding(sourceFile, localName) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue
    const clause = statement.importClause
    if (clause.name?.text === localName)
      return { statement, imported: 'default', typeOnly: clause.isTypeOnly }
    const bindings = clause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === localName)
      return { statement, imported: '*', typeOnly: clause.isTypeOnly }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.name.text === localName)
          return {
            statement,
            imported: (element.propertyName ?? element.name).text,
            typeOnly: clause.isTypeOnly || element.isTypeOnly,
          }
      }
    }
  }
  return null
}

/** 紧贴在语句上方（中间没有空行）的注释原文；文件第一条语句上方的算文件头，不算它的。 */
function attachedComments(sourceFile, statement) {
  if (sourceFile.statements[0] === statement) return []
  const text = sourceFile.text
  const ranges = ts.getLeadingCommentRanges(text, statement.pos) ?? []
  const kept = []
  let end = statement.getStart(sourceFile)
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    if (/\n[ \t]*\n/u.test(text.slice(ranges[index].end, end))) break
    kept.unshift(text.slice(ranges[index].pos, ranges[index].end))
    end = ranges[index].pos
  }
  return kept
}

/** 外部模块（不在包的 src 里）有没有导出这个名字。 */
function externalModuleExports(context, moduleSpecifier, name) {
  const symbol = context.checker.getSymbolAtLocation(moduleSpecifier)
  return (
    !!symbol &&
    context.checker.getExportsOfModule(symbol).some((exported) => exported.name === name)
  )
}

/**
 * 顺着转发链找 file 以 name 导出的东西真正声明在哪。
 * 返回 { file, name, typeOnly, hops }（name 是声明文件导出它用的名字）、{ external, name, typeOnly, hops }、
 * { namespace, typeOnly, hops }（命名空间转发，拆不了）；找不到返回 null。
 * typeOnly 表示链上有一环只转发类型；hops 是从 file 起一路经过的 { file, name, explicit, comments }，
 * explicit 表示这一环是具名的 export { … }（不是 export *），comments 是贴在那条语句上方的注释。
 */
function traceExport(context, file, name, seen = new Set()) {
  const key = `${file}\0${name}`
  const topLevel = seen.size === 0
  if (topLevel && context.cache.has(key)) return context.cache.get(key)
  if (seen.has(key)) return null
  seen.add(key)
  const result = traceExportUncached(context, file, name, seen)
  if (topLevel) context.cache.set(key, result)
  return result
}

function traceExportUncached(context, file, name, seen) {
  const sourceFile = context.program.getSourceFile(file)
  if (!sourceFile) return null
  if (
    sourceFile.statements.some((statement) => exportedDeclarationNames(statement).includes(name))
  ) {
    return { file, name, typeOnly: false, hops: [{ file, name, explicit: false, comments: [] }] }
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue
    const here = { file, name, explicit: true, comments: attachedComments(sourceFile, statement) }
    if (ts.isNamespaceExport(statement.exportClause)) {
      if (statement.exportClause.name.text === name)
        return {
          namespace: statement.moduleSpecifier.text,
          typeOnly: statement.isTypeOnly,
          hops: [here],
        }
      continue
    }
    const element = statement.exportClause.elements.find(
      (candidate) => candidate.name.text === name
    )
    if (!element) continue
    const inner = (element.propertyName ?? element.name).text
    let next = {
      moduleSpecifier: statement.moduleSpecifier,
      imported: inner,
      typeOnly: statement.isTypeOnly || element.isTypeOnly,
    }
    if (!statement.moduleSpecifier) {
      const binding = importBinding(sourceFile, inner)
      // 本文件自己的声明，只是换了个名字导出：声明文件就是这里，导出名是 name。
      if (!binding) return { file, name, typeOnly: next.typeOnly, hops: [here] }
      if (binding.imported === '*')
        return {
          namespace: binding.statement.moduleSpecifier.text,
          typeOnly: next.typeOnly || binding.typeOnly,
          hops: [here],
        }
      next = {
        moduleSpecifier: binding.statement.moduleSpecifier,
        imported: binding.imported,
        typeOnly: next.typeOnly || binding.typeOnly,
      }
    }
    const target = moduleFileOf(context, next.moduleSpecifier)
    if (!target || !isPackageSource(target))
      return {
        external: next.moduleSpecifier.text,
        name: next.imported,
        typeOnly: next.typeOnly,
        hops: [here],
      }
    const found = traceExport(context, target, next.imported, seen)
    return (
      found && { ...found, typeOnly: found.typeOnly || next.typeOnly, hops: [here, ...found.hops] }
    )
  }
  const candidates = []
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.exportClause || !statement.moduleSpecifier)
      continue
    const here = { file, name, explicit: false, comments: [] }
    const target = moduleFileOf(context, statement.moduleSpecifier)
    if (!target || !isPackageSource(target)) {
      if (externalModuleExports(context, statement.moduleSpecifier, name))
        candidates.push({
          external: statement.moduleSpecifier.text,
          name,
          typeOnly: statement.isTypeOnly,
          hops: [here],
        })
      continue
    }
    const found = traceExport(context, target, name, new Set(seen))
    if (found)
      candidates.push({
        ...found,
        typeOnly: found.typeOnly || statement.isTypeOnly,
        hops: [here, ...found.hops],
      })
  }
  if (candidates.length === 0) return null
  // 同一个名字经几条 export * 到达：只要有一条不是只转发类型，它就不是只有类型。
  return { ...candidates[0], typeOnly: candidates.every((candidate) => candidate.typeOnly) }
}

/** 顺着别名走到底的符号。 */
function unwrapAlias(checker, symbol) {
  let current = symbol
  const seen = new Set()
  while (current && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current)
    current = checker.getAliasedSymbol(current)
  }
  return current
}

/** 模块以某个名字导出的符号（顺着别名走到底）。 */
function exportedSymbol(context, file, name) {
  const sourceFile = context.program.getSourceFile(file)
  const moduleSymbol = sourceFile && context.checker.getSymbolAtLocation(sourceFile)
  const symbol =
    moduleSymbol &&
    context.checker.getExportsOfModule(moduleSymbol).find((candidate) => candidate.name === name)
  return symbol ? unwrapAlias(context.checker, symbol) : null
}

/** 声明的身份：声明所在文件（包内相对）加符号名，跨两次建程序可比。 */
function identityOf(symbol) {
  const files = [
    ...new Set(
      (symbol?.declarations ?? []).map((declaration) =>
        relative(RepoRoot, resolve(declaration.getSourceFile().fileName))
      )
    ),
  ].sort()
  return symbol ? `${files.join('+')}::${symbol.escapedName}` : '<无法解析>'
}

/** 生成从 fromFile 指向 targetFile 的相对模块路径。 */
function specifierFor(fromFile, targetFile, style) {
  let path = relative(dirname(fromFile), targetFile).split(sep).join('/')
  if (!path.startsWith('.')) path = `./${path}`
  const extension = path.endsWith('.d.ts') ? '.d.ts' : extname(path)
  const bare = path.slice(0, path.length - extension.length)
  if (style === 'js') return `${bare}.js`
  if (style === 'ts') return path
  if (bare.endsWith('/index')) {
    const directory = bare.slice(0, -'/index'.length)
    if (directory !== '.' && directory !== '..' && !directory.endsWith('/..')) return directory
  }
  return bare
}

/** 渲染一条命名的 import / export from。record：{ kind, typeOnly, specifier, quote, semicolon, multiline, elements }。 */
function renderStatement(record) {
  const names = record.elements.map((element) => {
    const text =
      element.imported === element.local ? element.local : `${element.imported} as ${element.local}`
    return element.typeOnly && !record.typeOnly ? `type ${text}` : text
  })
  const head = `${record.kind} ${record.typeOnly ? 'type ' : ''}`
  const tail = ` from ${record.quote}${record.specifier}${record.quote}${record.semicolon ? ';' : ''}`
  const singleLine = `${head}{ ${names.join(', ')} }${tail}`
  if (!record.multiline && singleLine.length <= MaxSingleLineWidth) return singleLine
  return `${head}{\n${names.map((name) => `  ${name},`).join('\n')}\n}${tail}`
}

/** 语句只保留部分名字时，按原来的写法（单行/多行）重新渲染。 */
function recordOf(statement, sourceFile) {
  const isImport = ts.isImportDeclaration(statement)
  const bindings = isImport ? statement.importClause.namedBindings : statement.exportClause
  const typeOnly = isImport ? statement.importClause.isTypeOnly : statement.isTypeOnly
  return {
    kind: isImport ? 'import' : 'export',
    typeOnly,
    specifier: statement.moduleSpecifier.text,
    quote: statement.moduleSpecifier.getText(sourceFile)[0],
    semicolon: statement.getText(sourceFile).trimEnd().endsWith(';'),
    multiline: bindings.getText(sourceFile).includes('\n'),
    elements: bindings.elements.map((element) => ({
      imported: (element.propertyName ?? element.name).text,
      local: element.name.text,
      typeOnly: typeOnly || element.isTypeOnly,
    })),
  }
}

/** 花括号里夹着注释的语句：重新渲染会丢注释，不往里并名字，要改它时停下来人工处理。 */
function hasInnerComments(statement, sourceFile) {
  const bindings = ts.isImportDeclaration(statement)
    ? statement.importClause?.namedBindings
    : statement.exportClause
  return !!bindings && /\/\/|\/\*/u.test(bindings.getText(sourceFile))
}

/** 一条 import 是否只有命名绑定（没有默认导入、命名空间导入，也不是副作用导入）。 */
function isNamedOnly(statement) {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause
    return (
      !!clause && !clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings)
    )
  }
  return !!statement.exportClause && ts.isNamedExports(statement.exportClause)
}

// —— imports：包内 import / export from 直指声明文件 ——

/**
 * 改写一个文件里经转发或包名自引用的 import / export from。
 * 返回 { text, moved, selfReferences, leftovers, notes }；notes 是要人复核的地方（语句上方贴着注释）。
 */
function rewriteImports(context, file, style) {
  const sourceFile = context.program.getSourceFile(file)
  const text = sourceFile.text
  const leftovers = []
  const notes = []
  const records = []
  const groups = new Map()
  let moved = 0
  let selfReferences = 0

  for (const statement of sourceFile.statements.filter(isModuleStatement)) {
    const specifier = statement.moduleSpecifier.text
    const self = isSelfReference(specifier)
    const target = moduleFileOf(context, statement.moduleSpecifier)
    if (!self && (!target || !isPackageSource(target))) continue
    const where = `${show(file)}:${sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1}`
    if (self) selfReferences += 1
    if (self && (!target || !isPackageSource(target))) {
      leftovers.push(
        `${where} ${specifier}：包名没有被 tsconfig paths 映射到 src，解析不到，原样留下`
      )
      continue
    }
    const relativeTarget = specifierFor(file, target, style)
    if (!isNamedOnly(statement)) {
      const form = ts.isImportDeclaration(statement)
        ? statement.importClause
          ? '默认或命名空间导入'
          : '副作用导入'
        : 'export *'
      if (self) records.push({ statement, record: null, replaceSpecifier: relativeTarget })
      if (self || isForwardingOnly(context.program.getSourceFile(target)))
        leftovers.push(
          `${where} ${form}（${specifier}）拆不了，原样留下${self ? '，只把包名改成相对路径' : ''}`
        )
      continue
    }
    const record = recordOf(statement, sourceFile)
    const kept = []
    const elements = ts.isImportDeclaration(statement)
      ? statement.importClause.namedBindings.elements
      : statement.exportClause.elements
    elements.forEach((element, index) => {
      const entry = record.elements[index]
      const found = traceExport(context, target, entry.imported)
      const checkerTarget = unwrapAlias(
        context.checker,
        context.checker.getSymbolAtLocation(element.name)
      )
      if (!found || found.namespace) {
        kept.push(entry)
        leftovers.push(
          `${where} ${entry.imported}：${found?.namespace ? '经命名空间转发' : '顺着转发链找不到声明'}，原样留下`
        )
        return
      }
      if (found.external) {
        pushGroup(
          groups,
          record.kind,
          `external:${found.external}`,
          { specifier: found.external, target: null },
          {
            imported: found.name,
            local: entry.local,
            typeOnly: entry.typeOnly || (record.kind === 'export' && found.typeOnly),
          },
          statement
        )
        moved += 1
        return
      }
      // 名字经转发链找到的声明必须和类型检查器给的一致，不一致就不动它。
      if (exportedSymbol(context, found.file, found.name) !== checkerTarget) {
        kept.push(entry)
        leftovers.push(`${where} ${entry.imported}：转发链与类型检查器解析的声明不一致，原样留下`)
        return
      }
      if (found.file === file) {
        kept.push(entry)
        leftovers.push(`${where} ${entry.imported}：声明就在本文件，原样留下`)
        return
      }
      if (found.file === target && !self) {
        kept.push(entry)
        return
      }
      pushGroup(
        groups,
        record.kind,
        found.file,
        { specifier: specifierFor(file, found.file, style), target: found.file },
        {
          imported: found.name,
          local: entry.local,
          typeOnly: entry.typeOnly || (record.kind === 'export' && found.typeOnly),
        },
        statement
      )
      moved += 1
    })
    const changed = kept.length !== record.elements.length || self
    if (changed && kept.length > 0 && hasInnerComments(statement, sourceFile))
      throw new Error(`${where}：花括号里有注释，改写会丢注释，请先手工处理`)
    if (changed && attachedComments(sourceFile, statement).length > 0)
      notes.push(`${where}：语句上方贴着注释，改写后请复核注释的位置`)
    records.push({
      statement,
      record: changed ? { ...record, elements: kept, specifier: relativeTarget } : record,
      changed,
      target,
    })
  }
  if (groups.size === 0 && !records.some((entry) => entry.changed || entry.replaceSpecifier))
    return null

  // 并进同一文件里已有的、指向同一目标的同类命名语句；并不进去的，在第一条来源语句的位置新起语句。
  const inserted = new Map()
  for (const group of groups.values()) {
    const rest = []
    for (const element of group.elements) {
      const host = records.find(
        (entry) =>
          entry.record &&
          entry.record.kind === group.kind &&
          entry.target &&
          entry.target === group.target &&
          entry.record.elements.length > 0 &&
          isNamedOnly(entry.statement) &&
          !hasInnerComments(entry.statement, sourceFile) &&
          (!entry.record.typeOnly || element.typeOnly)
      )
      if (host) {
        host.record.elements.push(element)
        host.changed = true
      } else rest.push(element)
    }
    if (rest.length === 0) continue
    const quoteSource = records.find((entry) => entry.statement === group.anchor)?.record ?? {
      quote: "'",
      semicolon: false,
    }
    const created = {
      kind: group.kind,
      typeOnly: rest.every((element) => element.typeOnly),
      specifier: group.specifier,
      quote: quoteSource.quote,
      semicolon: quoteSource.semicolon,
      multiline: false,
      elements: rest,
    }
    inserted.set(group.anchor, [...(inserted.get(group.anchor) ?? []), created])
  }

  const edits = []
  for (const entry of records) {
    const statement = entry.statement
    const additions = (inserted.get(statement) ?? []).map(renderStatement)
    if (entry.replaceSpecifier) {
      const literal = statement.moduleSpecifier
      edits.push({
        start: literal.getStart(sourceFile) + 1,
        end: literal.getEnd() - 1,
        text: entry.replaceSpecifier,
      })
      if (additions.length > 0)
        edits.push({
          start: statement.getEnd(),
          end: statement.getEnd(),
          text: `\n${additions.join('\n')}`,
        })
      continue
    }
    if (!entry.changed && additions.length === 0) continue
    const own = entry.changed
      ? entry.record.elements.length > 0
        ? [renderStatement(entry.record)]
        : []
      : [statement.getText(sourceFile)]
    const replacement = [...own, ...additions].join('\n')
    let end = statement.getEnd()
    if (replacement === '' && text[end] === '\n') end += 1
    edits.push({ start: statement.getStart(sourceFile), end, text: replacement })
  }
  let output = text
  for (const edit of edits.sort((left, right) => right.start - left.start))
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
  return { text: output, moved, selfReferences, leftovers, notes }
}

/** 按（种类，目标）把挪走的名字归组；anchor 是第一条来源语句，新语句放在它的位置。 */
function pushGroup(groups, kind, targetKey, where, element, statement) {
  const key = `${kind}\0${targetKey}`
  if (!groups.has(key))
    groups.set(key, {
      kind,
      specifier: where.specifier,
      target: where.target,
      anchor: statement,
      elements: [],
    })
  groups.get(key).elements.push(element)
}

/** 文件里全部命名 import / export from 的名字 → 声明身份（核对改写前后用）。 */
function importedIdentities(context, file) {
  const sourceFile = context.program.getSourceFile(file)
  const identities = new Map()
  for (const statement of sourceFile.statements.filter(isModuleStatement)) {
    if (!isNamedOnly(statement)) continue
    const kind = ts.isImportDeclaration(statement) ? 'import' : 'export'
    const elements =
      kind === 'import'
        ? statement.importClause.namedBindings.elements
        : statement.exportClause.elements
    for (const element of elements)
      identities.set(
        `${kind}:${element.name.text}`,
        identityOf(unwrapAlias(context.checker, context.checker.getSymbolAtLocation(element.name)))
      )
  }
  return identities
}

// —— entries：入口改成逐个名字的显式转发 ——

/** 导出符号是不是 `export { 甲 as 乙 }` 形式的别名，是就返回甲（与 check:agent-public-api 的判定一致）。 */
function aliasOf(symbol) {
  const specifier = (symbol.declarations ?? []).find(
    (declaration) => ts.isExportSpecifier(declaration) && declaration.propertyName
  )
  return specifier?.propertyName.text
}

/** 导出符号的声明或它所在的转发语句是否标了 @deprecated（与 check:agent-public-api 的判定一致）。 */
function hasDeprecatedTag(symbol) {
  return (symbol.declarations ?? []).some((declaration) => {
    if (ts.getJSDocTags(declaration).some((tag) => tag.tagName.text === 'deprecated')) return true
    const owner = ts.isExportSpecifier(declaration) ? declaration.parent.parent : declaration
    return /@deprecated\b/u.test(owner.getFullText())
  })
}

/** 文件是不是只有转发语句。 */
const isForwardingOnlyFile = (context, file) => {
  const sourceFile = context.program.getSourceFile(file)
  return !!sourceFile && isForwardingOnly(sourceFile)
}

/** 入口导出面：名字 → 「声明身份 值/类型 别名指向 别名是否标了 @deprecated」，核对改写前后用。 */
function entrySurface(context, file) {
  const sourceFile = context.program.getSourceFile(file)
  const moduleSymbol = context.checker.getSymbolAtLocation(sourceFile)
  const surface = new Map()
  for (const symbol of moduleSymbol ? context.checker.getExportsOfModule(moduleSymbol) : []) {
    const target = unwrapAlias(context.checker, symbol)
    const traced = traceExport(context, file, symbol.name)
    const typeOnly = !!traced?.typeOnly || (target.flags & ts.SymbolFlags.Value) === 0
    const alias = aliasOf(symbol)
    const deprecated = alias ? (hasDeprecatedTag(symbol) ? ' deprecated' : '') : ''
    surface.set(
      symbol.name,
      `${identityOf(target)} ${typeOnly ? 'type' : 'value'} alias=${alias ?? '-'}${deprecated}`
    )
  }
  return surface
}

/** 把一个只有转发语句的入口改写成逐个名字的显式转发；返回 { text, count, carried, problems }，carried 是带过来的注释。 */
function rewriteEntry(context, file, style) {
  const sourceFile = context.program.getSourceFile(file)
  const moduleSymbol = context.checker.getSymbolAtLocation(sourceFile)
  const problems = []
  const carried = []
  const groups = new Map()
  for (const symbol of context.checker.getExportsOfModule(moduleSymbol)) {
    const name = symbol.name
    const target = unwrapAlias(context.checker, symbol)
    const found = traceExport(context, file, name)
    if (!found || found.namespace) {
      problems.push(
        `${show(file)} ${name}：${found ? '命名空间转发拆不了' : '顺着转发链找不到声明'}`
      )
      continue
    }
    const hops = found.hops
    let source = { specifier: found.external, name: found.name, index: hops.length - 1 }
    if (!found.external) {
      // 别名指向保持不变：入口原来最近的一环具名转发写的是「甲 as 乙」，新入口也写「甲 as 乙」。一般甲就是声明文件导出它的名字；
      // 改名发生在中间的非转发文件里时（例如 `import type { X }` 之后 `export type { X as Y }`），从链上最深、仍以甲导出它的非转发文件转发。
      const wanted = aliasOf(symbol) ?? name
      let index = hops.length - 1
      while (
        index > 0 &&
        !(
          hops[index].name === wanted &&
          (index === hops.length - 1 || !isForwardingOnlyFile(context, hops[index].file))
        )
      )
        index -= 1
      if (index === 0) index = hops.length - 1
      if (exportedSymbol(context, hops[index].file, hops[index].name) !== target) {
        problems.push(`${show(file)} ${name}：转发链与类型检查器解析的声明不一致`)
        continue
      }
      source = {
        specifier: specifierFor(file, hops[index].file, style),
        name: hops[index].name,
        index,
      }
    }
    // 带过来的注释：要删掉或重写的转发文件里贴在转发语句上方的，加上入口原来最近那一环具名转发上方的（@deprecated 判定看它）。
    const firstExplicit = hops.findIndex((hop) => hop.explicit)
    const comments = hops
      .slice(0, source.index + 1)
      .filter(
        (hop, position) =>
          hop.comments.length > 0 &&
          (position === firstExplicit || isForwardingOnlyFile(context, hop.file))
      )
      .flatMap((hop) => hop.comments)
    const typeOnly = found.typeOnly || (target.flags & ts.SymbolFlags.Value) === 0
    const comment = [...new Set(comments)].join('\n')
    if (comment) carried.push(`${name} ← ${comment.replace(/\s+/gu, ' ').slice(0, 80)}`)
    const key = `${source.specifier}\0${typeOnly}\0${comment}`
    if (!groups.has(key))
      groups.set(key, { specifier: source.specifier, typeOnly, comment, elements: [] })
    groups.get(key).elements.push({ imported: source.name, local: name, typeOnly })
  }
  const first = sourceFile.statements[0]
  const header = first ? sourceFile.text.slice(0, first.getStart(sourceFile)) : ''
  const statements = [...groups.values()]
    .sort(
      (left, right) =>
        left.specifier.localeCompare(right.specifier) ||
        Number(right.typeOnly) - Number(left.typeOnly) ||
        left.comment.localeCompare(right.comment)
    )
    .map((group) => {
      const elements = group.elements.sort((left, right) => left.local.localeCompare(right.local))
      const statement = renderStatement({
        kind: 'export',
        typeOnly: group.typeOnly,
        specifier: group.specifier,
        quote: "'",
        semicolon: false,
        multiline: false,
        elements,
      })
      return group.comment ? `${group.comment}\n${statement}` : statement
    })
  return {
    text: `${header}${statements.join('\n')}\n`,
    count: [...groups.values()].reduce((sum, group) => sum + group.elements.length, 0),
    carried,
    problems,
  }
}

// —— barrels：删掉没人引用的中间转发文件 ——

/** 全仓（packages、tests、scripts、products、component-library）引用这些文件的地方：相对路径、包名子路径、写死的路径字符串。 */
function repositoryReferences(targets) {
  const roots = ['packages', 'tests', 'scripts', 'products', 'component-library'].map((directory) =>
    join(RepoRoot, directory)
  )
  const files = roots.flatMap(function list(directory) {
    if (!existsSync(directory)) return []
    return readdirSync(directory).flatMap((entry) => {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) return []
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) return list(path)
      return /\.(?:ts|tsx|mts|cts|js|mjs|cjs|json)$/u.test(entry) ? [path] : []
    })
  })
  const candidates = (base) => {
    const list = [base, base.replace(/\.[cm]?js$/u, '.ts')]
    for (const extension of ['.ts', '.tsx', '.mts', '.d.ts', '.js', '.mjs'])
      list.push(`${base}${extension}`, join(base, `index${extension}`))
    return list
  }
  const byPath = new Map(
    [...targets].map((target) => [relative(RepoRoot, target).split(sep).join('/'), target])
  )
  const references = new Map([...targets].map((target) => [target, []]))
  for (const file of files) {
    if (targets.has(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const [path, target] of byPath)
      if (text.includes(path))
        references.get(target).push(`${relative(RepoRoot, file)}（写死的路径）`)
    if (file.endsWith('.json')) continue
    for (const match of text.matchAll(
      /(?:from|import|require|export\s*\*\s*from)\s*\(?\s*['"]([^'"\n]+)['"]/gu
    )) {
      const specifier = match[1]
      let base = null
      if (specifier.startsWith('.')) base = resolve(dirname(file), specifier)
      else if (isSelfReference(specifier) && specifier !== packageName)
        base = join(sourceRoot, specifier.slice(packageName.length + 1))
      if (!base) continue
      const hit = candidates(base).find((candidate) => targets.has(candidate))
      if (hit) references.get(hit).push(`${relative(RepoRoot, file)}（${specifier}）`)
    }
  }
  return references
}

// —— 核对与落盘 ——

/** 类型诊断的多重集合（文件 + 错误码），改写前后比较用。 */
function diagnosticsOf(context) {
  const counts = new Map()
  for (const diagnostic of ts.getPreEmitDiagnostics(context.program)) {
    const file = diagnostic.file ? relative(RepoRoot, resolve(diagnostic.file.fileName)) : '<全局>'
    if (diagnostic.file && !resolve(diagnostic.file.fileName).startsWith(`${packageRoot}${sep}`))
      continue
    const key = `${file} TS${diagnostic.code}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** 改写后新增的类型诊断。 */
function newDiagnostics(before, after) {
  const added = []
  for (const [key, count] of after) {
    const previous = before.get(key) ?? 0
    if (count > previous) added.push(`${key} ×${count - previous}`)
  }
  return added
}

/** 用仓库 ESLint 配置里的 simple-import-sort 两条规则重排文件里的 import / export。 */
async function sortModuleStatements(files) {
  if (!sortAfterWrite || files.length === 0) return
  const eslint = new ESLint({
    cwd: RepoRoot,
    fix: true,
    // 只跑排序规则；不报也不修「用不上的 eslint-disable」，否则被过滤掉的规则的 disable 注释会被当成多余删掉。
    overrideConfig: { linterOptions: { reportUnusedDisableDirectives: 'off' } },
    ruleFilter: ({ ruleId }) => ruleId.startsWith('simple-import-sort/'),
  })
  const results = await eslint.lintFiles(files)
  await ESLint.outputFixes(results)
  const remaining = results.flatMap((result) =>
    result.messages.map(
      (message) =>
        `${relative(RepoRoot, result.filePath)}:${message.line} ${message.ruleId ?? '解析'} ${message.message}`
    )
  )
  if (remaining.length > 0) console.info(`重排之后仍有问题：\n  ${remaining.join('\n  ')}`)
}

function printList(title, lines) {
  if (lines.length === 0) return
  console.info(`${title}（${lines.length}）：\n  ${lines.join('\n  ')}`)
}

async function stepImports() {
  const files = ScannedDirectories.flatMap((directory) =>
    walk(join(packageRoot, directory))
  ).filter((file) => !file.endsWith('.d.ts'))
  const style = detectSpecifierStyle(files)
  const before = createProgram()
  const overlay = new Map()
  const expected = new Map()
  const leftovers = []
  const notes = []
  let moved = 0
  let selfReferences = 0
  for (const file of files) {
    const sourceFile = before.program.getSourceFile(file)
    // 只有转发语句的文件（barrel 与纯转发入口）不在这一步改：入口由 entries 重写，barrel 由 barrels 删掉。
    if (!sourceFile || isForwardingOnly(sourceFile)) continue
    const result = rewriteImports(before, file, style)
    if (!result) continue
    leftovers.push(...result.leftovers)
    notes.push(...result.notes)
    moved += result.moved
    selfReferences += result.selfReferences
    if (result.text !== sourceFile.text) overlay.set(file, result.text)
    expected.set(file, importedIdentities(before, file))
  }
  // 核对：改过的文件里每个名字仍解析到原来的声明，类型诊断不增加。
  const after = createProgram(overlay)
  const mismatches = []
  for (const [file, identities] of expected) {
    const now = importedIdentities(after, file)
    for (const [name, identity] of identities)
      if (now.get(name) !== identity)
        mismatches.push(`${show(file)} ${name}：原来 ${identity}，现在 ${now.get(name) ?? '缺失'}`)
    for (const name of now.keys())
      if (!identities.has(name)) mismatches.push(`${show(file)} ${name}：改写后多出来的名字`)
  }
  const added = newDiagnostics(diagnosticsOf(before), diagnosticsOf(after))
  console.info(
    `imports：改写 ${overlay.size} 个文件，按名字挪到声明文件 ${moved} 处，包名自引用语句 ${selfReferences} 条；相对路径写法：${style === 'none' ? '不带扩展名' : `带 .${style}`}`
  )
  printList('拆不了而原样留下的', leftovers)
  printList('要复核的', notes)
  if (mismatches.length > 0 || added.length > 0) {
    printList('名字解析与改写前不一致', mismatches)
    printList('新增的类型诊断', added)
    throw new Error('imports 核对不通过，整批不落盘')
  }
  return overlay
}

async function stepEntries() {
  const files = ScannedDirectories.flatMap((directory) =>
    walk(join(packageRoot, directory))
  ).filter((file) => !file.endsWith('.d.ts'))
  const style = detectSpecifierStyle(files)
  const before = createProgram()
  const overlay = new Map()
  const problems = []
  const surfaces = new Map()
  for (const [file, subpath] of entries) {
    const sourceFile = before.program.getSourceFile(file)
    if (!isForwardingOnly(sourceFile)) {
      console.info(`entries：${subpath}（${show(file)}）有自己的声明，不是纯转发，跳过`)
      continue
    }
    const result = rewriteEntry(before, file, style)
    problems.push(...result.problems)
    surfaces.set(file, entrySurface(before, file))
    overlay.set(file, result.text)
    console.info(`entries：${subpath}（${show(file)}）${result.count} 个名字`)
    printList(`  ${subpath} 从转发链带过来的注释`, result.carried)
  }
  const after = createProgram(overlay)
  const mismatches = []
  for (const [file, surface] of surfaces) {
    const now = entrySurface(after, file)
    for (const [name, line] of surface)
      if (now.get(name) !== line)
        mismatches.push(`${show(file)} ${name}：原来 ${line}，现在 ${now.get(name) ?? '缺失'}`)
    for (const name of now.keys())
      if (!surface.has(name)) mismatches.push(`${show(file)} ${name}：改写后多出来的名字`)
  }
  const added = newDiagnostics(diagnosticsOf(before), diagnosticsOf(after))
  if (problems.length > 0 || mismatches.length > 0 || added.length > 0) {
    printList('入口里拆不了的名字', problems)
    printList('入口导出面与改写前不一致', mismatches)
    printList('新增的类型诊断', added)
    throw new Error('entries 核对不通过，整批不落盘')
  }
  return overlay
}

async function stepBarrels() {
  const context = createProgram()
  const barrels = new Set(
    walk(sourceRoot).filter(
      (file) =>
        !file.endsWith('.d.ts') &&
        !entries.has(file) &&
        isForwardingOnly(context.program.getSourceFile(file))
    )
  )
  const references = repositoryReferences(barrels)
  const deletable = [...barrels].filter((file) => references.get(file).length === 0).sort()
  const kept = [...barrels].filter((file) => references.get(file).length > 0).sort()
  const overlay = new Map(deletable.map((file) => [file, null]))
  const added = newDiagnostics(diagnosticsOf(context), diagnosticsOf(createProgram(overlay)))
  console.info(`barrels：只有转发语句的非入口文件 ${barrels.size} 个，可删 ${deletable.length} 个`)
  printList('可删', deletable.map(show))
  printList(
    '仍被引用、留下的',
    kept.map((file) => `${show(file)} ← ${references.get(file).join('；')}`)
  )
  if (added.length > 0) {
    printList('删掉后新增的类型诊断', added)
    throw new Error('barrels 核对不通过，一个都不删')
  }
  return overlay
}

/** 把覆盖表落盘：新文本写回，null 从工作区删掉（只删纳入 git 的文件；不碰 git 索引，提交时由调用方自己 add）。 */
async function apply(overlay) {
  const written = []
  for (const [file, text] of overlay) {
    if (text === null) {
      try {
        execFileSync('git', ['ls-files', '--error-unmatch', '--', file], {
          cwd: RepoRoot,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      } catch {
        throw new Error(`没纳入 git 的文件不删：${show(file)}`)
      }
      unlinkSync(file)
    } else {
      writeFileSync(file, text)
      written.push(file)
    }
  }
  await sortModuleStatements(written)
}

const plan = stepArg === 'all' ? ['imports', 'entries', 'barrels'] : [stepArg]
for (const step of plan) {
  const overlay =
    step === 'imports'
      ? await stepImports()
      : step === 'entries'
        ? await stepEntries()
        : await stepBarrels()
  if (dryRun) {
    // 后一步要按前一步落盘后的文件分析，演练 all 只演第一步。
    console.info(
      `（演练，${step} 不落盘${plan.length > 1 ? '；后面的步骤要等这一步落盘才能分析，演练到此为止' : ''}）`
    )
    break
  }
  await apply(overlay)
  console.info(`${step} 完成`)
}
