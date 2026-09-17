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

import {
  AgentViewTag,
  BannedModelFacingAliases,
  CapabilityModulePrefix,
  CodeSurfaces,
  HostContextTypes,
} from './surfaces.mjs'

const Here = dirname(fileURLToPath(import.meta.url))
const RepoRoot = resolve(Here, '../..')
const ShouldWrite = process.argv.includes('--write')

/**
 * 产物目录。`--out <目录>` 可以改到别处：验证新格式时不该碰真基线，
 * 尤其是有人正在并行改那几份产物的时候。
 */
const OutputDirectory = resolve(RepoRoot, readOutOption() ?? 'baselines/code-surface')

function readOutOption() {
  const index = process.argv.indexOf('--out')
  return index >= 0 ? process.argv[index + 1] : null
}

/** 内置泛型与类型参数：它们从 lib 来，不该也不可能在包里找到声明。 */
const BuiltinTypeNames = new Set(['Promise', 'Array', 'Readonly', 'Record', 'Partial', 'Omit', 'Pick'])

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
      const sourceRoot = resolve(dependencyRoot, 'src')
      if (ts.sys.directoryExists(sourceRoot)) files.push(...ts.sys.readDirectory(sourceRoot, ['.ts']))
    }
  }
  return files
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

/** 这个节点自己的 JSDoc 里有没有那个标记。要词边界——`@AgentView` 会误匹配 `@modelcontextprotocol`（实测栽过）。 */
function hasModelTag(node, file) {
  return new RegExp(`${AgentViewTag}\\b`, 'u').test(docComment(node, file))
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
          if (depth === 0) { end = index; break }
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
 * 收集一个类型节点里引用到的名字。
 *
 * 三种都要收，少一种产物就编不过（实测三种都栽过）：普通类型引用、**继承子句**
 * （`interface A extends B`，它是 ExpressionWithTypeArguments 不是 TypeReference）、
 * 以及 `typeof X` 这种指向**值**的引用（`type E = (typeof Es)[number]`）。
 */
function collectTypeNames(node, out, values) {
  if (!node) return
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) out.add(node.typeName.text)
  if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) out.add(node.expression.text)
  if (ts.isTypeQueryNode(node) && ts.isIdentifier(node.exprName)) values?.add(node.exprName.text)
  node.forEachChild((child) => collectTypeNames(child, out, values))
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

/** 找一个 `as const` 常量的声明；`typeof X` 引用到的就是它。 */
function findConstant(program, name) {
  for (const wantDeclaration of [false, true]) {
    for (const file of program.getSourceFiles()) {
      if (file.isDeclarationFile !== wantDeclaration) continue
      if (!file.fileName.includes('/packages/') || file.fileName.includes('/node_modules/')) continue
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

/**
 * 在 program 里找一个具名类型的声明；找不到返回 null（内置类型走这条）。
 *
 * **先找源码，再回落到我们自己包的 `.d.ts`**：跨包类型（kernel、shell-command 这些）在这个 program 里
 * 只以 `.d.ts` 形式存在，一刀切掉 `.d.ts` 会让它们静默缺席——而缺席的类型会变成 `any`，
 * 正好丢掉这套东西要的检查。node_modules 与 lib 不找。
 */
function findDeclaration(program, name) {
  const ours = (file) => file.fileName.includes('/packages/') && !file.fileName.includes('/node_modules/')
  for (const wantDeclaration of [false, true]) {
    for (const file of program.getSourceFiles()) {
      if (file.isDeclarationFile !== wantDeclaration || !ours(file)) continue
      for (const statement of file.statements) {
        const named = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
        if (named && statement.name.text === name) return { node: statement, file }
      }
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
  const name = '/velar.d.ts'
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
    (diagnostic) => `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`
  )
}

/** 把一个方法签名编成模型面的那一行：丢掉宿主管道参数，类型原样打印。 */
function renderMethod(member, file, printer, wanted, wantedValues) {
  const parameters = member.parameters.filter((parameter) => {
    if (!parameter.type || !ts.isTypeReferenceNode(parameter.type)) return true
    return !ts.isIdentifier(parameter.type.typeName) || !HostContextTypes.has(parameter.type.typeName.text)
  })
  for (const parameter of parameters) collectTypeNames(parameter.type, wanted, wantedValues)
  collectTypeNames(member.type, wanted, wantedValues)

  const printed = parameters.map((parameter) => printer.printNode(ts.EmitHint.Unspecified, parameter, file))
  const returns = printer.printNode(ts.EmitHint.Unspecified, member.type, file)
  const doc = stripModelTag(afterModelTag(sliceWithDoc(member, file).split(`${member.name.text}(`)[0].trimEnd()))
  return expandBannedAliases(`${doc}\n  ${member.name.text}(${printed.join(', ')}): ${returns}`)
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
  return at < 0 ? doc : ['/**', ...lines.slice(at)].join('\n')
}

/** 标记是给维护的人看的，不进模型面——模型不需要知道我们内部怎么登记。 */
function stripModelTag(text) {
  return text
    .split('\n')
    .map((line) => line.replace(new RegExp(`\\s*${AgentViewTag}\\b`, 'u'), ''))
    .filter((line) => line.trim() !== '*')
    .join('\n')
}

function generate(surface) {
  const program = createProgram(surface.directory)
  const printer = ts.createPrinter({ removeComments: true })
  const methods = []
  const headers = []
  const wanted = new Set()
  const wantedValues = new Set()
  const problems = []

  for (const interfaceName of surface.interfaces) {
    const found = findDeclaration(program, interfaceName)
    if (!found || !ts.isInterfaceDeclaration(found.node)) {
      problems.push(`找不到接口 ${interfaceName}（登记在 scripts/code-surface/surfaces.mjs）`)
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
      methods.push(renderMethod(member, found.file, printer, wanted, wantedValues))
    }
  }

  // 闭包：签名引用到的类型，以及它们自己引用到的
  const closure = new Map()
  const queue = [...wanted]
  while (queue.length > 0) {
    const name = queue.shift()
    if (closure.has(name) || BuiltinTypeNames.has(name) || name in BannedModelFacingAliases) continue
    const found = findDeclaration(program, name)
    if (!found) continue
    closure.set(name, found)
    const nested = new Set()
    collectTypeNames(found.node, nested, wantedValues)
    for (const next of nested) if (!closure.has(next)) queue.push(next)
  }

  // 双向守标记
  const unmarked = [...closure.entries()].filter(([, found]) => !hasModelTag(found.node, found.file)).map(([name]) => name)
  if (unmarked.length > 0) {
    problems.push(
      `这些类型进了模型可观测面却没标 ${AgentViewTag}，在它们的 JSDoc 里加上（顺便想清楚模型看见它合不合适）：\n    ${unmarked.join('\n    ')}`
    )
  }
  for (const stray of findStrayTags(program, closure, surface)) {
    problems.push(`${stray} 标了 ${AgentViewTag} 却不在模型可观测面上；删掉标记，免得它烂成装饰`)
  }

  const constants = []
  for (const name of wantedValues) {
    const found = findConstant(program, name)
    if (!found) continue
    const asType = constantAsType(found)
    // 块里已经是 ambient 上下文，再写 `declare` 是 TS1038。
    if (asType) constants.push(`const ${name}: ${asType}`)
  }
  const declared = [...closure.values()].map(({ node, file }) => expandBannedAliases(stripExport(stripModelTag(sliceWithDoc(node, file)))))
  const types = [...constants, ...declared]
  const header = [
    '// 本文件由 scripts/code-surface/generate-declarations.mjs 从能力包源码生成，不要手改。',
    `// 模型写 \`import { … } from '${CapabilityModulePrefix}${surface.namespace}'\`：${methods.length} 个方法、${declared.length} 个类型。`,
    `// 改源码里带 ${AgentViewTag} 的东西就是改模型可观测面，重算用 \`bun run generate:code-surface\`。`,
  ].join('\n')

  // 类型与方法都放进 `declare module` 块里：模型写 `import { read } from 'velar:system'`，
  // 而且类型因此有了作用域——system 与 project 可以各有一个同名类型而不撞，平铺声明做不到。
  const indented = (text) => text.split('\n').map((line) => (line.length > 0 ? `  ${line}` : line)).join('\n')
  const body = [...headers.map(indented), ...types.map(indented), ...methods.map((method) => indented(exportedMethod(method)))].join('\n\n')
  const text = `${header}\n\ndeclare module '${CapabilityModulePrefix}${surface.namespace}' {\n${body}\n}\n`
  if (problems.length === 0) {
    const broken = verifyDeclarations(text)
    if (broken.length > 0) {
      problems.push(`生成出来的声明自己编不过（前几条）：\n    ${broken.slice(0, 6).join('\n    ')}`)
    }
  }

  return {
    text,
    problems,
    methodCount: methods.length,
    typeCount: types.length,
  }
}

/** 方法在模块块里要写成 `export function`，否则模型 import 不出来。 */
function exportedMethod(method) {
  const lines = method.split('\n')
  const last = lines.length - 1
  lines[last] = (lines[last] ?? '').replace(/^(\s*)([A-Za-z]+)\(/u, '$1export function $2(')
  return lines.join('\n')
}

/** 找标了标记却没进闭包的类型：标记烂成装饰就失去了意义。 */
function findStrayTags(program, closure, surface) {
  const stray = []
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !file.fileName.includes(`/packages/${surface.directory}/`)) continue
    for (const statement of file.statements) {
      const named = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
      // 操作接口自己带标记是合法的：它的头部说明进模块级注释，不是「烂成装饰的标记」。
      if (!named || closure.has(statement.name.text) || surface.interfaces.includes(statement.name.text)) continue
      if (hasModelTag(statement, file)) stray.push(statement.name.text)
    }
  }
  return stray
}

let failed = false
for (const surface of CodeSurfaces) {
  const result = generate(surface)
  const outputPath = resolve(OutputDirectory, `${surface.namespace}.d.ts`)

  if (result.problems.length > 0) {
    failed = true
    process.stdout.write(`✗ ${surface.namespace}:\n  - ${result.problems.join('\n  - ')}\n`)
    continue
  }
  if (ShouldWrite) {
    mkdirSync(OutputDirectory, { recursive: true })
    writeFileSync(outputPath, result.text)
    process.stdout.write(`✓ ${surface.namespace}: ${result.methodCount} 个方法、${result.typeCount} 个类型，${result.text.length} 字符\n`)
    continue
  }

  const current = ts.sys.fileExists(outputPath) ? readFileSync(outputPath, 'utf8') : null
  if (current === result.text) {
    process.stdout.write(`✓ ${surface.namespace}: ${result.methodCount} 个方法、${result.typeCount} 个类型，与源码一致\n`)
    continue
  }
  failed = true
  process.stdout.write(
    `✗ ${surface.namespace}: 生成物与源码不一致。你改的是模型可观测面——先看清楚改了什么，再 \`bun run generate:code-surface\` 重算并提交。\n`
  )
}

if (failed) process.exit(1)
