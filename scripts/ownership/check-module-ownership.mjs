#!/usr/bin/env bun
// 模块结构门：核对每个已治理模块的文件分工与对外边界有没有塌。登记在 governed-modules.mjs。
//
// 这里不拦编辑，只核对：
//   1. 工具文件：全部工具定义都在登记的那一个文件里，定义工具的函数只在那里被调用（没有工具的包不登记 toolsFile / toolDefiner / hostPort）。
//   2. contract：扁平；只放数据（接口字段、类型、常量表），不许出现函数类型、方法签名、类和函数；只用 type import，只引契约。
//      可移植数据文件不 import 任何东西、不用 Node 专属类型。
//   3. interface：只有登记的几个文件；只放类型声明，只用 type import，只引 interface 与 contract；
//      每个接口、类型别名和它们的每个成员都有中文说明。provides 是产品面、requires 是注入面、internal 是不属于某个类的内部接口。
//   4. impl：扁平，一个类一个文件、文件名即类名（工具文件不放类）；只许声明并导出本文件的类实现的接口和以类名开头的配套接口，
//      都要有中文说明，其余类型不许写在这里（带 typeof 的除外）；每个类 implements 一个接口：公开的在 interface 里、内部的写在类上方（继承 Error 的错误类除外），公开成员都在接口里，没有公开静态成员，
//      私有方法必须用到实例状态；模块级函数只许是对外入口要的工厂。按 layers 分层，下层不许引上层。
//   5. utils：扁平；只放函数和常量，不放类、不声明类型、没有模块级 let；每个函数上方一句中文说明；只引 utils、contract 与 interface。
//   6. 对外入口由接口控制：入口文件只有转发语句；导出的类型只能来自 provides、requires 与 contract；
//      导出的值要么是 contract 的常量表，要么是 impl 里显式标注了公开接口类型的实例或工厂，不许导出类、utils 函数和内部接口；
//      provides 与 requires 里的每个声明都从根入口导出；公开接口引用到的数据类型都导出，导出的数据类型都被公开接口用到；
//      可移植数据文件里没有公开接口用不到的类型；公开接口不许引用内部接口。package.json 的 exports 与入口文件一一对应。
//   7. 会被渲染进程加载的入口，整条值引用链里不许出现 Node 内置模块。
//   8. 环境变量：代码里出现的每个 VELAROS_* 名字都登记在可移植数据文件的环境变量表里，登记了的都有人用。
//      宿主端口：登记的端口接口里的每个方法，工具文件里都有工具在调；没人调的方法不许留在注入面。
//   9. src 下只有登记的五个目录，src 根上不放源文件；依赖只许写在文件头，不许用内联 import 类型和动态 import。
//  10. 模块卡片十节齐全；「提供什么」列出全部入口、导出的每个值和每个公开接口；「骨干链路」点到每个工具；「结构」写明目录树。
//  11. 不变量登记表每行编号唯一、检验方式合法、检验器真的存在；卡片里的条数如实。包的 test 脚本跑验收测试。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

import ts from 'typescript'

import {
  GovernedModules,
  InvariantCheckKinds,
  RequiredCardSections,
} from './governed-modules.mjs'

const RepoRoot = resolve(import.meta.dir, '../..')
const PackagesRoot = join(RepoRoot, 'packages')
const RootManifest = JSON.parse(readFileSync(join(RepoRoot, 'package.json'), 'utf8'))
const failures = []
const fail = (message) => failures.push(message)

/** 递归列出目录下的全部文件，不管扩展名。 */
function walkAll(directory) {
  if (!existsSync(directory)) return []
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
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter((entry) => statSync(join(directory, entry)).isDirectory())
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

for (const module of GovernedModules) {
  const packageRoot = join(PackagesRoot, module.directory)
  const label = module.name
  if (!existsSync(packageRoot)) {
    fail(`${label}: 登记的包目录 packages/${module.directory} 不存在`)
    continue
  }
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.name !== module.name) fail(`${label}: 包名与登记表不符（${manifest.name}）`)

  const srcRoot = join(packageRoot, 'src')
  const toolsFilePath = module.toolsFile ? join(packageRoot, module.toolsFile) : null
  const contractRoot = join(packageRoot, module.contract)
  const interfaceRoot = join(packageRoot, module.interface)
  const implRoot = join(packageRoot, module.impl)
  const exportsRoot = join(packageRoot, module.exports)
  const utilsRoot = join(packageRoot, module.utils)
  const portablePath = join(contractRoot, module.portable)
  const publicInterfacePaths = module.publicInterfaces.map((name) => join(interfaceRoot, name))
  const internalInterfacePaths = module.internalInterfaces.map((name) => join(interfaceRoot, name))
  const inside = (file, root) => file.startsWith(`${root}/`)
  const isPublicInterfaceFile = (file) => publicInterfacePaths.includes(file)
  const isInternalInterfaceFile = (file) => internalInterfacePaths.includes(file)
  const shortPath = (file) => relative(packageRoot, file)
  const sourceFiles = walkSources(srcRoot)

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

  // ── 2. contract：只放数据 ───────────────────────────────────────────────
  for (const directory of childDirectories(contractRoot)) {
    fail(`${label}: ${module.contract}/${directory}/ 是子目录；契约是扁平文件，不分子目录`)
  }
  const contractFiles = sourceFiles.filter((path) => inside(path, contractRoot))
  if (existsSync(portablePath)) {
    const portableSource = readFileSync(portablePath, 'utf8')
    if (/^\s*import\s/mu.test(portableSource)) fail(`${label}: 可移植数据文件 ${shortPath(portablePath)} 不许 import 任何东西`)
    if (/\bNodeJS\.|\bBuffer\b|\bChildProcess\b/u.test(portableSource)) fail(`${label}: 可移植数据文件 ${shortPath(portablePath)} 用了 Node 专属类型`)
  } else {
    fail(`${label}: 缺少可移植数据文件 ${module.contract}/${module.portable}`)
  }
  for (const file of contractFiles) {
    const sourceFile = parse(file)
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        if (!isTypeOnlyStatement(statement)) fail(`${label}: 契约文件 ${shortPath(file)} 用了值 import；契约只放数据，只许 import type`)
      } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
        fail(`${label}: 契约文件 ${shortPath(file)} 里有函数或类 ${statement.name?.text ?? ''}；契约只放数据，实现放进 ${module.impl}/`)
      } else if (ts.isVariableStatement(statement) && !(statement.declarationList.flags & ts.NodeFlags.Const)) {
        fail(`${label}: 契约文件 ${shortPath(file)} 里有可变变量；契约里只许常量表`)
      } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        for (const node of behaviorNodes(statement)) {
          fail(`${label}: 契约文件 ${shortPath(file)} 的 ${statement.name.text} 里有函数或方法（${node.getText(sourceFile).split('\n')[0].slice(0, 60)}）；契约只放数据，带行为的接口放进 ${module.interface}/`)
          break
        }
      }
    }
    for (const { specifier } of relativeSpecifiers(sourceFile)) {
      const target = resolveRelativeImport(file, specifier)
      if (target && !inside(target, contractRoot)) fail(`${label}: 契约文件 ${shortPath(file)} 引用了契约之外的 ${shortPath(target)}；契约只引契约`)
    }
  }

  // ── 3. interface：只放带说明的类型声明 ──────────────────────────────────
  for (const directory of childDirectories(interfaceRoot)) fail(`${label}: ${module.interface}/${directory}/ 是子目录；接口目录保持扁平`)
  const registeredInterfaceFiles = new Set([...publicInterfacePaths, ...internalInterfacePaths])
  for (const file of walkAll(interfaceRoot)) {
    if (!registeredInterfaceFiles.has(file)) fail(`${label}: ${shortPath(file)} 不是登记的接口文件；接口只放进 ${[...module.publicInterfaces, ...module.internalInterfaces].join('、')}`)
  }
  for (const file of registeredInterfaceFiles) if (!existsSync(file)) fail(`${label}: 缺少登记的接口文件 ${shortPath(file)}`)
  for (const file of sourceFiles.filter((path) => inside(path, interfaceRoot))) {
    const sourceFile = parse(file)
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        if (!isTypeOnlyStatement(statement)) fail(`${label}: 接口文件 ${shortPath(file)} 用了值 import；接口文件只许 import type`)
        continue
      }
      if (!(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))) {
        fail(`${label}: 接口文件 ${shortPath(file)} 里有类型声明以外的东西（${statement.getText(sourceFile).split('\n')[0].slice(0, 60)}）；值和实现放进 ${module.impl}/`)
        continue
      }
      if (!isExported(statement)) fail(`${label}: 接口文件 ${shortPath(file)} 的 ${statement.name.text} 没有导出；接口文件里的声明都给别处用`)
      if (!ChinesePattern.test(jsDocText(statement, sourceFile))) fail(`${label}: 接口文件 ${shortPath(file)} 的 ${statement.name.text} 缺中文说明；每个接口都要写清楚它负责什么`)
      const members = ts.isInterfaceDeclaration(statement)
        ? statement.members
        : statement.type && ts.isTypeLiteralNode(statement.type) ? statement.type.members : []
      for (const member of membersDeep(members)) {
        if (!ChinesePattern.test(jsDocText(member, sourceFile))) {
          fail(`${label}: 接口文件 ${shortPath(file)} 的 ${statement.name.text}.${member.name?.getText(sourceFile) ?? '(签名)'} 缺中文说明；接口的每个成员都要写清楚做什么`)
        }
      }
    }
    for (const { specifier } of relativeSpecifiers(sourceFile)) {
      const target = resolveRelativeImport(file, specifier)
      if (target && !inside(target, interfaceRoot) && !inside(target, contractRoot)) {
        fail(`${label}: 接口文件 ${shortPath(file)} 引用了 ${shortPath(target)}；接口只引接口与契约`)
      }
    }
  }

  // ── 4. impl：扁平、一类一文件、类配接口、分层 ───────────────────────────
  for (const directory of childDirectories(implRoot)) {
    fail(`${label}: ${module.impl}/${directory}/ 是子目录；实现目录保持扁平，一个类一个文件直接放在 ${module.impl}/ 下`)
  }
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
    // 每个都要有中文说明。其余类型一律不许写在这里：数据放进 contract/，不属于某个类的内部接口放进 interface/ 的内部接口文件。
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
        fail(`${label}: 实现文件 ${shortPath(file)} 里声明了类型 ${name}；数据放进 ${module.contract}/，不属于某个类的内部接口放进 ${module.interface}/，类自己的接口要以类名开头并写在类上方`)
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
  const layerOf = (file) => {
    if (dirname(file) !== implRoot) return null
    const index = module.layers.findIndex((layer) => layer.includes(basename(file)))
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
  for (const file of sourceFiles.filter((path) => inside(path, exportsRoot))) {
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
        fail(`${label}: ${shortPath(file)} 的类 ${className} 没有 implements 接口；每个类有一个接口：公开的在 ${module.interface}/，内部的写在类上方，写清它的每个方法`)
        continue
      }
      const interfaceMembers = new Set()
      for (const typeNode of implementsClause.types) {
        const type = checker.getTypeAtLocation(typeNode)
        const declarations = type.getSymbol()?.declarations ?? []
        const declaredHere = (declaration) => {
          const declaredIn = declaration.getSourceFile().fileName
          return inside(declaredIn, implRoot) && basename(declaredIn) === basename(file)
        }
        if (!declarations.some((declaration) => declaredHere(declaration) || inside(declaration.getSourceFile().fileName, interfaceRoot))) {
          fail(`${label}: ${shortPath(file)} 的类 ${className} 实现的 ${typeNode.getText(sourceFile)} 既不在本文件的类上方，也不在 ${module.interface}/ 里`)
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
  for (const directory of childDirectories(utilsRoot)) {
    fail(`${label}: ${module.utils}/${directory}/ 是子目录；工具函数按类别分文件，目录保持扁平`)
  }
  for (const file of sourceFiles.filter((path) => inside(path, utilsRoot))) {
    const sourceFile = parse(file)
    const documentedFunctions = new Set()
    const functionNames = new Set()
    for (const statement of sourceFile.statements) {
      if (ts.isClassDeclaration(statement)) {
        fail(`${label}: ${shortPath(file)} 里有类 ${statement.name?.text ?? ''}；utils 只放函数和常量，类放进 ${module.impl}/ 并写接口`)
      } else if (ts.isEnumDeclaration(statement)) {
        fail(`${label}: ${shortPath(file)} 里有枚举 ${statement.name.text}；常量表放进 ${module.contract}/`)
      } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        fail(`${label}: ${shortPath(file)} 里声明了类型 ${statement.name.text}；数据放进 ${module.contract}/，带回调的选项放进 ${module.interface}/ 的内部接口文件，utils 只放函数和常量`)
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
      if (inside(target, interfaceRoot) && !isTypeOnlyStatement(statement)) fail(`${label}: ${shortPath(file)} 从 ${shortPath(target)} 做了值 import；接口只能 import type`)
      if (!inside(target, utilsRoot) && !inside(target, contractRoot) && !inside(target, interfaceRoot)) {
        fail(`${label}: ${shortPath(file)} 引用了 ${shortPath(target)}；utils 只引 utils、契约与接口，要用类就在参数里收接口`)
      }
    }
  }

  // ── 6. 对外入口由接口控制 ───────────────────────────────────────────────
  const exportFiles = sourceFiles.filter((path) => inside(path, exportsRoot))
  const entryFileOfSubpath = (subpath) => join(exportsRoot, `${subpath === '.' ? 'index' : subpath.replace(/^\.\//u, '')}.ts`)
  const subpaths = Object.keys(manifest.exports ?? {})
  for (const subpath of subpaths) {
    const target = manifest.exports[subpath]
    const name = subpath === '.' ? 'index' : subpath.replace(/^\.\//u, '')
    const expected = { types: `./dist/${basename(module.exports)}/${name}.d.ts`, import: `./dist/${basename(module.exports)}/${name}.js` }
    for (const key of ['types', 'import']) {
      if (target?.[key] !== expected[key]) fail(`${label}: package.json exports["${subpath}"].${key} 应当是 ${expected[key]}，现在是 ${target?.[key] ?? '(缺)'}`)
    }
    if (!existsSync(entryFileOfSubpath(subpath))) fail(`${label}: package.json 登记了入口 ${subpath}，但没有 ${shortPath(entryFileOfSubpath(subpath))}`)
  }
  for (const file of exportFiles) {
    const subpath = basename(file, '.ts') === 'index' ? '.' : `./${basename(file, '.ts')}`
    if (!subpaths.includes(subpath)) fail(`${label}: ${shortPath(file)} 在 package.json 的 exports 里没有对应的 ${subpath}`)
  }
  const rootEntryPath = entryFileOfSubpath('.')
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
      if (!statement.exportClause && target && !inside(target, exportsRoot) && target !== portablePath) {
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
  const allowedTypeSource = (file) => isPublicInterfaceFile(file) || inside(file, contractRoot)
  const rootReferences = [] // 公开面的根：公开接口声明 + 导出值的类型标注
  for (const [declaration, record] of exported) {
    const file = declaration.getSourceFile().fileName
    if (!inside(file, srcRoot)) continue
    if (!record.isValue) {
      if (!allowedTypeSource(file)) {
        fail(`${label}: 对外导出了类型 ${record.name}，它声明在 ${shortPath(file)}；导出的类型只能来自 ${module.publicInterfaces.map((name) => `${module.interface}/${name}`).join('、')} 或 ${module.contract}/`)
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
        fail(`${label}: 对外导出了契约里的 ${record.name}；契约只导出常量表`)
      }
      continue
    }
    if (!inside(file, implRoot)) {
      fail(`${label}: 对外导出了 ${record.name}，它声明在 ${shortPath(file)}；对外的值只能是 impl 里按公开接口标注的实例、工厂或契约常量表，utils 的函数不出包`)
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
        if (resolved) {
          const top = topLevelOf(resolved.declaration)
          if (isInternalInterfaceFile(resolved.file)) {
            fail(`${label}: 公开面的 ${owner} 引用了内部接口 ${resolved.symbol.name}（${shortPath(resolved.file)}）；内部接口不出包，公开接口只能引用公开接口与契约数据`)
          } else if (inside(resolved.file, implRoot) || inside(resolved.file, utilsRoot)) {
            fail(`${label}: 公开面的 ${owner} 引用了 ${shortPath(resolved.file)} 里的 ${resolved.symbol.name}；公开签名只能用公开接口与契约数据`)
          } else if (inside(resolved.file, contractRoot) || isPublicInterfaceFile(resolved.file)) {
            if (inside(resolved.file, contractRoot)) closure.add(top)
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
    if (!inside(file, contractRoot) || file === portablePath || record.isValue) continue
    if (!closure.has(topLevelOf(declaration))) {
      fail(`${label}: 对外导出了 ${shortPath(file)} 的 ${record.name}，但没有任何公开接口用到它；不是公开签名需要的数据不出包`)
    }
  }
  const portableSourceFile = program.getSourceFile(portablePath)
  for (const statement of portableSourceFile?.statements ?? []) {
    if (!(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isVariableStatement(statement))) continue
    if (ts.isVariableStatement(statement)) continue
    if (closure.has(statement)) continue
    if (ts.isTypeAliasDeclaration(statement) && /\btypeof\b/u.test(statement.type.getText(portableSourceFile))) continue
    fail(`${label}: 可移植数据文件里的 ${statement.name.text} 没有任何公开接口用到；契约里不放包内外都没人用的数据`)
  }

  // ── 7. 会被渲染进程加载的入口 ─────────────────────────────────────────
  for (const entry of module.browserSafeEntries ?? []) {
    const entryFile = join(exportsRoot, entry)
    if (!existsSync(entryFile)) {
      fail(`${label}: 登记为渲染进程可加载的入口 ${module.exports}/${entry} 不存在`)
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
  const visitTable = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(portableSourceFile) === module.environmentTable) {
      const collect = (child) => {
        if (ts.isPropertyAssignment(child) && child.name.getText(portableSourceFile) === 'name' && ts.isStringLiteral(child.initializer)) registeredVariables.add(child.initializer.text)
        ts.forEachChild(child, collect)
      }
      collect(node)
    }
    ts.forEachChild(node, visitTable)
  }
  if (portableSourceFile) visitTable(portableSourceFile)
  if (registeredVariables.size === 0) fail(`${label}: 可移植数据文件里没有环境变量表 ${module.environmentTable}`)
  const usedVariables = new Set()
  for (const file of sourceFiles) {
    if (file === portablePath) continue
    const sourceFile = parse(file)
    const visitStrings = (node) => {
      // 字符串里写的变量名，和 env.VELAROS_X 这样按属性读的变量名，都算用到
      const isText = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
      if (isText || ts.isIdentifier(node)) {
        for (const token of node.text.match(/VELAROS_[A-Z0-9_]*/gu) ?? []) {
          const matches = [...registeredVariables].filter((name) => name === token || (token.endsWith('_') && name.startsWith(token)))
          if (matches.length === 0) fail(`${label}: ${shortPath(file)} 用到了环境变量 ${token}，但它不在 ${module.environmentTable} 里；环境变量也是注入，先登记再用`)
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
  if (toolsSourceFile) {
    const visitCalls = (node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'system') {
        calledPortMembers.add(node.name.text)
      }
      ts.forEachChild(node, visitCalls)
    }
    visitCalls(toolsSourceFile)
  }
  const hostPortDeclaration = module.hostPort ? publicDeclarations.find((statement) => statement.name.text === module.hostPort) : null
  if (module.hostPort && !hostPortDeclaration) {
    fail(`${label}: 登记的宿主端口 ${module.hostPort} 不在公开接口文件里`)
  } else if (hostPortDeclaration) {
    for (const member of hostPortDeclaration.members ?? []) {
      const memberName = member.name?.getText(hostPortDeclaration.getSourceFile())
      if (memberName && !calledPortMembers.has(memberName)) {
        fail(`${label}: 宿主端口 ${module.hostPort}.${memberName} 没有任何工具在调；注入面只留工具真会用的方法，宿主界面要的能力放到本地内核的接口上`)
      }
    }
  }

  // ── 9. src 下的目录，以及依赖只许写在文件头 ────────────────────────────
  for (const file of sourceFiles) {
    const sourceFile = parse(file)
    const visitImports = (node) => {
      if (ts.isImportTypeNode(node)) {
        fail(`${label}: ${shortPath(file)} 用了内联的 import('…') 类型；依赖统一写在文件头的 import type 里，依赖方向和导出规则才查得到`)
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        fail(`${label}: ${shortPath(file)} 用了动态 import()；依赖统一写成文件头的静态 import，依赖方向才查得到`)
      }
      ts.forEachChild(node, visitImports)
    }
    visitImports(sourceFile)
  }
  for (const file of sourceFiles) {
    if (dirname(file) === srcRoot) fail(`${label}: ${shortPath(file)} 放在 src 根上；对外入口放进 ${module.exports}/，其余放进 contract、interface、impl 或 utils`)
  }
  const allowedSourceDirectories = [module.contract, module.interface, module.impl, module.utils, module.exports].map((path) => basename(path))
  for (const directory of childDirectories(srcRoot)) {
    if (!allowedSourceDirectories.includes(directory)) {
      fail(`${label}: src/${directory}/ 不是登记的目录；src 下只有 ${allowedSourceDirectories.join('、')} 五个目录`)
    }
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
    for (const directory of allowedSourceDirectories) {
      if (!new RegExp(`^\\s+${directory}/\\s`, 'mu').test(structure)) fail(`${label}: 卡片「结构」的目录树里没有列出 ${directory}/`)
    }
  }

  // ── 11. 不变量登记表与验收测试 ─────────────────────────────────────────
  const invariantsPath = join(packageRoot, module.invariants)
  const acceptancePath = join(packageRoot, module.acceptance)
  const acceptanceSource = existsSync(acceptancePath) ? readFileSync(acceptancePath, 'utf8') : ''
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
        if (reference !== module.acceptance) fail(`${label}: ${id} 是测试档，检验器必须写 ${module.acceptance}`)
        if (!new RegExp(`\\(\\s*['"\`]${id}\\s`, 'u').test(acceptanceSource)) {
          fail(`${label}: ${id} 标为测试档，但 ${module.acceptance} 里没有以「${id} 」开头的用例`)
        }
      } else if (kind === '类型') {
        const [file, typeName] = reference.split('::')
        const filePath = join(packageRoot, file ?? '')
        if (!file || !typeName || !existsSync(filePath)) {
          fail(`${label}: ${id} 的类型检验器要写成 src/<文件路径>.ts::<类型名>，现在是「${reference}」`)
        } else if (!new RegExp(`\\bexport\\s+(?:interface|type)\\s+${typeName}\\b`, 'u').test(readFileSync(filePath, 'utf8'))) {
          fail(`${label}: ${id} 引用的类型 ${typeName} 不在 ${file} 里`)
        }
      } else if (kind === '门禁') {
        if (!reference.startsWith('check:') || !RootManifest.scripts?.[reference]) {
          fail(`${label}: ${id} 引用的门 ${reference || '(空)'} 不是根 package.json 里的 check 脚本`)
        }
      } else if (kind === '运行时') {
        if (!reference || !existsSync(join(packageRoot, reference))) fail(`${label}: ${id} 的运行时检验器 ${reference || '(空)'} 文件不存在`)
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

  if (failures.length === 0) {
    const kinds = InvariantCheckKinds.filter((kind) => counts[kind] > 0).map((kind) => `${kind} ${counts[kind]}`).join('、')
    const exportedValues = [...exported.values()].filter((record) => record.isValue).length
    console.info(`✓ ${label}: ${module.toolsFile ? `${basename(module.toolsFile)} 里 ${toolNames.length} 个工具` : '没有工具'}；实现 ${implFiles.length} 个文件，${classCount} 个类都有接口（另有 ${errorClassCount} 个错误类）；公开接口 ${publicDeclarations.length} 个，对外的值 ${exportedValues} 个，公开签名用到的数据 ${closure.size} 个；${subpaths.length} 个入口；环境变量 ${registeredVariables.size} 个；不变量 ${seenIds.size} 条（${kinds}）`)
  }
}

if (failures.length > 0) {
  console.error(`Module ownership check failed (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.info('✓ module ownership: single tool file, data-only contracts, documented interfaces, one-class-per-file impl, documented utils, interface-controlled exports, registered environment variables, browser-safe entries, cards, and invariant registries')
