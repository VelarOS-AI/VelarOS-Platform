/**
 * 编译器那一侧的活：内存文件系统、诊断换算、按 JavaScript 或 TypeScript 各查一遍、剥类型。
 * 全是纯函数，所以不放在类里；`CodeProgramChecker` 只负责按什么顺序用它们。
 */

import ts from 'typescript'

import { isUndefined } from '@velaros-ai/core'

import { CodeSurfaceLimits } from '../contract/constants.js'
import type { CodeProgramDiagnostic } from '../types/code-surface.js'

import { programForCheck, ProgramModuleSpecifier } from './program.js'

/** 生成出来的能力声明在内存文件系统里的名字。 */
export const DeclarationFileName = '/velar.d.ts'

/**
 * 恒常授权的那个模块：这次运行本身的环境。
 *
 * **我们发明的东西要导入，语言自带的不动**——`blobs` 是我们发明的概念，
 * 做成隐形全局等于让模型背一条只有提示词告诉过它的暗知识；`console` 是 JavaScript 自带的，
 * 让模型 `import { console }` 才是真的怪。
 * 这个模块永远在常驻档，不需要租约、不占授权名额。
 */
const ProgramModuleDeclarations = `declare module '${ProgramModuleSpecifier}' {
  /**
   * 你写的是一段程序：\`import\` 拿能力，顶层 \`await\` 直接用，\`export default\` 交出答案；
   * 也可以具名导出几样（\`export const total = …\`），结果就是 \`{ default?, total, … }\`。
   *
   * **能力调用的返回值落在程序的变量里，不进你的上下文。** 你只看得到两样：
   * \`export default\` 交出来的值（最多 ${CodeSurfaceLimits.valueChars} 字符）和 \`console.log\` 的输出（最多 ${CodeSurfaceLimits.logChars} 字符）；
   * 整份结果不超过 ${CodeSurfaceLimits.resultChars} 字符，超出的截掉并告诉你。所以：
   * - 不知道东西多大，先在程序里看大小，再决定交出多少
   * - 大东西里找东西，在程序里筛好了再交，别整份交
   * - 别把大段内容塞进 \`throw\`，失败说明只留开头 ${CodeSurfaceLimits.failureChars} 字符
   * - 能力交给你的图不在返回值里，跟在结果后面给你看；一次最多 ${CodeSurfaceLimits.images} 张。
   *   图只留到你下一次调用为止——一次看一张，看完先把要点写下来，再看下一张
   *
   * 每个能力模块开头都有一份代码模版，挑一段照着改。
   */

  /** 大字符串旁路：宿主随程序一起送进来的那几段，按名字取。文件内容走这里，不进源码——否则要过好几层转义。 */
  export const blobs: Record<string, string>
}`

/**
 * 把这一轮授权的几个命名空间拼成一份声明。
 *
 * **只拼授权的**——不授权的模块不进来，`import` 它就解析不出来（TS2307）。
 * 这道闸是语言给的，不用我们写判定；也正因为如此，检查器绝不能图省事加载全量。
 */
export function joinGrantedDeclarations(granted: ReadonlyArray<{ declarations: string }>): string {
  return [ProgramModuleDeclarations, ...granted.map((module) => module.declarations)].join('\n\n')
}

/** 手滑写成 TypeScript 时用的那份文件名；换个后缀编译器才会按 TS 解析。 */
export const TypeScriptProgramFileName = '/program.ts'

/**
 * 常规路径的编译选项：模型写 JavaScript，类型全靠声明推。
 * 严格度与产品代码同档；不产出、跳过 lib 检查（lib 是我们自己给的，不必再查一遍）。
 */
export const JavaScriptCheckOptions: ts.CompilerOptions = Object.freeze({
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  // 写 JavaScript 换来的是：中间不必转译，因而没有转译带来的行号错位。
  allowJs: true,
  checkJs: true,
  // `catch (e)` 在 JS 里没法写 `as Error`；不放开这条，模型每写一个 try/catch 都会红。
  useUnknownInCatchVariables: false,
  // 不让程序看见 @types/*：模型只该看见我们给的声明，多一个环境类型就多一条它以为能用的路。
  types: [],
})

/** 手滑那条路上用的选项：同一套严格度，只是按 TypeScript 解析。 */
export const TypeScriptCheckOptions: ts.CompilerOptions = Object.freeze({
  ...JavaScriptCheckOptions,
  allowJs: false,
  checkJs: false,
})

/** 内存文件系统：认得传进来的这几份，其余交给默认 host（它要去读 lib.*.d.ts）。程序因此不必落盘。 */
export function createMemoryCompilerHost(
  files: ReadonlyMap<string, string>,
  options: ts.CompilerOptions
): ts.CompilerHost {
  const defaultHost = ts.createCompilerHost(options, true)
  return {
    ...defaultHost,
    fileExists: (name) => files.has(name) || defaultHost.fileExists(name),
    readFile: (name) => files.get(name) ?? defaultHost.readFile(name),
    getSourceFile: (name, languageVersion, onError) => {
      const text = files.get(name)
      if (isUndefined(text)) return defaultHost.getSourceFile(name, languageVersion, onError)
      return ts.createSourceFile(name, text, languageVersion, true)
    },
    writeFile: () => {},
  }
}

/**
 * 把一条 TS 诊断换算成模型面的形状。
 *
 * **程序不包装**（它本来就是个模块），所以编译器给的 0 基行号要加一才是模型写的那一行。
 * 早先用「函数体 + 包装」时包装恰好占掉第 0 行，两者数值相等——那是巧合，形态一改就错一位。
 */
export function toModelDiagnostic(diagnostic: ts.Diagnostic): CodeProgramDiagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
  const file = diagnostic.file
  if (!file || isUndefined(diagnostic.start)) return { line: 1, column: 1, code: diagnostic.code, message }
  const { line, character } = file.getLineAndCharacterOfPosition(diagnostic.start)
  return { line: line + 1, column: character + 1, code: diagnostic.code, message }
}

/** 按给定的文件名与编译选项查一遍，只留程序自己的诊断——声明是我们生成的，它有问题该在生成那一侧炸。 */
export function diagnoseProgram(
  input: { source: string; declarations: string },
  fileName: string,
  options: ts.CompilerOptions
): CodeProgramDiagnostic[] {
  const files = new Map([
    [DeclarationFileName, input.declarations],
    [fileName, programForCheck(input.source)],
  ])
  const program = ts.createProgram([DeclarationFileName, fileName], options, createMemoryCompilerHost(files, options))
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
    .filter((diagnostic) => diagnostic.file?.fileName === fileName)
    .map(toModelDiagnostic)
}

/** TS8xxx 是「这个语法只能在 TypeScript 文件里用」那一族；只有整份诊断都落在这一族里才算手滑。 */
export function isTypeScriptOnlySyntax(code: number): boolean {
  return code >= 8000 && code < 8100
}

/**
 * 剥掉类型，交出能直接跑的 JavaScript。只走手滑这一条路。
 *
 * 常规路径不转译，所以行号天然对齐；这条路上编译器会重排版，行号对不上，
 * 因此运行期抛错时干脆不报位置——报一个错的位置比不报更坏。
 */
export function stripTypes(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      target: JavaScriptCheckOptions.target,
      module: ts.ModuleKind.ESNext,
      removeComments: false,
    },
    fileName: TypeScriptProgramFileName,
  }).outputText
}
