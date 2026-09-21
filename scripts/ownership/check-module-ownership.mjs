#!/usr/bin/env bun
// 模块结构门：核对每个已治理模块的文件分工与对外边界有没有塌。登记在 governed-modules.mjs。
//
// 这里不拦编辑，只核对：
//   1. 工具文件：全部工具定义都在登记的那一个文件里，定义工具的函数只在那里被调用（没有工具的包不登记 toolsFile / toolDefiner / hostPort）。
//      工具文件只放定义：execute 只许简单的一两步（最多 ExecuteStatementLimit 条语句），实现多的交给 impl 里的类。
//   2. types：只放类型，一个值都不许有；只用 type import，只引 types 与合同；哪些类型出包由合同的签名闭包决定。
//      可移植文件（types/<portable> 与 contract/constants.ts）不 import、不用 Node 类型，可移植数据不带函数成员。
//   3. contract：只有 provides.ts、requires.ts、constants.ts 三个文件（代码面能力另有生成器写的 surface.ts：模型面的声明随包发布）。provides / requires 只放带中文说明的接口声明（每个成员也有说明），
//      或者 export type { X } from '../impl/<类文件>.js' 登记类上方的接口（合同里的接口要用登记过的接口时可以 import type 它）；constants.ts 只放 Object.freeze 的常量表、字符串身份和由它们派生的类型别名。
//   4. impl：一个类一个文件、文件名即类名（工具文件不放类）；只许声明并导出本文件的类实现的接口和以类名开头的配套接口，
//      都要有中文说明，其余类型不许写在这里（带 typeof 的除外）；每个类 implements 一个接口：写在类上方（公开的在 provides.ts 登记，注入面的在 requires.ts；继承 Error 的错误类除外），公开成员都在接口里，没有公开静态成员，
//      私有方法必须用到实例状态；类的属性不许直接挂导入的函数（测试钩子）；模块级函数只许是对外入口要的工厂。按 layers 分层，下层不许引上层。
//   5. utils：只放函数和常量，不放类、不声明类型、没有模块级 let；每个函数上方一句中文说明；只引 utils、types 与合同。
//      分包：types、impl、utils 文件多时可以按域开子目录，每个子目录至少直接放 3 个源文件；分层可以按子目录登记（以 / 结尾）。
//   6. 对外入口由合同控制：入口文件只有转发语句；导出的类型只能来自 provides、requires、公开的 types 文件、常量表派生的别名，或 provides 登记的类上方接口；
//      导出的值要么是 contract 的常量表，要么是 impl 里显式标注了公开接口类型的实例或工厂，不许导出类、utils 函数和内部接口；
//      provides 与 requires 里的每个声明都从根入口导出；公开接口引用到的数据类型都导出，导出的数据类型都被公开接口用到；
//      可移植数据文件里没有公开接口用不到的类型。package.json 的 exports 与 src 根上的入口文件一一对应，编译目标是 dist/<名>.js 与 dist/<名>.d.ts。
//   7. 会被渲染进程加载的入口，整条值引用链里不许出现 Node 内置模块。
//   8. 环境变量：代码里出现的每个 VELAROS_*（以及登记在 environmentPrefixes 里的别人的前缀）名字都登记在常量表的环境变量表里，登记了的都有人用。
//      宿主端口：登记的端口接口里的每个方法，都有工具在调（工具文件自己调，或它委托的 impl 类在调）；没人调的方法不许留在注入面。
//   9. src 下只有 contract、types、impl、utils 四个目录加入口文件；src 根上除入口以外不放源文件（src 根与入口目录里的每个 .ts 都要在
//      package.json 的 exports 里有对应子路径）；依赖只许写在文件头，不许用内联 import 类型；
//      动态 import 只放行登记表 lazyImports 里登记过的目标（谁加载、加载什么、为什么）。
//      可执行入口放包根 bin/：package.json 的 bin 指 ./bin/<命令>.mjs，文件在、带 #!/usr/bin/env node、files 里有 bin。
//      能力单元（登记了 unit 的模块，几个模块按目录放在一个包里）：源码根是包里的单元目录（不是 src/），入口是 ./<单元> 与 ./<单元>/…，
//      编译到 dist/<单元>/；单元目录下另有 spec/ 与 test/，不算源码。登记的名字写成「包名/单元」。
//  10. 模块卡片十节齐全；「提供什么」列出全部入口、导出的每个值和每个公开接口；「骨干链路」点到每个工具；「结构」写明目录树。
//  11. 不变量登记表每行编号唯一、检验方式合法、检验器真的存在；卡片里的条数如实。包的 test 脚本跑验收测试。
//  12. 常量分四处：对外承诺的在 contract/constants.ts，每个数字上限有中文说明；可调参数只在登记的 utils/<tuning>：导出的冻结表，只放数字，每项有说明、每项有人用；
//      impl 的模块级只放日志与导出的实例，类里固定用的写成 private static readonly；impl 与 utils 里不许散写数字缺省值
//      （模块级数字常量、`?? 数字`、参数缺省写数字、名字像超时/上限/缓冲的属性写数字；0 与 1 除外）；
//      工具定义里的数字引常量表（示例与 1000、1024 这类单位换算除外），说明文字里不写两位以上的裸数字。
//  13. 模型和用户看得到的文字用中文：报错文字与 message、suggestedNextAction、note 字段不许是纯英文句子。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

import ts from 'typescript'
import { checkInterfaceModule } from './check-interface-module.mjs'

import {
  GovernedModules,
  InvariantCheckKinds,
  RequiredCardSections,
} from './governed-modules.mjs'

const RepoRoot = resolve(import.meta.dir, '../..')
/** 生成的 contract/surface.ts 的第一行；手写的文件冒充不了。 */
const GeneratedSurfaceHeader = '// 本文件由 scripts/script/generate-declarations.mjs 从能力包源码生成，不要手改。'
const PackagesRoot = join(RepoRoot, 'packages')
const RootManifest = JSON.parse(readFileSync(join(RepoRoot, 'package.json'), 'utf8'))
/** 本仓自己定义的环境变量一律用这个前缀；别人定义的前缀由登记表的 environmentPrefixes 补充。 */
const DefaultEnvironmentPrefix = 'VELAROS_'
/** 可执行入口固定放包根这个目录，扩展名固定 .mjs，第一行固定这个 shebang。 */
const BinaryDirectory = 'bin'
const BinaryExtension = '.mjs'
const BinaryShebang = '#!/usr/bin/env node'
const failures = []
const fail = (message) => failures.push(message)

/** 递归列出目录下的全部文件，不管扩展名。 */
function walkAll(directory) {
  if (!existsSync(directory)) return []
  if (statSync(directory).isFile()) return [directory]
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? walkAll(path) : [path]
  })
}

/** 递归列出目录下的 TypeScript 源文件（不含 .d.ts）。 */
function walkSources(directory) {
  return walkAll(directory).filter((path) => extname(path) === '.ts' && !path.endsWith('.d.ts'))
}

/** 列出目录下一级的子目录名。 */
function childDirectories(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return []
  return readdirSync(directory).filter((entry) => statSync(join(directory, entry)).isDirectory())
}

/** 分包后每个子目录至少直接放几个源文件：一两个文件不值得单开目录。 */
const MinFilesPerSubdirectory = 3

/** 递归列出目录下的全部子目录（相对路径）。 */
function nestedDirectories(directory, prefix = '') {
  return childDirectories(directory).flatMap((name) => {
    const relativePath = prefix ? `${prefix}/${name}` : name
    return [relativePath, ...nestedDirectories(join(directory, name), relativePath)]
  })
}

/** 目录下直接放着的 TypeScript 源文件数（不含 .d.ts，不算子目录里的）。 */
function directSourceCount(directory) {
  return readdirSync(directory).filter((entry) => extname(entry) === '.ts' && !entry.endsWith('.d.ts') && statSync(join(directory, entry)).isFile()).length
}

/** 工具文件里一个 execute 最多几条语句（含嵌套函数里的）；再多就算有实现，要搬进 impl 的类。 */
const ExecuteStatementLimit = 4

/** 语句节点的种类：块本身不算，块里的每条语句各算一条。 */
const StatementKinds = new Set([
  ts.SyntaxKind.VariableStatement, ts.SyntaxKind.ExpressionStatement, ts.SyntaxKind.ReturnStatement, ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.TryStatement, ts.SyntaxKind.ThrowStatement, ts.SyntaxKind.SwitchStatement, ts.SyntaxKind.FunctionDeclaration,
])

/** 数一个函数里一共有几条语句（含嵌套函数）；表达式体的箭头函数算一条。 */
function countStatements(node) {
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return 1 + countNested(node.body)
  return countNested(node)
}

/** 数字表达式的值：数字字面量、负号、括号，以及它们的加减乘除与乘方；不是纯数字表达式返回 null。 */
function numericValue(node) {
  if (!node) return null
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/gu, ''))
  if (ts.isParenthesizedExpression(node)) return numericValue(node.expression)
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const value = numericValue(node.operand)
    return value === null ? null : -value
  }
  if (!ts.isBinaryExpression(node)) return null
  const left = numericValue(node.left)
  const right = numericValue(node.right)
  if (left === null || right === null) return null
  switch (node.operatorToken.kind) {
    case ts.SyntaxKind.PlusToken: return left + right
    case ts.SyntaxKind.MinusToken: return left - right
    case ts.SyntaxKind.AsteriskToken: return left * right
    case ts.SyntaxKind.SlashToken: return left / right
    case ts.SyntaxKind.AsteriskAsteriskToken: return left ** right
    default: return null
  }
}

/** 0 与 1 不算缺省值：起点、步长、布尔一样的数字到处都是。 */
const isTrivialNumber = (value) => value === 0 || value === 1

/** 单位换算用的数字，工具定义里可以直接写。 */
const UnitFactors = new Set([1000, 1024])

/** 名字像超时、上限、缓冲、阈值的属性：这类属性写成数字就是散落的缺省值。 */
const KnobPropertyPattern = /(?:Ms|Bytes|Chars|Items|Files|Depth|Limit|Timeout|Buffer|Threshold)$|^(?:limit|timeout|maxBuffer|depth)$/u

/** `Object.freeze({…})`（参数可以带 as const）里的对象字面量；不是这种写法返回 null。 */
function frozenObjectLiteral(node) {
  if (!node || !ts.isCallExpression(node) || node.expression.getText() !== 'Object.freeze') return null
  let argument = node.arguments[0]
  while (argument && (ts.isAsExpression(argument) || ts.isSatisfiesExpression(argument) || ts.isParenthesizedExpression(argument))) argument = argument.expression
  return argument && ts.isObjectLiteralExpression(argument) ? argument : null
}

/** 数节点之下的语句节点。 */
function countNested(node) {
  let count = 0
  const visit = (child) => {
    if (StatementKinds.has(child.kind)) count += 1
    ts.forEachChild(child, visit)
  }
  ts.forEachChild(node, visit)
  return count
}

/** 按「## 标题」把卡片切成小节。 */
function sectionsOf(markdown) {
  const sections = new Map()
  for (const chunk of markdown.split(/^## /mu).slice(1)) {
    const newline = chunk.indexOf('\n')
    sections.set(chunk.slice(0, newline).trim(), chunk.slice(newline + 1))
  }
  return sections
}

/** 解析相对 import 指向的真实文件；解析不到返回 null（悬空 import 由 typecheck 抓）。 */
function resolveRelativeImport(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier)
  for (const candidate of [base.replace(/\.js$/u, '.ts'), `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

const parse = (file) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
const isExported = (statement) => statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false

/** 文件里所有带相对路径的 import / export … from。 */
function relativeSpecifiers(sourceFile) {
  return sourceFile.statements.flatMap((statement) => {
    if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) return []
    const specifier = statement.moduleSpecifier
    return specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.') ? [{ statement, specifier: specifier.text }] : []
  })
}

const ChinesePattern = /[\u4e00-\u9fff]/u
const NodeBuiltinModules = new Set(builtinModules)

/** 是不是 Node 内置模块（`node:fs`、`fs`、`fs/promises` 这类）。 */
const isNodeBuiltin = (specifier) => specifier.startsWith('node:') || NodeBuiltinModules.has(specifier.split('/')[0])

/** 节点正上方紧挨着的 JSDoc 块（以 `/**` 开头的块注释）原文；没有返回空串。 */
function jsDocText(node, sourceFile) {
  const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? []
  const last = ranges.at(-1)
  if (!last || last.kind !== ts.SyntaxKind.MultiLineCommentTrivia) return ''
  const text = sourceFile.text.slice(last.pos, last.end)
  return text.startsWith('/**') ? text : ''
}

/** 这条 import / export … from 是否只搬类型（编译后不存在）。 */
function isTypeOnlyStatement(statement) {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause
    if (!clause) return false
    if (clause.isTypeOnly) return true
    return !clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings)
      && clause.namedBindings.elements.every((element) => element.isTypeOnly)
  }
  if (statement.isTypeOnly) return true
  return !!statement.exportClause && ts.isNamedExports(statement.exportClause)
    && statement.exportClause.elements.every((element) => element.isTypeOnly)
}

/** 函数体里有没有用到 this 或 super。 */
function usesInstance(node) {
  if (!node) return false
  let found = false
  const visit = (child) => {
    if (found) return
    if (child.kind === ts.SyntaxKind.ThisKeyword || child.kind === ts.SyntaxKind.SuperKeyword) {
      found = true
      return
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

/** 初始值是不是一个函数字面量（箭头函数或 function 表达式）。 */
const isFunctionLiteral = (node) => !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))

/** 节点下面所有表示函数或方法的类型节点（契约里不许出现）。 */
function behaviorNodes(node) {
  const found = []
  const visit = (child) => {
    if (ts.isMethodSignature(child) || ts.isCallSignatureDeclaration(child) || ts.isConstructSignatureDeclaration(child)
      || ts.isFunctionTypeNode(child) || ts.isConstructorTypeNode(child) || ts.isGetAccessorDeclaration(child) || ts.isSetAccessorDeclaration(child)) {
      found.push(child)
      return
    }
    ts.forEachChild(child, visit)
  }
  ts.forEachChild(node, visit)
  return found
}

/** 接口（或类型字面量）的成员，连同属性类型里嵌套的类型字面量成员，一并列出。 */
function membersDeep(members) {
  const result = []
  for (const member of members) {
    result.push(member)
    if (ts.isPropertySignature(member) && member.type && ts.isTypeLiteralNode(member.type)) result.push(...membersDeep(member.type.members))
  }
  return result
}

// 命令行：--only <包目录> 只查这一个包；--list 把迁移中的包的每一条问题都列出来（默认只报条数）。
const cliArgs = process.argv.slice(2)
const onlyIndex = cliArgs.indexOf('--only')
const onlyDirectory = onlyIndex >= 0 ? cliArgs[onlyIndex + 1] : null
const listMigrating = cliArgs.includes('--list') || !!onlyDirectory
const selectedModules = onlyDirectory ? GovernedModules.filter((module) => module.directory === onlyDirectory) : GovernedModules
if (onlyDirectory && selectedModules.length === 0) {
  console.error(`--only ${onlyDirectory}：登记表里没有这个包目录`)
  process.exit(2)
}
const migratingReports = []

for (const module of selectedModules) {
  if (module.layout === 'interface') { checkInterfaceModule(RepoRoot, module, fail); continue }
  const failuresBefore = failures.length
  const packageRoot = join(PackagesRoot, module.directory)
  const label = module.name
  if (!existsSync(packageRoot)) {
    fail(`${label}: 登记的包目录 packages/${module.directory} 不存在`)
    continue
  }
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  // 能力单元登记的名字是「包名/单元」，引用时就这么写（@velaros-ai/velaros/files）。
  const packageName = module.unit ? module.name.slice(0, -(module.unit.length + 1)) : module.name
  if (manifest.name !== packageName) fail(`${label}: 包名与登记表不符（${manifest.name}）`)

  // 能力单元（一个包里按目录放的几个模块，例如 @velaros-ai/velaros 的 files、shell）：源码根就是单元目录，
  // 入口是 ./<单元> 与 ./<单元>/…，spec/ 与 test/ 跟着单元走、不算源码。普通模块的源码根是 src/。
  const unit = module.unit ?? null
  const unitSubpath = unit && !module.packageEntry ? `./${unit}` : null
  const srcRoot = unit ? join(packageRoot, unit) : join(packageRoot, 'src')
  const toolsFilePath = module.toolsFile ? join(packageRoot, module.toolsFile) : null
  // 端口可达性从「模型面的入口」出发。工具时代那个入口是工具文件，代码面时代是操作表。
  // 模型面入口可以是几个文件（一个单元出两件能力、各有自己的操作类时）；没登记就是工具文件。
  const surfaceFilePaths = module.surfaceFile ? [module.surfaceFile].flat().map((file) => join(packageRoot, file)) : [toolsFilePath].filter(Boolean)
  const contractRoot = join(packageRoot, module.contract)
  const typesRoot = join(packageRoot, module.types)
  const implRoot = join(packageRoot, module.impl)
  const utilsRoot = join(packageRoot, module.utils)
  // 对外入口就是 src 根上的那几个 .ts；嵌套子路径（./protocol/message）的入口住在同名的入口目录里。
  const subpathName = (subpath) => {
    if (unitSubpath) return subpath === unitSubpath ? 'index' : subpath.slice(unitSubpath.length + 1)
    return subpath === '.' ? 'index' : subpath.replace(/^\.\//u, '')
  }
  const subpathOfName = (name) => (name === 'index' ? (unitSubpath ?? '.') : `${unitSubpath ?? '.'}/${name}`)
  const manifestSubpaths = Object.keys(manifest.exports ?? {})
    .filter((subpath) => module.packageEntry ? manifest.exports[subpath]?.import?.startsWith(`./dist/${unit}/`) : (!unit || subpath === unitSubpath || subpath.startsWith(`${unitSubpath}/`)))
  const entryDirectories = new Set(
    manifestSubpaths.map(subpathName).filter((name) => name.includes('/')).map((name) => name.split('/')[0]),
  )
  const entryNameOf = (file) => relative(srcRoot, file).replace(/\.ts$/u, '')
  const isEntryFile = (file) => file !== typesRoot && file !== utilsRoot && (dirname(file) === srcRoot || entryDirectories.has(relative(srcRoot, file).split('/')[0]))
  const providesPath = join(contractRoot, 'provides.ts')
  const requiresPath = join(contractRoot, 'requires.ts')
  const constantsPath = join(contractRoot, 'constants.ts')
  // 没有自己的可移植数据的包（比如只做装配的空间）不登记 portable：`./contracts` 只转发常量表。
  const portablePath = module.portable ? join(typesRoot, module.portable) : null
  const publicInterfacePaths = [providesPath, requiresPath].filter((path) => existsSync(path))
  const inside = (file, root) => file === root || file.startsWith(`${root}/`)
  // 同一包内的已治理单元共用纯工具和数据，仍按目标的登记层验证。
  const inPeerLayer = (file, layer) => GovernedModules.some(peer => peer.directory === module.directory && peer.unit && peer.unit !== module.unit && peer[layer] && inside(file, join(packageRoot, peer[layer])))
  const isPublicInterfaceFile = (file) => publicInterfacePaths.includes(file)
  const shortPath = (file) => relative(packageRoot, file)
  // 分包：types、impl、utils 可以按域开子目录，每个子目录至少直接放 MinFilesPerSubdirectory 个源文件。
  const checkSubdirectories = (root, what) => {
    for (const directory of nestedDirectories(root)) {
      const count = directSourceCount(join(root, directory))
      if (count < MinFilesPerSubdirectory) {
        fail(`${label}: ${relative(packageRoot, root)}/${directory}/ 只直接放了 ${count} 个源文件；${what}分包是为了把很多文件按域分开，每个子目录至少 ${MinFilesPerSubdirectory} 个文件，一两个文件的不要单开目录，也不要只套一层空目录`)
      }
    }
  }
  // 单元目录下不算源码的目录：验收与测试跟着单元走；登记的资产目录（helper 脚本这类）随包发布、不受源码规则约束。
  const UnitCompanions = ['spec', 'test', ...(module.assets ?? [])]
  for (const asset of module.assets ?? []) {
    if (!unit) fail(`${label}: 只有能力单元登记 assets；普通模块的资产放包根，不在 src 里`)
    else if (!existsSync(join(srcRoot, asset))) fail(`${label}: 登记的资产目录 ${unit}/${asset}/ 不存在`)
    else if (!(manifest.files ?? []).includes(`${unit}/${asset}`)) fail(`${label}: 资产目录 ${unit}/${asset}/ 没写进 package.json 的 files；装出来的包里没有它`)
  }
  const sourceFiles = walkSources(srcRoot).filter((file) => !unit || !UnitCompanions.includes(relative(srcRoot, file).split('/')[0]))

  const program = ts.createProgram(sourceFiles, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  })
  const checker = program.getTypeChecker()
  /** 标识符或类型名最终指向的声明（穿过 import 别名）；指到本包之外或解析不到时返回 null。 */
  const declarationOf = (node) => {
    const symbol = checker.getSymbolAtLocation(node)
    if (!symbol) return null
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    const declaration = target.declarations?.[0]
    if (!declaration) return null
    const file = declaration.getSourceFile().fileName
    return inside(file, srcRoot) ? { declaration, file, symbol: target } : null
  }
  /** 声明所在的顶层语句。 */
  const topLevelOf = (declaration) => {
    let node = declaration
    while (node.parent && !ts.isSourceFile(node.parent)) node = node.parent
    return node
  }

  // ── 1. 工具文件 ─────────────────────────────────────────────────────────
  const toolNames = []
  const toolsSourceFile = toolsFilePath ? program.getSourceFile(toolsFilePath) : undefined
  if (toolsFilePath && !toolsSourceFile) {
    fail(`${label}: 缺少工具文件 ${module.toolsFile}`)
  } else if (toolsSourceFile) {
    const visitTools = (node) => {
      if (ts.isCallExpression(node) && node.expression.getText(toolsSourceFile) === module.toolDefiner) {
        const [spec] = node.arguments
        const nameProperty = spec && ts.isObjectLiteralExpression(spec)
          ? spec.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(toolsSourceFile) === 'name')
          : undefined
        const nameType = nameProperty ? checker.getTypeAtLocation(nameProperty.initializer) : undefined
        if (nameType?.isStringLiteral()) toolNames.push(nameType.value)
        else fail(`${label}: ${module.toolsFile} 里有一个工具的 name 不是常量字面量，门禁认不出它叫什么`)
        const executeProperty = spec && ts.isObjectLiteralExpression(spec)
          ? spec.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(toolsSourceFile) === 'execute')
          : undefined
        const statements = executeProperty ? countStatements(executeProperty.initializer) : 0
        const toolName = nameType?.isStringLiteral() ? nameType.value : '(未知)'
        for (const property of spec && ts.isObjectLiteralExpression(spec) ? spec.properties : []) {
          if (ts.isPropertyAssignment(property) && property.name.getText(toolsSourceFile) === 'examples') continue
          const visitNumbers = (child) => {
            if (ts.isNumericLiteral(child)) {
              const value = numericValue(child)
              if (!isTrivialNumber(value) && !UnitFactors.has(value)) {
                fail(`${label}: ${module.toolsFile} 里工具 ${toolName} 的定义写了数字 ${child.getText(toolsSourceFile)}；上限放进 ${module.contract}/constants.ts 的常量表再引用（示例除外）`)
              }
            } else if ((ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child) || ts.isTemplateHead(child) || ts.isTemplateMiddle(child) || ts.isTemplateTail(child)) && /\d{2,}/u.test(child.text)) {
              fail(`${label}: ${module.toolsFile} 里工具 ${toolName} 的说明写了数字「${child.text.match(/\d{2,}/u)[0]}」；说明里的上限用模板字符串引常量表，改一处模型看到的跟着变`)
            }
            ts.forEachChild(child, visitNumbers)
          }
          visitNumbers(property)
        }
        if (statements > ExecuteStatementLimit) {
          fail(`${label}: ${module.toolsFile} 里工具 ${nameType?.isStringLiteral() ? nameType.value : '(未知)'} 的 execute 有 ${statements} 条语句；工具文件只放定义，execute 只写简单的一两步（最多 ${ExecuteStatementLimit} 条），实现多的放进 ${module.impl}/ 的类，这里一行交给它`)
        }
      }
      ts.forEachChild(node, visitTools)
    }
    visitTools(toolsSourceFile)
    if (toolNames.length === 0) fail(`${label}: 工具文件 ${module.toolsFile} 里一个工具定义都没有`)
  }
  if (module.toolDefiner) {
    const definerCall = new RegExp(`\\b${module.toolDefiner}\\s*[<(]`, 'u')
    const definerDeclaration = new RegExp(`\\bfunction\\s+${module.toolDefiner}\\b`, 'u')
    for (const file of sourceFiles) {
      if (file === toolsFilePath) continue
      const source = readFileSync(file, 'utf8')
      if (definerCall.test(source) && !definerDeclaration.test(source)) {
        fail(`${label}: ${shortPath(file)} 调用了 ${module.toolDefiner}；工具定义只许写在工具文件 ${module.toolsFile} 里`)
      }
    }
  }

  // ── 2. types：只放类型 ──────────────────────────────────────────────
  checkSubdirectories(typesRoot, '类型')
  for (const path of [portablePath, constantsPath].filter(Boolean)) {
    if (!existsSync(path)) {
      fail(`${label}: 缺少可移植文件 ${shortPath(path)}`)
      continue
    }
    const source = readFileSync(path, 'utf8')
    for (const line of source.split('\n')) {
      if (!/^\s*import\s/u.test(line)) continue
      if (path === portablePath && /^import type \{[^}]*\} from '\.\.\/contract\/constants\.js'$/u.test(line.trim())) continue
      fail(`${label}: 可移植文件 ${shortPath(path)} 不许 import（可移植类型文件只许从常量表 import type）：${line.trim().slice(0, 60)}`)
    }
    if (/\bNodeJS\.|\bBuffer\b|\bChildProcess\b/u.test(source)) fail(`${label}: 可移植文件 ${shortPath(path)} 用了 Node 专属类型`)
  }
  for (const file of sourceFiles.filter((path) => inside(path, typesRoot))) {
    const sourceFile = parse(file)
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        if (!isTypeOnlyStatement(statement)) fail(`${label}: 类型文件 ${shortPath(file)} 用了值 import；类型文件只许 import type`)
      } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isVariableStatement(statement) || ts.isEnumDeclaration(statement)) {
        fail(`${label}: 类型文件 ${shortPath(file)} 里有值（${statement.getText(sourceFile).split('\n')[0].slice(0, 60)}）；types 里一个值都不许有，常量表放 ${module.contract}/constants.ts，实现放 ${module.impl}/`)
      } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        if (!isExported(statement)) fail(`${label}: 类型文件 ${shortPath(file)} 的 ${statement.name.text} 没有导出；类型文件里的声明都给别处用`)
        if (file !== portablePath) continue
        for (const node of behaviorNodes(statement)) {
          fail(`${label}: 可移植数据文件 ${shortPath(file)} 的 ${statement.name.text} 里有函数或方法（${node.getText(sourceFile).split('\n')[0].slice(0, 60)}）；可移植数据不带行为，带回调的选项放进别的 types 文件，带行为的接口放进 ${module.contract}/`)
          break
        }
      }
    }
    for (const { specifier } of relativeSpecifiers(sourceFile)) {
      const target = resolveRelativeImport(file, specifier)
      if (target && !inside(target, typesRoot) && !inside(target, contractRoot) && !inPeerLayer(target, 'types') && !inPeerLayer(target, 'contract')) fail(`${label}: 类型文件 ${shortPath(file)} 引用了 ${shortPath(target)}；types 只引 types 与合同`)
    }
  }

  // ── 3. contract：对外合同，三个文件 ─────────────────────────────────────
  for (const directory of childDirectories(contractRoot)) fail(`${label}: ${module.contract}/${directory}/ 是子目录；合同目录保持扁平`)
  // surface.ts 是第四份合同：代码面能力的模型面（生成物，随包发布），只许生成器写。
  const contractFileNames = new Set(['provides.ts', 'requires.ts', 'constants.ts', 'surface.ts'])
  for (const file of walkAll(contractRoot)) {
    if (!contractFileNames.has(basename(file))) fail(`${label}: ${shortPath(file)} 不是合同文件；${module.contract}/ 只有 provides.ts、requires.ts、constants.ts，代码面能力另有生成的 surface.ts`)
    else if (basename(file) === 'surface.ts' && !readFileSync(file, 'utf8').startsWith(GeneratedSurfaceHeader)) {
      fail(`${label}: ${shortPath(file)} 不是生成器写的；模型面的声明只由 \`bun run generate:script\` 生成，不手写`)
    }
  }
  if (!existsSync(providesPath)) fail(`${label}: 缺少产品面文件 ${shortPath(providesPath)}`)
  const providesRegistered = new Map() // 类上方接口的声明 → 登记它的名字
  const contractImports = [] // 合同文件从 contract、types 以外的地方 import 的语句，登记表建完再核对
  for (const file of publicInterfacePaths) {
    const sourceFile = parse(file)
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        if (!isTypeOnlyStatement(statement)) fail(`${label}: 合同文件 ${shortPath(file)} 用了值 import；合同文件只许 import type`)
        continue
      }
      if (ts.isExportDeclaration(statement)) {
        const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? resolveRelativeImport(file, statement.moduleSpecifier.text) : null
        if (!statement.isTypeOnly || !target || !inside(target, implRoot) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
          fail(`${label}: 合同文件 ${shortPath(file)} 里的转发只许是 export type { … } from '../impl/<类文件>.js'，登记类上方的接口`)
          continue
        }
        for (const element of statement.exportClause.elements) providesRegistered.set(`${target}::${(element.propertyName ?? element.name).text}`, element.name.text)
        continue
      }
      if (!(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))) {
        fail(`${label}: 合同文件 ${shortPath(file)} 里有类型声明以外的东西（${statement.getText(sourceFile).split('\n')[0].slice(0, 60)}）；值放常量表，实现放 ${module.impl}/`)
        continue
      }
      if (!isExported(statement)) fail(`${label}: 合同文件 ${shortPath(file)} 的 ${statement.name.text} 没有导出；合同里的声明都给别处用`)
      if (!ChinesePattern.test(jsDocText(statement, sourceFile))) fail(`${label}: 合同文件 ${shortPath(file)} 的 ${statement.name.text} 缺中文说明；每个接口都要写清楚它负责什么`)
      const members = ts.isInterfaceDeclaration(statement)
        ? statement.members
        : statement.type && ts.isTypeLiteralNode(statement.type) ? statement.type.members : []
      for (const member of membersDeep(members)) {
        if (!ChinesePattern.test(jsDocText(member, sourceFile))) {
          fail(`${label}: 合同文件 ${shortPath(file)} 的 ${statement.name.text}.${member.name?.getText(sourceFile) ?? '(签名)'} 缺中文说明；接口的每个成员都要写清楚做什么`)
        }
      }
    }
    for (const { statement, specifier } of relativeSpecifiers(sourceFile)) {
      const target = resolveRelativeImport(file, specifier)
      if (!target) continue
      if (ts.isExportDeclaration(statement)) continue
      if (inside(target, contractRoot) || inside(target, typesRoot)) continue
      contractImports.push({ file, statement, target })
    }
  }
  // 合同里的接口可以用 provides.ts 登记过的类上方接口（比如项目空间带着内核）：只许 import type 登记过的那几个名字。
  for (const { file, statement, target } of contractImports) {
    const names = ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
      ? statement.importClause.namedBindings.elements.map((element) => (element.propertyName ?? element.name).text)
      : []
    const registered = names.length > 0 && !statement.importClause?.name && names.every((name) => providesRegistered.has(`${target}::${name}`))
    if (!registered) fail(`${label}: 合同文件 ${shortPath(file)} 引用了 ${shortPath(target)}；合同只引合同、types 与 provides.ts 登记过的类上方接口`)
  }
  if (existsSync(constantsPath)) {
    const sourceFile = parse(constantsPath)
    for (const statement of sourceFile.statements) {
      if (ts.isVariableStatement(statement)) {
        if (!(statement.declarationList.flags & ts.NodeFlags.Const)) fail(`${label}: 常量表 ${shortPath(constantsPath)} 里有可变变量`)
        if (!isExported(statement)) fail(`${label}: 常量表 ${shortPath(constantsPath)} 里的 ${statement.declarationList.declarations[0]?.name.getText(sourceFile)} 没有导出`)
        if (!ChinesePattern.test(jsDocText(statement, sourceFile))) fail(`${label}: 常量表 ${shortPath(constantsPath)} 里的 ${statement.declarationList.declarations[0]?.name.getText(sourceFile)} 缺中文说明`)
        for (const declaration of statement.declarationList.declarations) {
          const initializer = declaration.initializer?.getText(sourceFile) ?? ''
          if (!/^Object\.freeze\(/u.test(initializer) && !/^'[^']*' as const$/u.test(initializer)) {
            fail(`${label}: 常量表里的 ${declaration.name.getText(sourceFile)} 不是 Object.freeze 的表或 as const 的字符串身份；别的值不进合同`)
          }
          const walkLimits = (objectLiteral, prefix) => {
            for (const property of objectLiteral.properties) {
              if (!ts.isPropertyAssignment(property)) continue
              const path = `${prefix}.${property.name.getText(sourceFile)}`
              const nested = frozenObjectLiteral(property.initializer) ?? (ts.isObjectLiteralExpression(property.initializer) ? property.initializer : null)
              if (nested) walkLimits(nested, path)
              else if (numericValue(property.initializer) !== null && !ChinesePattern.test(jsDocText(property, sourceFile))) {
                fail(`${label}: 常量表里的上限 ${path} 缺中文说明；每个数字写清楚它限的是什么`)
              }
            }
          }
          const table = frozenObjectLiteral(declaration.initializer)
          if (table) walkLimits(table, declaration.name.getText(sourceFile))
        }
      } else if (ts.isTypeAliasDeclaration(statement)) {
        if (!/\btypeof\b/u.test(statement.type.getText(sourceFile))) fail(`${label}: 常量表文件里的类型 ${statement.name.text} 不是由常量表派生（typeof）；数据类型放进 ${module.types}/`)
      } else {
        fail(`${label}: 常量表 ${shortPath(constantsPath)} 里有常量与派生别名以外的东西（${statement.getText(sourceFile).split('\n')[0].slice(0, 60)}）`)
      }
    }
  }

  // ── 4. impl：一类一文件、类配接口、分层；文件多可以按域分子目录 ───────────────
  checkSubdirectories(implRoot, '实现')
  const implFiles = sourceFiles.filter((path) => inside(path, implRoot))
  for (const file of implFiles) {
    const sourceFile = parse(file)
    const classes = sourceFile.statements.filter((statement) => ts.isClassDeclaration(statement))
    if (file === toolsFilePath) {
      if (classes.length > 0) fail(`${label}: 工具文件 ${shortPath(file)} 里有类；工具文件只放工具定义与挂载，类各自一个文件`)
    } else {
      const expected = basename(file, '.ts')
      if (classes.length !== 1) fail(`${label}: ${shortPath(file)} 里有 ${classes.length} 个类；一个类一个文件，文件名就是类名`)
      else if (classes[0].name?.text !== expected) fail(`${label}: ${shortPath(file)} 里的类叫 ${classes[0].name?.text ?? '(匿名)'}；文件名要和类名一样`)
    }
    const tailExported = new Set(sourceFile.statements.flatMap((statement) =>
      ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.map((element) => element.name.text)
        : []))
    // 类的接口和类放在同一个文件里：实现文件只许声明并导出本文件的类实现的接口，以及以类名或接口主名开头的配套接口（构造参数、回调、收尾策略），
    // 每个都要有中文说明。其余类型一律不许写在这里：都放进 types/。
    const ownClass = classes[0]
    const ownNames = new Set(ownClass?.name ? [ownClass.name.text] : [])
    for (const clause of ownClass?.heritageClauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue
      for (const type of clause.types) {
        const name = type.expression.getText(sourceFile)
        ownNames.add(name)
        ownNames.add(name.replace(/Api$/u, ''))
      }
    }
    for (const statement of sourceFile.statements) {
      if (!(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))) continue
      if (/\btypeof\b/u.test(statement.getText(sourceFile))) continue
      const name = statement.name.text
      if (!ts.isInterfaceDeclaration(statement) || ![...ownNames].some((own) => name === own || name.startsWith(own))) {
        fail(`${label}: 实现文件 ${shortPath(file)} 里声明了类型 ${name}；类型放进 ${module.types}/，类自己的接口要以类名开头并写在类上方`)
        continue
      }
      if (!isExported(statement) && !tailExported.has(name)) fail(`${label}: 实现文件 ${shortPath(file)} 的接口 ${name} 没有导出；类的接口写在类上方，给别处用`)
      if (!ChinesePattern.test(jsDocText(statement, sourceFile))) fail(`${label}: 实现文件 ${shortPath(file)} 的接口 ${name} 缺中文说明；每个接口都要写清楚它负责什么`)
      for (const member of membersDeep(statement.members)) {
        if (!ChinesePattern.test(jsDocText(member, sourceFile))) {
          fail(`${label}: 实现文件 ${shortPath(file)} 的 ${name}.${member.name?.getText(sourceFile) ?? '(签名)'} 缺中文说明；接口的每个成员都要写清楚做什么`)
        }
      }
    }
  }
  // 分层登记：写文件相对 impl 的路径（扁平包就是文件名），或以 / 结尾的子目录（整个子目录都在这一层）。
  const layerOf = (file) => {
    if (!inside(file, implRoot)) return null
    const relativePath = relative(implRoot, file)
    const index = module.layers.findIndex((layer) => layer.some((entry) => entry.endsWith('/') ? relativePath.startsWith(entry) : relativePath === entry))
    return index < 0 ? null : index
  }
  for (const file of implFiles) {
    if (layerOf(file) === null) fail(`${label}: ${shortPath(file)} 没登记在分层里；在 governed-modules.mjs 的 layers 里给它选一层`)
  }
  for (const name of module.layers.flat()) {
    if (!existsSync(join(implRoot, name))) fail(`${label}: 分层里登记的 ${module.impl}/${name} 不存在`)
  }
  for (const file of implFiles) {
    const from = layerOf(file)
    if (from === null) continue
    for (const { specifier } of relativeSpecifiers(parse(file))) {
      const target = resolveRelativeImport(file, specifier)
      const to = target ? layerOf(target) : null
      if (to !== null && to < from) {
        fail(`${label}: ${shortPath(file)} 引用了上层的 ${shortPath(target)}；实现分层是 ${module.layers.map((layer) => layer.join(' / ')).join(' → ')}，下层不许引上层`)
      }
    }
  }
  const publicFactories = new Set()
  for (const file of sourceFiles.filter(isEntryFile)) {
    for (const { statement, specifier } of relativeSpecifiers(parse(file))) {
      const target = resolveRelativeImport(file, specifier)
      if (!target || !inside(target, implRoot) || !ts.isExportDeclaration(statement) || !statement.exportClause) continue
      if (!ts.isNamedExports(statement.exportClause)) continue
      for (const element of statement.exportClause.elements) publicFactories.add(`${target}::${(element.propertyName ?? element.name).text}`)
    }
  }
  let classCount = 0
  let errorClassCount = 0
  for (const file of implFiles) {
    const sourceFile = program.getSourceFile(file)
    if (!sourceFile) continue
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
        if (!publicFactories.has(`${file}::${statement.name.text}`)) {
          fail(`${label}: ${shortPath(file)} 有模块级函数 ${statement.name.text}；实现里的逻辑放进类，用不到实例状态的放进 ${module.utils}/，模块级函数只许是对外入口要的工厂`)
        }
        continue
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (file !== toolsFilePath && !isFunctionLiteral(declaration.initializer)) {
            const isLogger = /^Log\.tag\(/u.test(declaration.initializer?.getText(sourceFile) ?? '')
            const isSharedInstance = isExported(statement) && !!declaration.type
            if (!isLogger && !isSharedInstance) {
              fail(`${label}: ${shortPath(file)} 有模块级常量 ${declaration.name.getText(sourceFile)}；实现文件的模块级只放日志和导出的实例：类里固定用的写成 private static readonly，可调的放进 ${module.tuning ? `${module.utils}/${module.tuning}` : `${module.utils}/ 的可调参数文件（在 governed-modules.mjs 登记 tuning）`}，对外约定放进 ${module.contract}/constants.ts`)
            }
          }
          if (!isFunctionLiteral(declaration.initializer) || !ts.isIdentifier(declaration.name)) continue
          if (!publicFactories.has(`${file}::${declaration.name.text}`)) {
            fail(`${label}: ${shortPath(file)} 有模块级函数 ${declaration.name.text}；实现里的逻辑放进类，用不到实例状态的放进 ${module.utils}/，模块级函数只许是对外入口要的工厂`)
          }
        }
        continue
      }
      if (!ts.isClassDeclaration(statement)) continue
      const className = statement.name?.text ?? '(匿名类)'
      const heritage = statement.heritageClauses ?? []
      const extendsClause = heritage.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
      if (extendsClause?.types.some((type) => /Error$/u.test(type.expression.getText(sourceFile)))) {
        errorClassCount += 1
        continue
      }
      classCount += 1
      const implementsClause = heritage.find((clause) => clause.token === ts.SyntaxKind.ImplementsKeyword)
      if (!implementsClause) {
        fail(`${label}: ${shortPath(file)} 的类 ${className} 没有 implements 接口；每个类有一个接口，定义在类上方（注入面的在 ${module.contract}/requires.ts），写清它的每个方法`)
        continue
      }
      const interfaceMembers = new Set()
      for (const typeNode of implementsClause.types) {
        const type = checker.getTypeAtLocation(typeNode)
        const declarations = type.getSymbol()?.declarations ?? []
        const declaredHere = (declaration) => {
          const declaredIn = declaration.getSourceFile().fileName
          return declaredIn === file
        }
        if (!declarations.some((declaration) => declaredHere(declaration) || inside(declaration.getSourceFile().fileName, contractRoot))) {
          fail(`${label}: ${shortPath(file)} 的类 ${className} 实现的 ${typeNode.getText(sourceFile)} 既不在本文件的类上方，也不在 ${module.contract}/ 里`)
          continue
        }
        for (const property of checker.getPropertiesOfType(type)) interfaceMembers.add(property.name)
      }
      const constructorDeclaration = statement.members.find((member) => ts.isConstructorDeclaration(member))
      for (const parameter of constructorDeclaration?.parameters ?? []) {
        const flags = ts.getCombinedModifierFlags(parameter)
        if (!(flags & (ts.ModifierFlags.Public | ts.ModifierFlags.Readonly)) || flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue
        if (!interfaceMembers.has(parameter.name.getText(sourceFile))) {
          fail(`${label}: ${shortPath(file)} 的 ${className}.${parameter.name.getText(sourceFile)} 是公开成员，但不在它实现的接口里；要么写进接口并写清说明，要么改成私有`)
        }
      }
      for (const member of statement.members) {
        if (ts.isConstructorDeclaration(member) || ts.isClassStaticBlockDeclaration(member) || ts.isSemicolonClassElement(member)) continue
        if (!member.name) continue
        const memberName = member.name.getText(sourceFile)
        const flags = ts.getCombinedModifierFlags(member)
        const isPrivate = (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0 || ts.isPrivateIdentifier(member.name)
        if (ts.isPropertyDeclaration(member) && member.initializer && ts.isIdentifier(member.initializer)) {
          const symbol = checker.getSymbolAtLocation(member.initializer)
          const aliased = symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : null
          if (aliased && (aliased.flags & ts.SymbolFlags.Function)) {
            fail(`${label}: ${shortPath(file)} 的 ${className}.${memberName} 直接挂着导入的函数 ${member.initializer.text}；这是留给测试替换的钩子，注入只走 ${module.contract}/requires.ts，要测就直接测那个函数`)
          }
        }
        if (isPrivate) {
          const body = ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)
            ? member.body
            : ts.isPropertyDeclaration(member) && isFunctionLiteral(member.initializer) ? member.initializer.body : null
          if (body && !usesInstance(body)) {
            fail(`${label}: ${shortPath(file)} 的 ${className}.${memberName} 是私有方法却没用到实例状态；这种函数放进 ${module.utils}/，写一句中文说明`)
          }
          continue
        }
        if (flags & ts.ModifierFlags.Static) {
          fail(`${label}: ${shortPath(file)} 的 ${className}.${memberName} 是公开静态成员；类对外只经它的接口，工厂写成对外入口里的模块级函数`)
          continue
        }
        if (!interfaceMembers.has(memberName)) {
          fail(`${label}: ${shortPath(file)} 的 ${className}.${memberName} 是公开成员，但不在它实现的接口里；要么写进接口并写清说明，要么改成私有`)
        }
      }
    }
  }

  // ── 5. utils ───────────────────────────────────────────────────────────
  checkSubdirectories(utilsRoot, '工具函数')
  for (const file of sourceFiles.filter((path) => inside(path, utilsRoot))) {
    const sourceFile = parse(file)
    const documentedFunctions = new Set()
    const functionNames = new Set()
    for (const statement of sourceFile.statements) {
      if (ts.isClassDeclaration(statement)) {
        // 只有字段和构造函数的错误类可以放 utils：工具函数要抛它，而 utils 不许引 impl。
        const extendsError = (statement.heritageClauses ?? []).some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.some((type) => /Error$/u.test(type.expression.getText(sourceFile))))
        const fieldsOnly = statement.members.every((member) => ts.isPropertyDeclaration(member) || ts.isConstructorDeclaration(member))
        if (extendsError && fieldsOnly && ChinesePattern.test(jsDocText(statement, sourceFile))) continue
        fail(`${label}: ${shortPath(file)} 里有类 ${statement.name?.text ?? ''}；utils 只放函数和常量（只有字段、写了中文说明的错误类除外），类放进 ${module.impl}/ 并在类上方写接口`)
      } else if (ts.isEnumDeclaration(statement)) {
        fail(`${label}: ${shortPath(file)} 里有枚举 ${statement.name.text}；常量表放进 ${module.contract}/constants.ts`)
      } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        fail(`${label}: ${shortPath(file)} 里声明了类型 ${statement.name.text}；类型放进 ${module.types}/，utils 只放函数和常量`)
      } else if (ts.isFunctionDeclaration(statement) && statement.name) {
        functionNames.add(statement.name.text)
        if (ChinesePattern.test(jsDocText(statement, sourceFile))) documentedFunctions.add(statement.name.text)
      } else if (ts.isVariableStatement(statement)) {
        if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
          fail(`${label}: ${shortPath(file)} 有模块级 let/var；utils 不存状态，要状态就做成 ${module.impl}/ 里的类`)
        }
        for (const declaration of statement.declarationList.declarations) {
          if (!isFunctionLiteral(declaration.initializer) || !ts.isIdentifier(declaration.name)) continue
          functionNames.add(declaration.name.text)
          if (ChinesePattern.test(jsDocText(statement, sourceFile))) documentedFunctions.add(declaration.name.text)
        }
      }
    }
    for (const name of functionNames) {
      if (!documentedFunctions.has(name)) fail(`${label}: ${shortPath(file)} 的函数 ${name} 上方缺一句中文说明（/** 做什么 */）`)
    }
    for (const { statement, specifier } of relativeSpecifiers(sourceFile)) {
      const target = resolveRelativeImport(file, specifier)
      if (!target) continue
      if ((inside(target, typesRoot) || inPeerLayer(target, 'types') || ((inside(target, contractRoot) || inPeerLayer(target, 'contract')) && basename(target) !== 'constants.ts')) && !isTypeOnlyStatement(statement)) fail(`${label}: ${shortPath(file)} 从 ${shortPath(target)} 做了值 import；类型与接口只能 import type，值只能来自常量表`)
      if (!inside(target, utilsRoot) && !inside(target, contractRoot) && !inside(target, typesRoot) && !inPeerLayer(target, 'utils') && !inPeerLayer(target, 'types') && !inPeerLayer(target, 'contract')) {
        fail(`${label}: ${shortPath(file)} 引用了 ${shortPath(target)}；utils 只引 utils、types 与合同，要用类就在参数里收接口`)
      }
    }
  }

  // ── 5b. 数字缺省值只在可调参数文件里 ─────────────────────────────────
  const tuningPath = module.tuning ? (extname(utilsRoot) === '.ts' ? utilsRoot : join(utilsRoot, module.tuning)) : null
  const tuningHint = tuningPath ? shortPath(tuningPath) : `${module.utils}/ 的可调参数文件（在 governed-modules.mjs 登记 tuning）`
  for (const file of sourceFiles.filter((path) => (inside(path, implRoot) || inside(path, utilsRoot)) && path !== toolsFilePath && path !== tuningPath)) {
    const sourceFile = parse(file)
    const report = (node, what) => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      fail(`${label}: ${shortPath(file)}:${line + 1} ${what}；可调的数字放进 ${tuningHint}，对外约定的放进 ${module.contract}/constants.ts，这里引用它`)
    }
    if (inside(file, utilsRoot)) {
      for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue
        for (const declaration of statement.declarationList.declarations) {
          if (numericValue(declaration.initializer) !== null) report(declaration, `有模块级数字常量 ${declaration.name.getText(sourceFile)}`)
        }
      }
    }
    const visitDefaults = (node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
        const value = numericValue(node.right)
        if (value !== null && !isTrivialNumber(value)) report(node, `用 ?? ${node.right.getText(sourceFile)} 写数字缺省值`)
      } else if (ts.isParameter(node) && node.initializer) {
        const value = numericValue(node.initializer)
        if (value !== null && !isTrivialNumber(value)) report(node, `参数 ${node.name.getText(sourceFile)} 的缺省值写成数字 ${node.initializer.getText(sourceFile)}`)
      } else if (ts.isPropertyAssignment(node) && KnobPropertyPattern.test(node.name.getText(sourceFile))) {
        const value = numericValue(node.initializer)
        if (value !== null && !isTrivialNumber(value)) report(node, `属性 ${node.name.getText(sourceFile)} 写成数字 ${node.initializer.getText(sourceFile)}`)
      }
      ts.forEachChild(node, visitDefaults)
    }
    visitDefaults(sourceFile)
  }
  if (tuningPath && !existsSync(tuningPath)) {
    fail(`${label}: 登记的可调参数文件 ${shortPath(tuningPath)} 不存在`)
  } else if (tuningPath) {
    const sourceFile = parse(tuningPath)
    const tableNames = []
    const leaves = []
    const walkTuning = (objectLiteral, prefix) => {
      for (const property of objectLiteral.properties) {
        if (!ts.isPropertyAssignment(property)) {
          fail(`${label}: 可调参数文件里 ${prefix} 下有属性赋值以外的写法`)
          continue
        }
        const path = `${prefix}.${property.name.getText(sourceFile)}`
        if (!ChinesePattern.test(jsDocText(property, sourceFile))) fail(`${label}: 可调参数 ${path} 缺中文说明；每一项写清楚它管什么、单位是什么`)
        const nested = frozenObjectLiteral(property.initializer)
        if (nested) walkTuning(nested, path)
        else if (numericValue(property.initializer) === null) fail(`${label}: 可调参数 ${path} 不是数字；可调参数文件只放数字，名单跟着规则写在各自的 utils 文件里`)
        else leaves.push(path)
      }
    }
    for (const statement of sourceFile.statements) {
      const isExportedConst = ts.isVariableStatement(statement) && isExported(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
      if (!isExportedConst) {
        fail(`${label}: 可调参数文件 ${shortPath(tuningPath)} 里有导出的冻结表以外的东西（${statement.getText(sourceFile).split('\n')[0].slice(0, 60)}）；它不 import、不放函数，只放表`)
        continue
      }
      if (!ChinesePattern.test(jsDocText(statement, sourceFile))) fail(`${label}: 可调参数文件里的 ${statement.declarationList.declarations[0]?.name.getText(sourceFile)} 缺中文说明`)
      for (const declaration of statement.declarationList.declarations) {
        const table = frozenObjectLiteral(declaration.initializer)
        if (!table) {
          fail(`${label}: 可调参数文件里的 ${declaration.name.getText(sourceFile)} 不是 Object.freeze 的表`)
          continue
        }
        tableNames.push(declaration.name.getText(sourceFile))
        walkTuning(table, declaration.name.getText(sourceFile))
      }
    }
    // 每一项都得有人用：引用链（如 SystemTuning.systemInfo.levels.cpu）盖住它下面的全部项。
    const referenced = new Set()
    for (const file of sourceFiles.filter((path) => path !== tuningPath)) {
      const visitReferences = (node) => {
        const isOutermost = !(node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)
        if (ts.isPropertyAccessExpression(node) && isOutermost) {
          const chain = node.getText().replace(/\s+/gu, '').replace(/\?\./gu, '.')
          if (tableNames.some((name) => chain.startsWith(`${name}.`))) referenced.add(chain)
        }
        ts.forEachChild(node, visitReferences)
      }
      visitReferences(parse(file))
    }
    for (const leaf of leaves) {
      if (![...referenced].some((chain) => leaf === chain || leaf.startsWith(`${chain}.`))) fail(`${label}: 可调参数 ${leaf} 没有人用；不用的删掉`)
    }
  }

  // ── 5c. 模型和用户看得到的文字用中文 ─────────────────────────────────
  // 报错（new XxxError / super 的文字）与 message、suggestedNextAction、note 字段的文字不许是纯英文句子；命令、路径、错误码、字段名可以夹在中文里。
  const EnglishSentence = /[A-Za-z]{2,}[\s,;:'()-]+[A-Za-z]{2,}[\s,;:'()-]+[A-Za-z]{2,}/u
  const textsOf = (node) => {
    if (!node) return []
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
    if (ts.isTemplateExpression(node)) return [[node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ')]
    if (ts.isConditionalExpression(node)) return [...textsOf(node.whenTrue), ...textsOf(node.whenFalse)]
    if (ts.isParenthesizedExpression(node)) return textsOf(node.expression)
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) return textsOf(node.right)
    return []
  }
  for (const file of sourceFiles.filter((path) => inside(path, implRoot) || inside(path, utilsRoot))) {
    const sourceFile = parse(file)
    const check = (node) => {
      for (const text of textsOf(node)) {
        if (ChinesePattern.test(text) || !EnglishSentence.test(text)) continue
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        fail(`${label}: ${shortPath(file)}:${line + 1} 模型或用户看得到的文字是英文（「${text.replace(/\s+/gu, ' ').slice(0, 60)}」）；报错、失败说明、提示统一用中文，命令、路径、错误码、字段名保持原样`)
      }
    }
    const visitTexts = (node) => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && /Error$/u.test(node.expression.text)) {
        for (const argument of node.arguments ?? []) check(argument)
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
        for (const argument of node.arguments) check(argument)
      } else if (ts.isPropertyAssignment(node) && /^(message|suggestedNextAction|note)$/u.test(node.name.getText(sourceFile))) {
        check(node.initializer)
      }
      ts.forEachChild(node, visitTexts)
    }
    visitTexts(sourceFile)
  }

  // ── 6. 对外入口由接口控制 ───────────────────────────────────────────────
  const exportFiles = sourceFiles.filter(isEntryFile)
  const entryFileOfSubpath = (subpath) => join(srcRoot, `${subpathName(subpath)}.ts`)
  const subpaths = manifestSubpaths
  for (const subpath of subpaths) {
    const target = manifest.exports[subpath]
    const name = subpathName(subpath)
    const built = unit ? `./dist/${unit}/${name}` : `./dist/${name}`
    const expected = { types: `${built}.d.ts`, import: `${built}.js` }
    for (const key of ['types', 'import']) {
      if (target?.[key] !== expected[key]) fail(`${label}: package.json exports["${subpath}"].${key} 应当是 ${expected[key]}，现在是 ${target?.[key] ?? '(缺)'}`)
    }
    if (!existsSync(entryFileOfSubpath(subpath))) fail(`${label}: package.json 登记了入口 ${subpath}，但没有 ${shortPath(entryFileOfSubpath(subpath))}`)
  }
  for (const file of exportFiles) {
    const name = entryNameOf(file)
    const subpath = subpathOfName(name)
    if (!subpaths.includes(subpath)) {
      fail(`${label}: ${shortPath(file)} 在 package.json 的 exports 里没有对应的 ${subpath}；src 根上只放对外入口，实现放进 ${module.contract}、${module.types}、${module.impl} 或 ${module.utils}`)
    }
  }
  const rootEntryPath = entryFileOfSubpath(unitSubpath ?? '.')
  const exported = new Map() // 声明 → { name, isValue, entries }
  for (const file of exportFiles) {
    const sourceFile = program.getSourceFile(file)
    if (!sourceFile) continue
    for (const statement of sourceFile.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) {
        fail(`${label}: 入口 ${shortPath(file)} 里有转发以外的语句（${statement.getText(sourceFile).split('\n')[0].slice(0, 60)}）；入口只转发，不写声明`)
        continue
      }
      const target = resolveRelativeImport(file, statement.moduleSpecifier.text)
      if (!statement.exportClause && target && !isEntryFile(target) && target !== portablePath && target !== constantsPath) {
        fail(`${label}: 入口 ${shortPath(file)} 通配转发了 ${statement.moduleSpecifier.text}；通配只许指向别的入口或可移植数据文件，其余逐个列名`)
      }
    }
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
    for (const symbol of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
      const declaration = target.declarations?.[0]
      if (!declaration) continue
      const record = exported.get(declaration) ?? { name: symbol.name, isValue: (target.flags & ts.SymbolFlags.Value) !== 0, entries: new Set() }
      record.entries.add(file)
      exported.set(declaration, record)
    }
  }
  const allowedTypeSource = (file, declaration, name) => isPublicInterfaceFile(file) || file === constantsPath || inside(file, typesRoot) || (inside(file, implRoot) && providesRegistered.get(`${file}::${name}`) !== undefined)
  const rootReferences = [] // 公开面的根：公开接口声明 + 导出值的类型标注
  for (const [declaration, record] of exported) {
    const file = declaration.getSourceFile().fileName
    if (!inside(file, srcRoot)) continue
    if (!record.isValue) {
      if (!allowedTypeSource(file, declaration, record.name)) {
        fail(`${label}: 对外导出了类型 ${record.name}，它声明在 ${shortPath(file)}；导出的类型只能来自 ${module.contract}/ 的 provides、requires、constants，${module.types}/，或 provides.ts 登记的类上方接口`)
      }
      continue
    }
    if (ts.isClassDeclaration(declaration)) {
      fail(`${label}: 对外导出了类 ${record.name}；类不出包，导出按公开接口标注类型的实例或工厂`)
      continue
    }
    if (inside(file, contractRoot)) {
      const statement = topLevelOf(declaration)
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) {
        fail(`${label}: 对外导出了合同里的 ${record.name}；合同里只有常量表能作为值导出`)
      }
      continue
    }
    if (!inside(file, implRoot)) {
      fail(`${label}: 对外导出了 ${record.name}，它声明在 ${shortPath(file)}；对外的值只能是 impl 里按公开接口标注的实例、工厂或合同里的常量表，utils 的函数不出包`)
      continue
    }
    const annotations = []
    if (ts.isVariableDeclaration(declaration)) {
      if (declaration.type) annotations.push(declaration.type)
      else fail(`${label}: 对外导出的 ${record.name} 没有显式标注类型；导出的值必须标注成公开接口`)
    } else if (ts.isFunctionDeclaration(declaration)) {
      if (!declaration.type) fail(`${label}: 对外导出的工厂 ${record.name} 没有标注返回类型；返回类型必须是公开接口`)
      else annotations.push(declaration.type)
      for (const parameter of declaration.parameters) {
        if (parameter.type) annotations.push(parameter.type)
        else fail(`${label}: 对外导出的工厂 ${record.name} 的参数 ${parameter.name.getText()} 没有标注类型`)
      }
    } else {
      fail(`${label}: 对外导出的 ${record.name} 既不是实例也不是工厂，门禁认不出它的类型`)
    }
    rootReferences.push(...annotations.map((node) => ({ node, owner: record.name })))
  }
  const publicDeclarations = []
  const registeredStatements = new Set()
  for (const file of publicInterfacePaths) {
    const sourceFile = program.getSourceFile(file)
    for (const statement of sourceFile?.statements ?? []) {
      if (!(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))) continue
      publicDeclarations.push(statement)
      const record = exported.get(statement)
      if (!record || !record.entries.has(rootEntryPath)) {
        fail(`${label}: ${shortPath(file)} 的 ${statement.name.text} 没有从根入口导出；产品面和注入面的每个接口都要出包`)
      }
      rootReferences.push({ node: statement, owner: statement.name.text })
    }
  }
  // provides.ts 登记的类上方接口也是公开面的根
  for (const [key, exportedName] of providesRegistered) {
    const [file, name] = key.split('::')
    const sourceFile = program.getSourceFile(file)
    const statement = (sourceFile?.statements ?? []).find((candidate) => ts.isInterfaceDeclaration(candidate) && candidate.name.text === name)
    if (!statement) {
      fail(`${label}: provides.ts 登记的 ${exportedName} 在 ${shortPath(file)} 里没有对应的接口声明`)
      continue
    }
    publicDeclarations.push(statement)
    registeredStatements.add(statement)
    const record = exported.get(statement)
    if (!record || !record.entries.has(rootEntryPath)) fail(`${label}: provides.ts 登记的 ${exportedName} 没有从根入口导出`)
    rootReferences.push({ node: statement, owner: exportedName })
  }
  // 从公开面的根出发，求它们引用到的契约数据的闭包；顺带拦住公开接口引用内部接口
  const closure = new Set()
  const visitedDeclarations = new Set()
  const queue = [...rootReferences]
  while (queue.length > 0) {
    const { node, owner } = queue.shift()
    const visit = (child) => {
      const nameNode = ts.isTypeReferenceNode(child) ? child.typeName
        : ts.isExpressionWithTypeArguments(child) ? child.expression
          : ts.isTypeQueryNode(child) ? child.exprName : null
      if (nameNode) {
        const resolved = declarationOf(ts.isQualifiedName(nameNode) ? nameNode.left : nameNode)
        if (resolved && !ts.isTypeParameterDeclaration(resolved.declaration)) {
          const top = topLevelOf(resolved.declaration)
          if (inside(resolved.file, implRoot) && registeredStatements.has(top)) {
            if (!visitedDeclarations.has(top)) {
              visitedDeclarations.add(top)
              queue.push({ node: top, owner })
            }
          } else if (inside(resolved.file, implRoot) || inside(resolved.file, utilsRoot)) {
            fail(`${label}: 公开面的 ${owner} 引用了 ${shortPath(resolved.file)} 里的 ${resolved.symbol.name}；公开签名只能用合同、登记过的类上方接口与公开数据`)
          } else if (inside(resolved.file, typesRoot) || inside(resolved.file, contractRoot)) {
            if (inside(resolved.file, typesRoot) || resolved.file === constantsPath) closure.add(top)
            if (!visitedDeclarations.has(top)) {
              visitedDeclarations.add(top)
              queue.push({ node: top, owner })
            }
          }
        }
      }
      ts.forEachChild(child, visit)
    }
    visit(node)
  }
  const exportedDeclarations = new Set(exported.keys())
  const exportedStatements = new Set([...exportedDeclarations].map((declaration) => topLevelOf(declaration)))
  for (const statement of closure) {
    if (!exportedStatements.has(statement)) {
      const name = ts.isVariableStatement(statement) ? statement.declarationList.declarations[0].name.getText() : statement.name?.text
      fail(`${label}: 公开接口用到了 ${shortPath(statement.getSourceFile().fileName)} 的 ${name}，但它没有从入口导出；外面要能叫出公开签名里的每个类型`)
    }
  }
  for (const [declaration, record] of exported) {
    const file = declaration.getSourceFile().fileName
    if (!inside(file, typesRoot) || file === portablePath || record.isValue) continue
    if (!closure.has(topLevelOf(declaration))) {
      fail(`${label}: 对外导出了 ${shortPath(file)} 的 ${record.name}，但没有任何公开接口用到它；不是公开签名需要的数据不出包`)
    }
  }
  const portableSourceFile = portablePath ? program.getSourceFile(portablePath) : undefined
  for (const statement of portableSourceFile?.statements ?? []) {
    if (!(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isVariableStatement(statement))) continue
    if (ts.isVariableStatement(statement)) continue
    if (closure.has(statement)) continue
    if (ts.isTypeAliasDeclaration(statement) && /\btypeof\b/u.test(statement.type.getText(portableSourceFile))) continue
    fail(`${label}: 可移植数据文件里的 ${statement.name.text} 没有任何公开接口用到；可移植文件里不放包内外都没人用的数据`)
  }

  // ── 7. 会被渲染进程加载的入口 ─────────────────────────────────────────
  for (const entry of module.browserSafeEntries ?? []) {
    const entryFile = join(srcRoot, entry)
    if (!existsSync(entryFile)) {
      fail(`${label}: 登记为渲染进程可加载的入口 src/${entry} 不存在`)
      continue
    }
    const pending = [[entryFile, [entryFile]]]
    const visited = new Set()
    while (pending.length > 0) {
      const [file, chain] = pending.shift()
      if (visited.has(file)) continue
      visited.add(file)
      for (const statement of parse(file).statements) {
        if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) continue
        const specifierNode = statement.moduleSpecifier
        if (!specifierNode || !ts.isStringLiteral(specifierNode) || isTypeOnlyStatement(statement)) continue
        const specifier = specifierNode.text
        if (specifier.startsWith('.')) {
          const target = resolveRelativeImport(file, specifier)
          if (target) pending.push([target, [...chain, target]])
        } else if (isNodeBuiltin(specifier)) {
          fail(`${label}: 入口 ${entry} 会被渲染进程加载，但引用链 ${chain.map(shortPath).join(' → ')} 用到了 Node 内置模块 ${specifier}；渲染进程要用的代码不能碰 Node 模块，拆到只给 Node 用的文件里`)
        }
      }
    }
  }

  // ── 8. 环境变量都登记 ───────────────────────────────────────────────────
  const registeredVariables = new Set()
  const constantsSourceFile = program.getSourceFile(constantsPath)
  const visitTable = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(constantsSourceFile) === module.environmentTable) {
      const collect = (child) => {
        if (ts.isPropertyAssignment(child) && child.name.getText(constantsSourceFile) === 'name' && ts.isStringLiteral(child.initializer)) registeredVariables.add(child.initializer.text)
        ts.forEachChild(child, collect)
      }
      collect(node)
    }
    ts.forEachChild(node, visitTable)
  }
  if (constantsSourceFile) visitTable(constantsSourceFile)
  if (module.environmentTable && registeredVariables.size === 0) fail(`${label}: 常量表里没有环境变量表 ${module.environmentTable}`)
  // 本仓自己的变量一律 VELAROS_ 前缀；读别人定义的名字时把那个前缀登记在 environmentPrefixes 里，一起扫、一起要求登记
  const environmentPrefixes = [DefaultEnvironmentPrefix, ...(module.environmentPrefixes ?? [])]
  const environmentNamePattern = new RegExp(`(?:${[...environmentPrefixes].sort((a, b) => b.length - a.length).join('|')})[A-Z0-9_]*`, 'gu')
  for (const name of registeredVariables) {
    if (!environmentPrefixes.some((prefix) => name.startsWith(prefix))) {
      fail(`${label}: ${module.environmentTable} 登记的 ${name} 不是 ${environmentPrefixes.join(' 或 ')} 前缀；本仓自己的变量用 ${DefaultEnvironmentPrefix}，读别人定义的名字先把前缀登记进 environmentPrefixes`)
    }
  }
  const usedVariables = new Set()
  for (const file of sourceFiles) {
    if (file === constantsPath) continue
    const sourceFile = parse(file)
    const visitStrings = (node) => {
      // 字符串里写的变量名，和 env.VELAROS_X 这样按属性读的变量名，都算用到
      const isText = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
      if (isText || ts.isIdentifier(node)) {
        for (const token of node.text.match(environmentNamePattern) ?? []) {
          const matches = [...registeredVariables].filter((name) => name === token || (token.endsWith('_') && name.startsWith(token)))
          if (matches.length === 0) fail(`${label}: ${shortPath(file)} 用到了环境变量 ${token}，但${module.environmentTable ? `它不在 ${module.environmentTable} 里` : '本包没有登记环境变量表'}；环境变量也是注入，先登记再用`)
          for (const name of matches) if (name === token) usedVariables.add(name)
        }
      }
      ts.forEachChild(node, visitStrings)
    }
    visitStrings(sourceFile)
  }
  for (const name of registeredVariables) {
    if (!usedVariables.has(name)) fail(`${label}: ${module.environmentTable} 登记了 ${name}，但代码里没有用到；不用的登记删掉`)
  }
  const calledPortMembers = new Set()
  const surfaceSourceFiles = surfaceFilePaths.filter((file) => program.getSourceFile(file))
  if (surfaceSourceFiles.length > 0) {
    const portField = module.hostPortField
    if (module.hostPort && !portField) fail(`${label}: 登记了 hostPort ${module.hostPort}，就要写 hostPortField（操作经 ctx.<字段> 调端口的那个字段名）`)
    const visitCalls = (node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === portField) {
        calledPortMembers.add(node.name.text)
      }
      ts.forEachChild(node, visitCalls)
    }
    // 入口文件自己调的，加上从它出发、沿相对 import 能走到的 impl 与 utils 文件里调的（入口一行交给类、类再交给工具函数时，端口调用在更深处）。
    const reachable = new Set(surfaceSourceFiles)
    const queue = [...surfaceSourceFiles]
    while (queue.length > 0) {
      const file = queue.pop()
      for (const { specifier } of relativeSpecifiers(parse(file))) {
        const target = resolveRelativeImport(file, specifier)
        if (!target || reachable.has(target) || !(inside(target, implRoot) || inside(target, utilsRoot))) continue
        reachable.add(target)
        queue.push(target)
      }
    }
    for (const file of reachable) visitCalls(parse(file))
  }
  const hostPortDeclaration = module.hostPort ? publicDeclarations.find((statement) => statement.name.text === module.hostPort) : null
  if (module.hostPort && !hostPortDeclaration) {
    fail(`${label}: 登记的宿主端口 ${module.hostPort} 不在公开接口文件里`)
  } else if (hostPortDeclaration) {
    for (const member of hostPortDeclaration.members ?? []) {
      const memberName = member.name?.getText(hostPortDeclaration.getSourceFile())
      if (memberName && !calledPortMembers.has(memberName)) {
        fail(`${label}: 宿主端口 ${module.hostPort}.${memberName} 从模型面入口走不到；注入面只留操作真会用的方法，宿主界面要的能力放到本地内核的接口上`)
      }
    }
  }

  // ── 9. src 下的目录，以及依赖只许写在文件头 ────────────────────────────
  const lazyImports = module.lazyImports ?? []
  const usedLazyImports = new Set()
  for (const file of sourceFiles) {
    const sourceFile = parse(file)
    const visitImports = (node) => {
      if (ts.isImportTypeNode(node)) {
        fail(`${label}: ${shortPath(file)} 用了内联的 import('…') 类型；依赖统一写在文件头的 import type 里，依赖方向和导出规则才查得到`)
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        // 懒加载只放行登记过的目标：登记表的 lazyImports 里写明「谁、加载什么、为什么」，
        // 没登记的动态 import 照旧拦下——否则依赖方向就查不到了。
        const specifier = node.arguments?.[0]
        const target = specifier && ts.isStringLiteralLike(specifier) ? specifier.text : ''
        const registered = lazyImports.find((entry) => entry.specifier === target)
        if (!registered) {
          fail(`${label}: ${shortPath(file)} 用了动态 import()；依赖统一写成文件头的静态 import，依赖方向才查得到（确需懒加载的目标登记进 lazyImports）`)
        } else {
          usedLazyImports.add(registered.specifier)
          if (registered.file !== shortPath(file)) {
            fail(`${label}: ${shortPath(file)} 动态 import 了 ${target}，但登记表把它登记在 ${registered.file}；一个懒加载目标只许一处加载`)
          }
        }
      }
      ts.forEachChild(node, visitImports)
    }
    visitImports(sourceFile)
  }
  for (const entry of lazyImports) {
    if (!usedLazyImports.has(entry.specifier)) {
      fail(`${label}: 登记的懒加载目标 ${entry.specifier} 没有人加载；不用的删掉`)
    }
  }
  const governedDirectories = [module.contract, module.types, module.impl, module.utils].filter((path) => extname(path) !== '.ts' && existsSync(join(packageRoot, path))).map((path) => basename(path))
  for (const directory of childDirectories(srcRoot)) {
    if (governedDirectories.includes(directory) || entryDirectories.has(directory) || (unit && UnitCompanions.includes(directory))) continue
    fail(`${label}: src/${directory}/ 不是登记的目录；src 下只有 ${governedDirectories.join('、')} 四个目录，外加嵌套子路径入口自己的目录（package.json 的 exports 里有 ./${directory}/… 才算）`)
  }

  // ── 9b. 可执行入口放包根 bin/，只当壳 ───────────────────────────────────
  const binaryTargets = Object.entries(manifest.bin ?? {})
  for (const [command, target] of binaryTargets) {
    const expected = `./${BinaryDirectory}/${command}${BinaryExtension}`
    if (target !== expected) {
      fail(`${label}: package.json bin["${command}"] 是 ${target}，可执行入口放包根 ${BinaryDirectory}/、写成 ${expected}；src 下不留有副作用的文件`)
      continue
    }
    const binaryPath = join(packageRoot, BinaryDirectory, `${command}${BinaryExtension}`)
    if (!existsSync(binaryPath)) {
      fail(`${label}: package.json 登记了命令 ${command}，但没有 ${shortPath(binaryPath)}`)
    } else if (!readFileSync(binaryPath, 'utf8').startsWith(BinaryShebang)) {
      fail(`${label}: ${shortPath(binaryPath)} 第一行不是 ${BinaryShebang}；装出来的命令要能直接执行`)
    }
  }
  if (binaryTargets.length > 0 && !(manifest.files ?? []).includes(BinaryDirectory)) {
    fail(`${label}: package.json 的 files 里没有 ${BinaryDirectory}；可执行入口不打进包里，装上也跑不起来`)
  }

  // ── 10. 模块卡片 ───────────────────────────────────────────────────────
  const cardPath = join(packageRoot, module.card)
  let sections = new Map()
  if (!existsSync(cardPath)) {
    fail(`${label}: 缺少模块卡片 ${module.card}`)
  } else {
    sections = sectionsOf(readFileSync(cardPath, 'utf8'))
    for (const title of RequiredCardSections) {
      if (!sections.has(title)) fail(`${label}: 卡片缺少「## ${title}」一节`)
    }
    const provides = sections.get('提供什么') ?? ''
    for (const subpath of subpaths) {
      if (!provides.includes(`\`${subpath}\``)) fail(`${label}: 卡片「提供什么」没有列出入口 \`${subpath}\``)
    }
    for (const record of exported.values()) {
      if (record.isValue && !provides.includes(`\`${record.name}\``)) fail(`${label}: 卡片「提供什么」没有列出导出的 \`${record.name}\``)
    }
    for (const statement of publicDeclarations) {
      if (!provides.includes(`\`${statement.name.text}\``)) fail(`${label}: 卡片「提供什么」没有列出公开接口 \`${statement.name.text}\``)
    }
    const chains = sections.get('骨干链路') ?? ''
    if (module.toolsFile && !chains.includes(basename(module.toolsFile))) fail(`${label}: 卡片「骨干链路」没有点到工具文件 ${basename(module.toolsFile)}`)
    for (const toolName of toolNames) {
      if (!chains.includes(`\`${toolName}\``)) fail(`${label}: 卡片「骨干链路」没有写工具 ${toolName} 的链路`)
    }
    const structure = sections.get('结构') ?? ''
    if (module.toolsFile && !structure.includes(basename(module.toolsFile))) fail(`${label}: 卡片「结构」没有写明工具文件 ${basename(module.toolsFile)}`)
    for (const directory of governedDirectories) {
      if (!new RegExp(`^\\s+${directory}/\\s`, 'mu').test(structure)) fail(`${label}: 卡片「结构」的目录树里没有列出 ${directory}/`)
    }
  }

  // ── 11. 不变量登记表与验收测试 ─────────────────────────────────────────
  const invariantsPath = join(packageRoot, module.invariants)
  const acceptancePath = join(packageRoot, module.acceptance)
  // 登记表里的检验器路径相对它自己的根写：普通模块是包根，能力单元是单元目录（单元是自成一体的目录，登记表就在里面）。
  const verifierRoot = unit ? srcRoot : packageRoot
  if (!existsSync(acceptancePath)) fail(`${label}: 缺少验收测试 ${module.acceptance}`)
  const counts = Object.fromEntries(InvariantCheckKinds.map((kind) => [kind, 0]))
  const seenIds = new Set()
  if (!existsSync(invariantsPath)) {
    fail(`${label}: 缺少不变量登记表 ${module.invariants}`)
  } else {
    const rows = readFileSync(invariantsPath, 'utf8').split('\n').filter((line) => /^\|\s*INV-\d+\s*\|/u.test(line))
    if (rows.length === 0) fail(`${label}: 不变量登记表里一条 INV- 行都没有`)
    for (const row of rows) {
      const [id, description, kind, checkerReference] = row.split('|').slice(1, -1).map((cell) => cell.trim())
      if (seenIds.has(id)) fail(`${label}: 不变量编号重复 ${id}`)
      seenIds.add(id)
      if (!description) fail(`${label}: ${id} 没有描述`)
      if (!InvariantCheckKinds.includes(kind)) {
        fail(`${label}: ${id} 的检验方式「${kind}」不在 ${InvariantCheckKinds.join(' / ')} 之内`)
        continue
      }
      counts[kind] += 1
      const reference = (checkerReference ?? '').replace(/`/gu, '').trim()
      if (kind === '测试') {
        const references = reference.split('、')
        const testSources = references.map((file) => {
          const target = resolve(verifierRoot, file)
          if (!inside(target, verifierRoot) || !existsSync(target) || !(manifest.scripts?.test ?? '').includes(relative(packageRoot, target))) {
            fail(`${label}: ${id} 的测试 ${file} 必须存在于模块内并由 package.json test 执行`)
            return ''
          }
          return readFileSync(target, 'utf8')
        }).join('\n')
        if (!new RegExp(`\\(\\s*['"\`]${id}\\s`, 'u').test(testSources)) {
          fail(`${label}: ${id} 标为测试档，但 ${reference} 里没有以「${id} 」开头的用例`)
        }
      } else if (kind === '类型') {
        const [file, typeName] = reference.split('::')
        const filePath = join(verifierRoot, file ?? '')
        if (!file || !typeName || !existsSync(filePath)) {
          fail(`${label}: ${id} 的类型检验器要写成 ${unit ? '' : 'src/'}<文件路径>.ts::<类型名>，现在是「${reference}」`)
        } else if (!new RegExp(`\\bexport\\s+(?:interface|type)\\s+${typeName}\\b`, 'u').test(readFileSync(filePath, 'utf8'))) {
          fail(`${label}: ${id} 引用的类型 ${typeName} 不在 ${file} 里`)
        }
      } else if (kind === '门禁') {
        if (!reference.startsWith('check:') || !RootManifest.scripts?.[reference]) {
          fail(`${label}: ${id} 引用的门 ${reference || '(空)'} 不是根 package.json 里的 check 脚本`)
        }
      } else if (kind === '运行时') {
        if (!reference || !existsSync(join(verifierRoot, reference))) fail(`${label}: ${id} 的运行时检验器 ${reference || '(空)'} 文件不存在`)
      } else if (kind === '文字' && reference) {
        fail(`${label}: ${id} 是文字档，检验器应留空`)
      }
    }
    const invariantSection = sections.get('不变量') ?? ''
    if (sections.size > 0 && !invariantSection.includes(`共 ${seenIds.size} 条`)) {
      fail(`${label}: 卡片「不变量」要写「共 ${seenIds.size} 条」`)
    }
    if (sections.size > 0 && !invariantSection.includes(`未验证 ${counts['文字']} 条`)) {
      fail(`${label}: 卡片「不变量」要如实写「未验证 ${counts['文字']} 条」`)
    }
  }
  if (!(manifest.scripts?.test ?? '').includes(module.acceptance)) fail(`${label}: package.json 的 test 脚本没有跑 ${module.acceptance}`)

  if (module.status === 'migrating') {
    // 迁移中的包：问题照查照报，但不计入失败，改造期间也能登记、看燃尽。
    migratingReports.push({ label, problems: failures.splice(failuresBefore) })
    continue
  }
  if (failures.length === failuresBefore) {
    const kinds = InvariantCheckKinds.filter((kind) => counts[kind] > 0).map((kind) => `${kind} ${counts[kind]}`).join('、')
    const exportedValues = [...exported.values()].filter((record) => record.isValue).length
    console.info(`✓ ${label}: ${module.toolsFile ? `${basename(module.toolsFile)} 里 ${toolNames.length} 个工具` : '没有工具'}；实现 ${implFiles.length} 个文件，${classCount} 个类都有接口（另有 ${errorClassCount} 个错误类）；公开接口 ${publicDeclarations.length} 个，对外的值 ${exportedValues} 个，公开签名用到的数据 ${closure.size} 个；${subpaths.length} 个入口；环境变量 ${registeredVariables.size} 个；不变量 ${seenIds.size} 条（${kinds}）`)
  }
}

for (const { label, problems } of migratingReports) {
  console.info(`… ${label}: 迁移中，还有 ${problems.length} 条问题（不计入失败${listMigrating ? '' : '；--list 或 --only 列出每一条'}）`)
  if (listMigrating) for (const problem of problems) console.info(`  - ${problem}`)
}

if (failures.length > 0) {
  console.error(`Module ownership check failed (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.info('✓ module ownership: single tool file, data-only contracts, documented interfaces, one-class-per-file impl, documented utils, interface-controlled exports, registered environment variables, browser-safe entries, cards, and invariant registries')
