#!/usr/bin/env node
// 从能力包的 TypeScript 源码生成模型读的能力声明。
//
// 提取靠**源码文本切片**而不是重新打印 AST：操作接口上的中文注释逐字保留，它们正是这件事的全部价值。
// 不带参数是校验（生成物与源码不一致就退 1）；带 --write 才落盘。
//
// 双向守 `@AgentView`：闭包里没标的要你标，标了不在闭包里的要你删。这样标记不可能过期——
// 加一个字段引用了新类型，门禁当场告诉你「它进模型可观测面了」。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { createHash } from 'node:crypto'
import { operationContract } from './operation-contracts.mjs'

import { GovernedModules } from '../ownership/governed-modules.mjs'

import {
  AgentViewTag,
  BannedModelFacingAliases,
  CapabilityModulePrefix,
  CodeSurfaces,
  HostContextTypes,
  StandardSurfaces,
  surfaceConstantName,
} from './surfaces.mjs'

const Here = dirname(fileURLToPath(import.meta.url))
const RepoRoot = resolve(Here, '../..')
const ShouldWrite = process.argv.includes('--write')

/**
 * 产物目录。`--out <目录>` 可以改到别处：验证新格式时不该碰真基线，
 * 尤其是有人正在并行改那几份产物的时候。
 */
const OutputOption = readOutOption()
const OutputDirectory = resolve(RepoRoot, OutputOption ?? 'baselines/script')

function readOutOption() {
  const index = process.argv.indexOf('--out')
  return index >= 0 ? process.argv[index + 1] : null
}

/** 随包发布的那份（contract/surface.ts）的文件头；所有权门禁认这一行，手写的合同文件冒充不了。 */
const SurfaceFileHeader = [
  '// 本文件由 scripts/script/generate-declarations.mjs 从能力包源码生成，不要手改。',
  '// 模型面的声明与代码模版随包发布：空间挂这件能力时把它交给代码面的门，宿主不必另找一份。改了源码里带 @AgentView 的东西或模版，`bun run generate:script` 重算。',
].join('\n')

/** 内置泛型与类型参数：它们从 lib 来，不该也不可能在包里找到声明。 */
const BuiltinTypeNames = new Set([
  'Promise',
  'Array',
  'Readonly',
  'Record',
  'Partial',
  'Omit',
  'Pick',
])

/**
 * 把这个包与它的工作区依赖的**源码**一起编进 program。
 *
 * 只编本包的话，跨包类型只以 `dist/*.d.ts` 的形式存在，于是两件事都会坏：
 * 标记加在源码上、要等那个包重建才看得见（改一个标记要先 build 一圈，荒唐）；
 * 注释读的也是构建产物而不是权威源码。
 */
function createProgram(directory) {
  const packageRoot = resolve(RepoRoot, `packages/${directory}`)
  const config = ts.readConfigFile(resolve(packageRoot, 'tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot)
  const roots = [...parsed.fileNames, ...workspaceSourceFiles(packageRoot)]
  return ts.createProgram(roots, { ...parsed.options, noEmit: true, skipLibCheck: true })
}

/**
 * 这个包在工作区里依赖的那些包的源码文件，**按传递闭包**。
 *
 * 只走直接依赖不够：`ToolResultModelContentPart` 声明在 agent 里、system 经 kernel 间接用到，
 * 只走一层就只能从 `.d.ts` 解析，于是标记加在源码上根本看不见。
 */
function workspaceSourceFiles(packageRoot) {
  const seen = new Set()
  const files = []
  const queue = [packageRoot]
  while (queue.length > 0) {
    const root = queue.shift()
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      if (!name.startsWith('@velaros-ai/') || seen.has(name)) continue
      seen.add(name)
      const dependencyRoot = resolve(RepoRoot, `packages/${name.slice('@velaros-ai/'.length)}`)
      if (!ts.sys.fileExists(resolve(dependencyRoot, 'package.json'))) continue
      queue.push(dependencyRoot)
      files.push(...packageSourceFiles(dependencyRoot))
    }
  }
  return files
}

/**
 * 一个包的源码文件：普通的包在 src/ 下；能力单元的包（`@velaros-ai/velaros`）没有 src/，单元目录就在包根上；
 * 有的包两样都有（`@velaros-ai/core` 的基础原语在 src/，底层单元在包根的单元目录里），单元以所有权登记表为准。
 * 每个单元的 spec/ 与 test/ 不算源码，构建产物与依赖也不算。
 */
function packageSourceFiles(packageRoot) {
  const skipped = new Set(['node_modules', 'dist', 'spec', 'test'])
  const outsideSkipped = (base) => (fileName) =>
    !fileName
      .slice(base.length + 1)
      .split('/')
      .some((part) => skipped.has(part))
  const sourceRoot = resolve(packageRoot, 'src')
  if (!ts.sys.directoryExists(sourceRoot))
    return ts.sys.readDirectory(packageRoot, ['.ts']).filter(outsideSkipped(packageRoot))
  const directory = packageRoot.slice(resolve(RepoRoot, 'packages').length + 1)
  const unitFiles = GovernedModules.filter(
    (module) => module.directory === directory && module.unit
  ).flatMap((module) => {
    const unitRoot = resolve(packageRoot, module.unit)
    return ts.sys.readDirectory(unitRoot, ['.ts']).filter(outsideSkipped(unitRoot))
  })
  return [...ts.sys.readDirectory(sourceRoot, ['.ts']), ...unitFiles]
}

/** 节点前面的 trivia（空行、分节注释、JSDoc 都在这里）。 */
function leadingTrivia(node, file) {
  return file.text.slice(node.getFullStart(), node.getStart(file))
}

/**
 * 紧挨着这个节点的那条 JSDoc。
 *
 * 只在 **trivia 里**找，不在节点正文里找：在整段文本里倒着找 `/**` 会捞到接口体内部方法的注释，
 * 于是接口会被误判成带了标记（实测栽过）。也因此，分节注释（`// ── …… ──` 那种给读源码的人用的横幅）
 * 天然被排除在外——它们不该进模型面。
 */
function docComment(node, file) {
  const trivia = leadingTrivia(node, file)
  const start = trivia.lastIndexOf('/**')
  return start >= 0 ? trivia.slice(start) : ''
}

/** 取一个节点连带它上方 JSDoc 的原文。 */
function sliceWithDoc(node, file) {
  return `${docComment(node, file)}${file.text.slice(node.getStart(file), node.getEnd())}`.trimStart()
}

/** 同上，但说明只留标记之后的那段：标记之前是写给维护者的话（类型在别的包里怎么用），不进模型面。 */
function sliceWithModelDoc(node, file) {
  return `${afterModelTag(docComment(node, file))}${file.text.slice(node.getStart(file), node.getEnd())}`.trimStart()
}

/**
 * 这个节点自己的 JSDoc 里有没有那个标记。
 *
 * 两处讲究，都是实测栽出来的：要**词边界**，否则 `@AgentView` 会误匹配 `@modelcontextprotocol`；
 * 还要求它处在**标签位**（一行的开头，前面只许有 `/**` 或 `*`），否则正文里提一句
 * 「这个类型不带 @AgentView」也会把那个类型标上——写说明的人正好在说它没有。
 */
function hasModelTag(node, file) {
  return new RegExp(`^\\s*(?:/\\*\\*|\\*)?\\s*${AgentViewTag}\\b`, 'mu').test(
    docComment(node, file)
  )
}

/**
 * 把仓库内部的类型别名展开成原生写法。
 *
 * 模型那边没有全局，`Nullable<string>` 对它只是一层要背的间接；写成 `string | null` 是它天天见的。
 * 按尖括号配对扫，不用正则——`Nullable<Record<string, X>>` 这种嵌套正则一定切错。
 */
function expandBannedAliases(text) {
  let output = text
  for (const [alias, shape] of Object.entries(BannedModelFacingAliases)) {
    const suffix = shape.replace(/^T\s*/u, '')
    for (;;) {
      const start = output.search(new RegExp(`\\b${alias}<`, 'u'))
      if (start < 0) break
      let depth = 0
      let end = -1
      for (let index = start + alias.length; index < output.length; index += 1) {
        const character = output[index]
        if (character === '<') depth += 1
        else if (character === '>') {
          depth -= 1
          if (depth === 0) {
            end = index
            break
          }
        }
      }
      if (end < 0) break
      const inner = output.slice(start + alias.length + 1, end)
      // 内部本身是联合或函数类型时要加括号，否则 `A | B | null` 的结合会读错。
      const needsParentheses = /\||=>/u.test(inner.replace(/<[^<>]*>/gu, ''))
      const expanded = `${needsParentheses ? `(${inner})` : inner} ${suffix}`
      output = output.slice(0, start) + expanded + output.slice(end + 1)
    }
  }
  return output
}

/**
 * 收集一个类型节点里引用到的类型（交回引用处的标识符，之后按符号解析到它真正指的那个声明）。
 *
 * 三种都要收，少一种产物就编不过（实测三种都栽过）：普通类型引用、**继承子句**
 * （`interface A extends B`，它是 ExpressionWithTypeArguments 不是 TypeReference）、
 * 以及 `typeof X` 这种指向**值**的引用（`type E = (typeof Es)[number]`）。
 */
function collectTypeReferences(node, out, values) {
  if (!node) return
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) out.add(node.typeName)
  if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression))
    out.add(node.expression)
  if (ts.isTypeQueryNode(node) && ts.isIdentifier(node.exprName)) values?.add(node.exprName.text)
  node.forEachChild((child) => collectTypeReferences(child, out, values))
}

/**
 * 引用处的标识符真正指的那个具名类型声明；内置类型、类型参数与依赖包里的类型交回 null。
 *
 * **按符号解析，不按名字找**：不同单元各有一个 `SearchResult` 是常态，按名字找会拿到先遇到的那个，
 * 把别家的类型悄悄塞进模型面（实测撞过：act/search 的报告被解析成了 project 的检索结果）。
 * 跨包的类型在这个 program 里经包清单解析到 `dist/*.d.ts`，再按「同一个包、同一个名字」映回源码：注释以源码为准，加了标记不必先重建那个包。
 */
function resolveDeclaration(program, identifier) {
  const checker = program.getTypeChecker()
  let symbol = checker.getSymbolAtLocation(identifier)
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
  // 依赖包刚加的类型还没进它的 dist，符号解析不到：按名字在源码里找，只认唯一的那个
  if (!symbol?.declarations?.length) return uniqueSourceDeclaration(program, identifier.text)
  const node = symbol.declarations?.find(
    (declaration) =>
      ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)
  )
  if (!node) return null
  const file = node.getSourceFile()
  if (!file.fileName.includes('/packages/') || file.fileName.includes('/node_modules/')) return null
  if (!file.isDeclarationFile) return { node, file }
  const home = file.fileName.match(/^(.*\/packages\/[^/]+\/)dist\//u)?.[1]
  if (!home) return { node, file }
  for (const source of program.getSourceFiles()) {
    if (
      source.isDeclarationFile ||
      !source.fileName.startsWith(home) ||
      source.fileName.includes('/node_modules/')
    )
      continue
    for (const statement of source.statements) {
      const named = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
      if (named && statement.name.text === node.name.text) return { node: statement, file: source }
    }
  }
  return { node, file }
}

/**
 * 把一个 `as const` 常量编成**类型**。
 *
 * `declare const X: <这里要类型>`——直接把初始化表达式抄过来会写出 `[...] as const`，那是值不是类型，
 * 语法当场就错（实测栽过）。所以剥掉 `Object.freeze(...)` 与 `as const`，数组补上 `readonly`。
 */
function constantAsType(found) {
  const initializer = found.node.initializer
  if (!initializer) return null
  const raw = found.file.text.slice(initializer.getStart(found.file), initializer.getEnd())
  const unwrapped = raw
    .replace(/^Object\.freeze\(/u, '')
    .replace(/\)$/u, '')
    .replace(/\s+as\s+const\s*$/u, '')
    .trim()
  return unwrapped.startsWith('[') ? `readonly ${unwrapped}` : unwrapped
}

/**
 * 常量是一串字面量（`Object.freeze(['a', 'b'] as const)` 这种词表）时，交回它们写成的联合 `'a' | 'b'`；别的形状交回 null。
 *
 * `type K = (typeof Ks)[number]` 是源码里的写法：常量是运行时的唯一权威，类型从它推。模型那边拿不到这个常量，
 * 照抄过去它就得从字段跳到类型、再跳到常量才知道能填什么——就地写成字面量联合，才是它一眼看得懂的原生形式。
 */
function literalUnion(found) {
  let expression = found.node.initializer
  if (
    expression &&
    ts.isCallExpression(expression) &&
    expression.getText(found.file).startsWith('Object.freeze(')
  )
    expression = expression.arguments[0]
  if (expression && ts.isAsExpression(expression)) expression = expression.expression
  if (!expression || !ts.isArrayLiteralExpression(expression)) return null
  const literals = expression.elements.every(
    (element) => ts.isStringLiteral(element) || ts.isNumericLiteral(element)
  )
  return literals && expression.elements.length > 0
    ? expression.elements.map((element) => element.getText(found.file)).join(' | ')
    : null
}

/** 把 `(typeof X)[number]` 就地换成 X 的字面量联合；后面紧跟 `[` 的（数组）套一层括号，结合才不会读错。 */
function inlineLiteralUnions(text, unions) {
  let output = text
  for (const [name, union] of unions) {
    output = output.replace(
      new RegExp(`\\(typeof ${name}\\)\\[number\\](?=(\\[)?)`, 'gu'),
      (_match, array) => (array ? `(${union})` : union)
    )
  }
  return output
}

/** 找一个 `as const` 常量的声明；`typeof X` 引用到的就是它。 */
function findConstant(program, name) {
  for (const wantDeclaration of [false, true]) {
    for (const file of program.getSourceFiles()) {
      if (file.isDeclarationFile !== wantDeclaration) continue
      if (!file.fileName.includes('/packages/') || file.fileName.includes('/node_modules/'))
        continue
      for (const statement of file.statements) {
        if (!ts.isVariableStatement(statement)) continue
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
            return { node: declaration, file }
          }
        }
      }
    }
  }
  return null
}

/** 全部包的源码里唯一叫这个名字的具名类型；没有或不止一个都交回 null（同名时生成物编不过，会当场报出来）。 */
function uniqueSourceDeclaration(program, name) {
  const found = []
  for (const file of program.getSourceFiles()) {
    if (
      file.isDeclarationFile ||
      !file.fileName.includes('/packages/') ||
      file.fileName.includes('/node_modules/')
    )
      continue
    for (const statement of file.statements) {
      const named = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
      if (named && statement.name.text === name) found.push({ node: statement, file })
    }
  }
  return found.length === 1 ? found[0] : null
}

/**
 * 在登记的能力目录里找操作接口的声明；找不到返回 null。
 * 只在这件能力自己的源码目录里找：别的单元有同名接口也不会被错拿（签名引用到的类型另按符号解析，见 `resolveDeclaration`）。
 */
function findOperationInterface(program, name, home) {
  for (const file of program.getSourceFiles()) {
    if (
      file.isDeclarationFile ||
      !file.fileName.startsWith(home) ||
      file.fileName.includes('/node_modules/')
    )
      continue
    for (const statement of file.statements) {
      if (ts.isInterfaceDeclaration(statement) && statement.name.text === name)
        return { node: statement, file }
    }
  }
  return null
}

/**
 * 证明产物自己编得过。
 *
 * **必须关掉 `skipLibCheck`**：开着的时候声明文件自身根本不被检查，未解析的类型会静默变成 `any`，
 * 于是「生成了一份看着漂亮、实际没有类型」的东西照样出厂（实测栽过，11 条未解析全被吞掉）。
 */
function verifyDeclarations(text) {
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: [],
  }
  const name = '/velaros.d.ts'
  const defaultHost = ts.createCompilerHost(options, true)
  const host = {
    ...defaultHost,
    fileExists: (path) => path === name || defaultHost.fileExists(path),
    readFile: (path) => (path === name ? text : defaultHost.readFile(path)),
    getSourceFile: (path, languageVersion, onError) =>
      path === name
        ? ts.createSourceFile(path, text, languageVersion, true)
        : defaultHost.getSourceFile(path, languageVersion, onError),
    writeFile: () => {},
  }
  const program = ts.createProgram([name], options, host)
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].map(
    (diagnostic) =>
      `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`
  )
}

/** 把一个方法签名编成模型面的那一行：丢掉宿主管道参数，类型原样打印。 */
function renderMethod(member, file, printer, wanted, wantedValues) {
  const parameters = member.parameters.filter((parameter) => {
    if (!parameter.type || !ts.isTypeReferenceNode(parameter.type)) return true
    return (
      !ts.isIdentifier(parameter.type.typeName) ||
      !HostContextTypes.has(parameter.type.typeName.text)
    )
  })
  for (const parameter of parameters) collectTypeReferences(parameter.type, wanted, wantedValues)
  collectTypeReferences(member.type, wanted, wantedValues)

  const printed = parameters.map((parameter) => printParameter(parameter, file, printer))
  const returns = printer.printNode(ts.EmitHint.Unspecified, member.type, file)
  const doc = alignDoc(
    stripModelTag(
      afterModelTag(sliceWithDoc(member, file).split(`${member.name.text}(`)[0].trimEnd())
    )
  )
  return expandBannedAliases(`${doc}\n${member.name.text}(${printed.join(', ')}): ${returns}`)
}

/**
 * 入参在接口里写成 `input: Optional<X>`（宿主上下文参数排在它后面，TS 不许它写成 `input?`）时，印成模型天天见的 `input?: X`：
 * 这个操作不给参数也能调（`modules.list()`），派生的 schema 同时收 null。手写的 `X | undefined` 同样认。
 */
function printParameter(parameter, file, printer) {
  const type = parameter.type
  const print = (node) => printer.printNode(ts.EmitHint.Unspecified, node, file)
  if (
    type &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === 'Optional' &&
    type.typeArguments?.length === 1
  )
    return `${parameter.name.getText(file)}?: ${print(type.typeArguments[0])}`
  if (
    !type ||
    !ts.isUnionTypeNode(type) ||
    !type.types.some((member) => member.kind === ts.SyntaxKind.UndefinedKeyword)
  )
    return print(parameter)
  const rest = type.types
    .filter((member) => member.kind !== ts.SyntaxKind.UndefinedKeyword)
    .map(print)
  return `${parameter.name.getText(file)}?: ${rest.join(' | ')}`
}

/**
 * 方法说明是从接口里按原样切出来的：首行顶格，其余行还带着接口里的缩进。排成顶格的 `/**`、` * `、` *\/`，
 * 和类型的说明一个样子——模块块统一再缩进一层，模型看到的每个方法和类型对得齐。
 */
function alignDoc(doc) {
  return doc
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      return trimmed.startsWith('*') ? ` ${trimmed}` : trimmed
    })
    .join('\n')
}

/** 剥掉 `export`：模型读的是一份环境声明，带了 export 它就成了模块，`declare const` 也就不再是全局的了。 */
function stripExport(text) {
  return text.replace(/^(\s*)export\s+(?=(?:declare\s+)?(?:interface|type)\b)/mu, '$1')
}

/**
 * 只留标记**之后**的那段说明。
 *
 * 方法上标记就在第一行，整段都是模型面的——这条规则对它们是恒等变换。
 * 接口头上则可以先写给我们自己看的话（实现类叫什么、进程里有几份），再用标记起一段模型面的说明。
 * 同一条规则两处都成立，不必再发明第二种写法。
 */
function afterModelTag(doc) {
  const lines = doc.split('\n')
  const at = lines.findIndex((line) => new RegExp(`${AgentViewTag}\\b`, 'u').test(line))
  if (at < 0) return doc
  // 标记就写在开头那一行（单行的 `/** @AgentView …… */`）：整段本来就是模型面，原样留着，不再补一个 `/**`。
  if (lines[at].trimStart().startsWith('/**')) return lines.slice(at).join('\n')
  return ['/**', ...lines.slice(at)].join('\n')
}

/** 标记是给维护的人看的，不进模型面——模型不需要知道我们内部怎么登记。 */
function stripModelTag(text) {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(new RegExp(`\\s*${AgentViewTag}\\b`, 'u'), '')
        .replace(/\s*@OperationEffect\s+(none|write)\b/u, '')
        .replace(/\s*@OperationModes\s+execute\b/u, '')
    )
    .filter((line) => line.trim() !== '*')
    .join('\n')
}

/**
 * 一个模块块的全部声明：导出项引用到的类型闭包（按符号解析，双向守标记），字面量词表就地展开，最后证明它自己编得过。
 * 能力模块（导出操作）与脚本标准模块（导出常量）共用这一套；问题追加进 problems，不在这里抛。
 */
function declarationModule(program, specifier, headers, exports, wanted, wantedValues, problems) {
  // 闭包：签名引用到的类型，以及它们自己引用到的。按名字登记：同一个模块块里两个类型同名是编不过的，当场报出来
  const closure = new Map()
  const queue = [...wanted]
  while (queue.length > 0) {
    const identifier = queue.shift()
    if (BuiltinTypeNames.has(identifier.text) || identifier.text in BannedModelFacingAliases)
      continue
    const found = resolveDeclaration(program, identifier)
    if (!found) continue
    const name = found.node.name.text
    const existing = closure.get(name)
    if (existing) {
      if (existing.node !== found.node)
        problems.push(
          `模型面上有两个同名类型 ${name}：${existing.file.fileName.slice(RepoRoot.length + 1)} 与 ${found.file.fileName.slice(RepoRoot.length + 1)}，改掉其中一个的名字`
        )
      continue
    }
    closure.set(name, found)
    const nested = new Set()
    collectTypeReferences(found.node, nested, wantedValues)
    for (const next of nested) queue.push(next)
  }

  // 双向守标记
  const unmarked = [...closure.entries()]
    .filter(([, found]) => !hasModelTag(found.node, found.file))
    .map(([name]) => name)
  if (unmarked.length > 0) {
    problems.push(
      `这些类型进了模型可观测面却没标 ${AgentViewTag}，在它们的 JSDoc 里加上（顺便想清楚模型看见它合不合适）：\n    ${unmarked.join('\n    ')}`
    )
  }

  // 字面量词表就地展开成联合；展开之后还有人用 `typeof` 指着的常量（不是字面量词表，或者用法不是取元素）才照抄过去。
  const unions = new Map()
  const found = new Map()
  for (const name of wantedValues) {
    const constant = findConstant(program, name)
    if (!constant) continue
    found.set(name, constant)
    const union = literalUnion(constant)
    if (union) unions.set(name, union)
  }
  const declared = [...closure.values()].map(({ node, file }) =>
    inlineLiteralUnions(
      expandBannedAliases(stripExport(stripModelTag(sliceWithModelDoc(node, file)))),
      unions
    )
  )
  const exported = exports.map((text) => inlineLiteralUnions(text, unions))
  const constants = []
  for (const [name, constant] of found) {
    if (
      ![...declared, ...exported].some((text) => new RegExp(`\\btypeof ${name}\\b`, 'u').test(text))
    )
      continue
    const asType = constantAsType(constant)
    // 块里已经是 ambient 上下文，再写 `declare` 是 TS1038。
    if (asType) constants.push(`const ${name}: ${asType}`)
  }
  const types = [...constants, ...declared]

  // 类型与导出项都放进 `declare module` 块里：模型写 `import { read } from 'velaros:files'`，
  // 而且类型因此有了作用域——两件能力可以各有一个同名类型而不撞，平铺声明做不到。
  const indented = (text) =>
    text
      .split('\n')
      .map((line) => (line.length > 0 ? `  ${line}` : line))
      .join('\n')
  const body = [...headers.map(indented), ...types.map(indented), ...exported.map(indented)].join(
    '\n\n'
  )
  // 这份文字就是模型看到的全部：维护者要的说明（谁生成的、怎么重算）写在随包发布的 surface.ts 与这个脚本里，不进来。
  const text = `declare module '${specifier}' {\n${body}\n}\n`
  if (problems.length === 0) {
    const broken = verifyDeclarations(text)
    if (broken.length > 0) {
      problems.push(
        `生成出来的声明自己编不过（前几条）：\n    ${broken.slice(0, 6).join('\n    ')}`
      )
    }
  }
  return { text, typeCount: types.length, closure }
}

function generate(surface) {
  const program = createProgram(surface.directory)
  const printer = ts.createPrinter({ removeComments: true })
  const methods = []
  const methodNames = []
  const operations = {}
  const headers = []
  const wanted = new Set()
  const wantedValues = new Set()
  const problems = []

  for (const interfaceName of surface.interfaces) {
    const found = findOperationInterface(
      program,
      interfaceName,
      `${resolve(RepoRoot, 'packages', surface.directory, surface.unit ?? '')}/`
    )
    if (!found) {
      problems.push(`找不到接口 ${interfaceName}（登记在 scripts/script/surfaces.mjs）`)
      continue
    }
    // 接口头上带标记的那段进模块级注释：那里写的是**整个命名空间**都成立的事
    // （位置按字符算、编码怎么保留、哪些路径会先问用户），逐个方法抄一遍既啰嗦又必然抄漏。
    if (hasModelTag(found.node, found.file)) {
      headers.push(stripModelTag(afterModelTag(docComment(found.node, found.file))).trim())
    }
    for (const member of found.node.members) {
      if (!ts.isMethodSignature(member) || !ts.isIdentifier(member.name) || !member.type) continue
      if (!hasModelTag(member, found.file)) continue
      methodNames.push(member.name.text)
      methods.push(renderMethod(member, found.file, printer, wanted, wantedValues))
      try {
        operations[member.name.text] = operationContract(
          program,
          member,
          found.file,
          HostContextTypes
        )
      } catch (error) {
        problems.push(String(error.message))
      }
    }
  }

  // 代码模版不能省：我们知道这些能力怎么组合，模型未必知道。一个命名空间一份模版文件，import 只写一次、一段一个函数一种日常用法——只是示例，模型按需要改写。
  // 它**不嵌进声明、不常驻**：随包发布在模型面的 template 字段里，模型拿不准怎么组合时通过 modules.describe({module:'velaros:x'}) 的 template 字段读；
  // 对不对有两道：各单元的验收照真实声明整份做类型检查，仓库层的测试在真的空间里把每个函数跑一遍。
  // 登记成数组时按顺序接成一份：能力按装配叠加时（工作记忆之上再挂长期记忆），每段用法只写一处。
  const templateHome = surface.unit
    ? `packages/${surface.directory}/${surface.unit}`
    : `packages/${surface.directory}`
  const templatePaths = [surface.templates ?? []]
    .flat()
    .map((name) => resolve(RepoRoot, templateHome, name))
  const templateParts = templatePaths.map((path) =>
    ts.sys.fileExists(path) ? readFileSync(path, 'utf8').trim() : ''
  )
  const template = templateParts.includes('') ? '' : templateParts.join('\n')
  if (template.length === 0) {
    problems.push(
      `${surface.namespace} 没有代码模版：在 ${templateHome}/ 写一份日常用法的示例程序，并在 surfaces.mjs 登记`
    )
  }

  const { text, typeCount, closure } = declarationModule(
    program,
    `${CapabilityModulePrefix}${surface.namespace}`,
    headers,
    methods.map(exportedMethod),
    wanted,
    wantedValues,
    problems
  )

  return {
    text,
    template,
    operations,
    problems,
    methodNames,
    methodCount: methods.length,
    typeCount,
    marked: new Set([...closure.keys(), ...surface.interfaces]),
  }
}

/**
 * 脚本标准模块的声明：登记的接口在所属包的 src 里找，它的每个属性成为一个 `export const`，属性上的注释照原样带上。
 * 没有操作，也就没有 schema 与效果；类型闭包、标记与自证编译和能力模块同一套。
 */
function generateStandard(entry) {
  const program = createProgram(entry.directory)
  const printer = ts.createPrinter({ removeComments: true })
  const problems = []
  const wanted = new Set()
  const wantedValues = new Set()
  const found = findOperationInterface(
    program,
    entry.interface,
    `${resolve(RepoRoot, 'packages', entry.directory, 'src')}/`
  )
  if (!found)
    return {
      problems: [
        `找不到接口 ${entry.interface}（登记在 scripts/script/surfaces.mjs 的 StandardSurfaces）`,
      ],
      marked: new Set([entry.interface]),
    }
  if (!hasModelTag(found.node, found.file))
    problems.push(`${entry.interface} 缺 ${AgentViewTag}：标记之后写这个模块给模型看的说明`)
  const headers = [stripModelTag(afterModelTag(docComment(found.node, found.file))).trim()].filter(
    Boolean
  )
  const exports = []
  for (const member of found.node.members) {
    if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name) || !member.type) {
      problems.push(`${entry.interface} 只能放属性：每个属性成为 ${entry.specifier} 的一个导出`)
      continue
    }
    collectTypeReferences(member.type, wanted, wantedValues)
    const doc = alignDoc(docComment(member, found.file).trim())
    exports.push(
      `${doc ? `${doc}\n` : ''}export const ${member.name.text}: ${expandBannedAliases(printer.printNode(ts.EmitHint.Unspecified, member.type, found.file))}`
    )
  }
  const { text, typeCount, closure } = declarationModule(
    program,
    entry.specifier,
    headers,
    exports,
    wanted,
    wantedValues,
    problems
  )
  return {
    text,
    problems,
    exportCount: exports.length,
    typeCount,
    marked: new Set([...closure.keys(), entry.interface]),
  }
}

/**
 * 按包编出每份 `contract/surface.ts`：一个包里挂几个命名空间（项目空间的 project 与 code）就写几个常量。
 * 只放数据、不 import 任何东西，渲染进程也能加载；类型就地写明，不让能力包为这一行去依赖代码面。
 */
function surfaceModules() {
  const files = new Map()
  for (const surface of CodeSurfaces) {
    const result = generated.get(surface.namespace)
    if (!result || result.problems.length > 0) continue
    const home = surface.unit
      ? `packages/${surface.directory}/${surface.unit}`
      : `packages/${surface.directory}/src`
    const path = resolve(RepoRoot, home, 'contract', 'surface.ts')
    const specifier = `${CapabilityModulePrefix}${surface.namespace}`
    const block = [
      `/** \`${specifier}\` 的模型面：模型 import 的模块名、放出去的方法、生成的完整声明（与 baselines/script/${surface.namespace}.d.ts 是同一份）、代码模版（${[surface.templates].flat().join(' + ')}）。 */`,
      `export const ${surfaceConstantName(surface.namespace)} = Object.freeze({`,
      `  specifier: '${specifier}',`,
      `  namespace: '${surface.namespace}',`,
      `  methods: Object.freeze([${result.methodNames.map((name) => `'${name}'`).join(', ')}]),`,
      `  declarations: ${JSON.stringify(result.text)},`,
      `  template: ${JSON.stringify(result.template)},`,
      `  revision: '${createHash('sha256').update(JSON.stringify(result.operations)).digest('hex')}',`,
      `  operations: ${JSON.stringify(result.operations)} as const,`,
      '})',
    ].join('\n')
    files.set(path, [...(files.get(path) ?? []), block])
  }
  for (const entry of StandardSurfaces) {
    const result = generatedStandard.get(entry.namespace)
    if (!result || result.problems.length > 0) continue
    const path = resolve(RepoRoot, 'packages', entry.directory, 'src', 'contract', 'surface.ts')
    const block = [
      `/** \`${entry.specifier}\` 的模型面：生成的完整声明（与 baselines/script/${entry.namespace}.d.ts 是同一份），检查器、包编译器与运行时说明都用它。 */`,
      `export const ${entry.constant} = ${JSON.stringify(result.text)}`,
    ].join('\n')
    files.set(path, [...(files.get(path) ?? []), block])
  }
  return [...files].map(([path, blocks]) => [
    path,
    [SurfaceFileHeader, ...blocks].join('\n\n') + '\n',
  ])
}

/** 方法在模块块里要写成 `export function`，否则模型 import 不出来。 */
function exportedMethod(method) {
  const lines = method.split('\n')
  const last = lines.length - 1
  lines[last] = (lines[last] ?? '').replace(/^(\s*)([A-Za-z]+)\(/u, '$1export function $2(')
  return lines.join('\n')
}

/**
 * 找标了标记却不在**任何**模型面上的类型：标记烂成装饰就失去了意义。
 *
 * 扫全部包，不只扫登记过的目录：一件能力搬走之后留在原包里的标记，只有这样才抓得到；
 * 闭包是所有命名空间的并集，因为一个包里的类型可以被别的命名空间引用（`TextEncoding` 在 text-files 里，被 files 用）。
 */
function findStrayTags(marked) {
  const stray = []
  const packagesRoot = resolve(RepoRoot, 'packages')
  for (const entry of ts.sys.getDirectories(packagesRoot)) {
    const packageRoot = resolve(packagesRoot, entry)
    if (!ts.sys.fileExists(resolve(packageRoot, 'package.json'))) continue
    for (const fileName of packageSourceFiles(packageRoot)) {
      const text = readFileSync(fileName, 'utf8')
      if (!text.includes(AgentViewTag)) continue
      const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
      for (const statement of file.statements) {
        const named = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
        if (named && !marked.has(statement.name.text) && hasModelTag(statement, file))
          stray.push(
            `packages/${entry}/${fileName.slice(packageRoot.length + 1)} 的 ${statement.name.text}`
          )
      }
    }
  }
  return stray
}

let failed = false
const marked = new Set()
const generated = new Map()
for (const surface of CodeSurfaces) {
  const result = generate(surface)
  generated.set(surface.namespace, result)
  for (const name of result.marked) marked.add(name)
  const outputPath = resolve(OutputDirectory, `${surface.namespace}.d.ts`)

  if (result.problems.length > 0) {
    failed = true
    process.stdout.write(`✗ ${surface.namespace}:\n  - ${result.problems.join('\n  - ')}\n`)
    continue
  }
  if (ShouldWrite) {
    mkdirSync(OutputDirectory, { recursive: true })
    writeFileSync(outputPath, result.text)
    process.stdout.write(
      `✓ ${surface.namespace}: ${result.methodCount} 个方法、${result.typeCount} 个类型，${result.text.length} 字符\n`
    )
    continue
  }

  const current = ts.sys.fileExists(outputPath) ? readFileSync(outputPath, 'utf8') : null
  if (current === result.text) {
    process.stdout.write(
      `✓ ${surface.namespace}: ${result.methodCount} 个方法、${result.typeCount} 个类型，与源码一致\n`
    )
    continue
  }
  failed = true
  process.stdout.write(
    `✗ ${surface.namespace}: 生成物与源码不一致。你改的是模型可观测面——先看清楚改了什么，再 \`bun run generate:script\` 重算并提交。\n`
  )
}

const generatedStandard = new Map()
for (const entry of StandardSurfaces) {
  const result = generateStandard(entry)
  generatedStandard.set(entry.namespace, result)
  for (const name of result.marked) marked.add(name)
  const outputPath = resolve(OutputDirectory, `${entry.namespace}.d.ts`)
  if (result.problems.length > 0) {
    failed = true
    process.stdout.write(`✗ ${entry.specifier}:\n  - ${result.problems.join('\n  - ')}\n`)
    continue
  }
  if (ShouldWrite) {
    mkdirSync(OutputDirectory, { recursive: true })
    writeFileSync(outputPath, result.text)
    process.stdout.write(
      `✓ ${entry.specifier}: ${result.exportCount} 个导出、${result.typeCount} 个类型，${result.text.length} 字符\n`
    )
    continue
  }
  const current = ts.sys.fileExists(outputPath) ? readFileSync(outputPath, 'utf8') : null
  if (current === result.text) {
    process.stdout.write(
      `✓ ${entry.specifier}: ${result.exportCount} 个导出、${result.typeCount} 个类型，与源码一致\n`
    )
    continue
  }
  failed = true
  process.stdout.write(
    `✗ ${entry.specifier}: 生成物与源码不一致。你改的是模型可观测面——先看清楚改了什么，再 \`bun run generate:script\` 重算并提交。\n`
  )
}

// 声明随包发布：每件能力在自己包的 contract/surface.ts 里带一份（模块名、放出去的方法、完整声明），
// 空间挂它时交给代码面的门；和上面那份 baselines 是同一份。写到别的目录（--out）时不碰包里的文件。
if (!OutputOption) {
  for (const [path, text] of surfaceModules()) {
    const current = ts.sys.fileExists(path) ? readFileSync(path, 'utf8') : null
    if (current === text) continue
    if (ShouldWrite) {
      writeFileSync(path, text)
      process.stdout.write(`✓ ${path.slice(RepoRoot.length + 1)}：随包发布的模型面已更新\n`)
      continue
    }
    failed = true
    process.stdout.write(
      `✗ ${path.slice(RepoRoot.length + 1)} 与生成的声明不一致；\`bun run generate:script\` 重算并提交\n`
    )
  }
}

const stray = findStrayTags(marked)
if (stray.length > 0) {
  failed = true
  process.stdout.write(
    `✗ 这些类型标了 ${AgentViewTag} 却不在任何模型面上；删掉标记，免得它烂成装饰：\n  - ${stray.join('\n  - ')}\n`
  )
}

// 登记表里没有的命名空间，产物也不该留着：模型会读到一件已经不存在的能力。
const expected = new Set(
  [...CodeSurfaces, ...StandardSurfaces].map((surface) => `${surface.namespace}.d.ts`)
)
const leftovers = ts.sys.directoryExists(OutputDirectory)
  ? ts.sys
      .readDirectory(OutputDirectory, ['.d.ts'])
      .map((path) => path.slice(OutputDirectory.length + 1))
      .filter((name) => !expected.has(name))
  : []
if (leftovers.length > 0) {
  failed = true
  process.stdout.write(
    `✗ ${OutputDirectory} 里有登记表之外的声明：${leftovers.join('、')}；那件能力已经不在了，删掉它\n`
  )
}

if (failed) process.exit(1)
