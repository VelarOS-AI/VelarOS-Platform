/**
 * 编译器那一侧的活：内存文件系统、诊断换算、按 JavaScript 或 TypeScript 各查一遍、剥类型。
 * 全是纯函数，所以不放在类里；`CodeProgramChecker` 只负责按什么顺序用它们。
 */

import ts from 'typescript'

import type { CodeProgramDiagnostic } from '../types/code-surface.js'

import { wrapProgramSource } from './program.js'

/** 生成出来的能力声明在内存文件系统里的名字。 */
export const DeclarationFileName = '/velar.d.ts'

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
      if (text === undefined) return defaultHost.getSourceFile(name, languageVersion, onError)
      return ts.createSourceFile(name, text, languageVersion, true)
    },
    writeFile: () => {},
  }
}

/** 把一条 TS 诊断换算成模型面的形状：包装只占第一行，所以 0 基行号正好是模型写的行号（从 1 起）。 */
export function toModelDiagnostic(diagnostic: ts.Diagnostic): CodeProgramDiagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
  const file = diagnostic.file
  if (!file || diagnostic.start === undefined) return { line: 1, column: 1, code: diagnostic.code, message }
  const { line, character } = file.getLineAndCharacterOfPosition(diagnostic.start)
  return { line: Math.max(1, line), column: character + 1, code: diagnostic.code, message }
}

/** 按给定的文件名与编译选项查一遍，只留程序自己的诊断——声明是我们生成的，它有问题该在生成那一侧炸。 */
export function diagnoseProgram(
  input: { source: string; declarations: string },
  fileName: string,
  options: ts.CompilerOptions
): CodeProgramDiagnostic[] {
  const files = new Map([
    [DeclarationFileName, input.declarations],
    [fileName, wrapProgramSource(input.source)],
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
