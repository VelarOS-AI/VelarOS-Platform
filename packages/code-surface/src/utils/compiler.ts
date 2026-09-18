/**
 * 编译器那一侧的活：内存文件系统、诊断换算、按 JavaScript 或 TypeScript 各查一遍、剥类型。
 * 全是纯函数，所以不放在类里；`CodeProgramChecker` 只负责按什么顺序用它们。
 */

import ts from 'typescript'

import { isUndefined } from '@velaros-ai/core'

import type { CodeProgramDiagnostic } from '../types/code-surface.js'

import { programForCheck, ProgramModuleSpecifier } from './program.js'

/** 生成出来的能力声明在内存文件系统里的名字。 */
export const DeclarationFileName = '/velar.d.ts'

/** 检查时脚本库在内存文件系统里的根目录：库里的 `lib/x.js` 就是 `/scripts/lib/x.js`，相对 import 照常解析。 */
export const LibraryRoot = '/scripts'

/** 直接跑的代码在库根上用的文件名：以点开头，库里的脚本不许这样起名，所以撞不上。 */
export const AnonymousProgramFile = '.program.js'

/**
 * 恒常可用的那个模块：这次运行本身——随程序交来的参数与大段文本，与各能力模块的代码模版。
 *
 * **我们发明的东西要导入，语言自带的不动**——`blobs`、`template` 是我们发明的，做成隐形全局等于让模型背一条只有提示词告诉过它的暗知识；
 * `console` 是 JavaScript 自带的，让模型 `import { console }` 才是真的怪。这个模块永远在常驻档，不需要租约、不占授权名额。
 * 这一段也是给模型看的：门的说明里原样放着它（`describeGate`），检查器按它推类型——两边同一份。
 */
export const ProgramModuleDeclarations = `declare module '${ProgramModuleSpecifier}' {
  /** 随程序一起交来的大段文本，按名字取。文件正文、补丁放这里，不写进源码——写进源码要过好几层转义。 */
  export const blobs: Record<string, string>

  /** 这一次的参数：script:exec 里 run 这一步给的 input（任意 JSON 值），没给是 undefined。 */
  export const input: any

  /**
   * 一个能力模块的代码模版：日常最常用的几种写法，一段一个函数，展示这个模块的几件能力怎么组合。
   * 只是示例，按你的需要改写，不必照着写。拿不准怎么写时先读它：\`export default template('velar:shell')\`。模块名写错时抛错，并列出这个空间有哪些。
   */
  export function template(module: string): string
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

/** 手滑写成 TypeScript 时剥类型用的那份文件名；换个后缀编译器才会按 TS 解析。 */
export const TypeScriptProgramFileName = '/program.ts'

/** 检查时交上来的这份程序在内存文件系统里叫什么：库里的脚本在库里它自己的位置，直接跑的代码在库根上；按 TypeScript 查时换成 .ts。 */
export function checkedProgramFile(path: Optional<string>, typescript: boolean): string {
  const file = `${LibraryRoot}/${path ?? AnonymousProgramFile}`
  return typescript ? file.replace(/\.js$/u, '.ts') : file
}

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
  // 程序是普通 JS：自己写的小函数、JSON.parse 出来的数据上的回调不带类型是常态，逼着写注解只会让一段对的程序一行都不执行。
  // 要拦的是用错能力——能力的返回值都有声明，字段写错、入参形状错照样拦得住。
  noImplicitAny: false,
  // 不让程序看见 @types/*：模型只该看见我们给的声明，多一个环境类型就多一条它以为能用的路。
  types: [],
})

/** 手滑那条路上用的选项：同一套严格度，只是按 TypeScript 解析。 */
export const TypeScriptCheckOptions: ts.CompilerOptions = Object.freeze({
  ...JavaScriptCheckOptions,
  allowJs: false,
  checkJs: false,
})

/**
 * 内存文件系统：认得传进来的这几份（连同它们所在的目录，脚本库的相对 import 要靠它解析），其余交给默认 host（它要去读 lib.*.d.ts）。
 * 程序因此不必落盘。
 */
export function createMemoryCompilerHost(
  files: ReadonlyMap<string, string>,
  options: ts.CompilerOptions
): ts.CompilerHost {
  const defaultHost = ts.createCompilerHost(options, true)
  const directories = new Set<string>()
  for (const name of files.keys()) {
    for (let index = name.lastIndexOf('/'); index > 0; index = name.lastIndexOf('/', index - 1)) directories.add(name.slice(0, index))
  }
  return {
    ...defaultHost,
    fileExists: (name) => files.has(name) || defaultHost.fileExists(name),
    directoryExists: (name) => directories.has(name.replace(/\/+$/u, '')) || !!defaultHost.directoryExists?.(name),
    realpath: (name) => (files.has(name) || directories.has(name) ? name : defaultHost.realpath?.(name) ?? name),
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
 * 把一条 TS 诊断换算成模型面的形状；出在库里别的脚本上时带上它在库里的路径。
 *
 * **程序不包装**（它本来就是个模块），所以编译器给的 0 基行号要加一才是模型写的那一行。
 * 早先用「函数体 + 包装」时包装恰好占掉第 0 行，两者数值相等——那是巧合，形态一改就错一位。
 */
export function toModelDiagnostic(diagnostic: ts.Diagnostic, mainFile: string): CodeProgramDiagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
  const file = diagnostic.file
  if (!file || isUndefined(diagnostic.start)) return { line: 1, column: 1, code: diagnostic.code, message }
  const { line, character } = file.getLineAndCharacterOfPosition(diagnostic.start)
  const shaped: CodeProgramDiagnostic = { line: line + 1, column: character + 1, code: diagnostic.code, message }
  if (file.fileName !== mainFile) shaped.file = file.fileName.slice(LibraryRoot.length + 1)
  return shaped
}

/**
 * 按给定的文件名与编译选项查一遍：交上来的这份放在 fileName，它会 import 到的库里的脚本放在库根下各自的位置。
 * 只留脚本自己的诊断（交上来的这份与库里的脚本）——声明是我们生成的，它有问题该在生成那一侧炸。
 */
export function diagnoseProgram(
  input: { source: string; declarations: string; modules?: Readonly<Record<string, string>> },
  fileName: string,
  options: ts.CompilerOptions
): CodeProgramDiagnostic[] {
  const files = new Map([
    [DeclarationFileName, input.declarations],
    [fileName, programForCheck(input.source)],
  ])
  for (const [path, source] of Object.entries(input.modules ?? {})) {
    const file = `${LibraryRoot}/${path}`
    if (!files.has(file)) files.set(file, source)
  }
  const program = ts.createProgram([DeclarationFileName, fileName], options, createMemoryCompilerHost(files, options))
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
    .filter((diagnostic) => diagnostic.file?.fileName === fileName || Boolean(diagnostic.file?.fileName.startsWith(`${LibraryRoot}/`)))
    .map((diagnostic) => toModelDiagnostic(diagnostic, fileName))
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
