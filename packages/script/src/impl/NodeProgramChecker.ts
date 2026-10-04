import ts from 'typescript'

import { isEmpty } from '@velaros-ai/core'

import type { CodeProgramCheckResult, GrantedModule } from '../types/script.js'
import { rejectWithDiagnostics } from '../utils/budget.js'

import type { CodeProgramCheckerApi } from './CodeProgramChecker.js'

/** 标准 JS 语法检查遵守共享程序检查合同。 */
export interface NodeProgramCheckerApi extends CodeProgramCheckerApi {}

/** 真实 Node 负责链接和运行；这里只检查本轮 JS 语法。 */
class NodeProgramChecker implements NodeProgramCheckerApi {
  public check(input: {
    source: string
    granted: readonly GrantedModule[]
    modules?: Readonly<Record<string, string>>
  }): CodeProgramCheckResult {
    const file = ts.createSourceFile(
      'program.js',
      input.source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    )
    const program = ts.createProgram(
      ['program.js'],
      {
        allowJs: true,
        noLib: true,
        noResolve: true,
        noEmit: true,
        target: ts.ScriptTarget.Latest,
        module: ts.ModuleKind.ESNext,
      },
      {
        getSourceFile: (name) => (name === 'program.js' ? file : undefined),
        getDefaultLibFileName: () => '',
        writeFile: () => {},
        getCurrentDirectory: () => '/',
        getCanonicalFileName: (name) => name,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
        fileExists: (name) => name === 'program.js',
        readFile: (name) => (name === 'program.js' ? input.source : undefined),
      }
    )
    const diagnostics = program.getSyntacticDiagnostics(file).map((diagnostic) => {
      const point = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
      return {
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        line: point.line + 1,
        column: point.character + 1,
      }
    })
    if (!isEmpty(Object.keys(input.modules ?? {})))
      diagnostics.push({
        code: 90001,
        message: '将可复用模块保存为工作目录中的普通文件，并使用 Node import。',
        line: 1,
        column: 1,
      })
    return !isEmpty(diagnostics) ? rejectWithDiagnostics(diagnostics) : { ok: true }
  }

  public missingModules(): string[] {
    return []
  }

  public typecheck(input: {
    source: string
    granted: readonly GrantedModule[]
  }): CodeProgramCheckResult {
    return this.check(input)
  }
}

/** Node 入口复用的无副作用语法检查器。 */
export const nodeProgramChecker: CodeProgramCheckerApi = new NodeProgramChecker()
