import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import ts from 'typescript'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { OperationSchema, OperationSurface } from '@velaros-ai/kernel'

import type { ScriptCompiledContract } from '../types/compiler.js'
import { operationTypeSchema } from '../utils/operation-schema.js'

/** 外部能力和内置生成器共用 TypeScript 合同解释。 */
export interface ScriptContractCompilerApi {
  /** 编译自包含的 .d.ts，不执行任何包源码或导入第三方声明。 */
  compile(source: string, specifier: string): ScriptCompiledContract
  /** 内置能力生成器使用同一类型到 JSON Schema 的转换。 */
  schema(checker: ts.TypeChecker, type: ts.Type): OperationSchema
  /** 省略的 JSON 输入以 null 传输，递归 definitions 保留在根。 */
  inputSchema(checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): OperationSchema
}

/** 宿主调用协议从函数签名和效果注释派生，模型与执行器共用一份合同。 */
class ScriptContractCompiler implements ScriptContractCompilerApi {
  public schema(checker: ts.TypeChecker, type: ts.Type): OperationSchema {
    return operationTypeSchema(checker, type)
  }

  public inputSchema(checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): OperationSchema {
    const type = checker.getTypeAtLocation(parameter)
    const schema = this.schema(checker, type)
    if (!type.isUnion() || !type.types.some((member) => member.flags & ts.TypeFlags.Undefined))
      return schema
    const { definitions, ...value } = schema
    return { anyOf: [{ type: 'null' }, value], definitions }
  }

  public compile(source: string, specifier: string): ScriptCompiledContract {
    const path = resolve('skill-contract.d.ts')
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
    for (const statement of file.statements)
      if (
        !ts.isFunctionDeclaration(statement) &&
        !ts.isInterfaceDeclaration(statement) &&
        !ts.isTypeAliasDeclaration(statement)
      )
        throw new AppError('VALIDATION', 'Skill 能力声明只接受自包含的函数、接口和类型')
    if (
      !isEmpty(file.referencedFiles) ||
      !isEmpty(file.typeReferenceDirectives) ||
      !isEmpty(file.libReferenceDirectives)
    )
      throw new AppError('VALIDATION', 'Skill 能力声明必须自包含')
    const checkSelfContained = (node: ts.Node): void => {
      if (ts.isImportTypeNode(node))
        throw new AppError('VALIDATION', 'Skill 能力声明不能导入外部类型')
      ts.forEachChild(node, checkSelfContained)
    }
    checkSelfContained(file)
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      strict: true,
      types: [],
      noEmit: true,
      skipLibCheck: false,
    }
    const host = ts.createCompilerHost(options)
    const getSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
      name === path
        ? file
        : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile)
    const program = ts.createProgram([path], options, host)
    const diagnostics = [
      ...program.getSyntacticDiagnostics(file),
      ...program.getSemanticDiagnostics(file),
    ]
    if (!isEmpty(diagnostics))
      throw new AppError(
        'VALIDATION',
        ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, '\n')
      )
    const checker = program.getTypeChecker()
    const operations: Record<string, OperationSurface['operations'][string]> = Object.create(null)
    const optionalInputs: string[] = []
    for (const statement of file.statements) {
      if (!ts.isFunctionDeclaration(statement)) continue
      if (
        !statement.name ||
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ||
        !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      )
        throw new AppError('VALIDATION', 'Skill 操作需要具名导出')
      const name = statement.name.text
      if (Object.hasOwn(operations, name))
        throw new AppError('CONFLICT', `Skill 操作不接受重载：${name}`)
      if (
        statement.parameters.length > 1 ||
        statement.parameters.some((parameter) => parameter.dotDotDotToken)
      )
        throw new AppError('VALIDATION', `${name} 需要零个参数或一个 JSON 输入参数`)
      const tags = ts.getJSDocTags(statement)
      const effect = tags.find((tag) => tag.tagName.text === 'OperationEffect')?.comment
      if (effect !== 'none' && effect !== 'write')
        throw new AppError('VALIDATION', `${name} 需要 @OperationEffect none 或 write`)
      const mode = tags.find((tag) => tag.tagName.text === 'OperationModes')?.comment
      if (mode && mode !== 'execute')
        throw new AppError('VALIDATION', `${name} 的 @OperationModes 只接受 execute`)
      const signature = checker.getSignatureFromDeclaration(statement)!
      const result = checker.getReturnTypeOfSignature(signature)
      const output = checker.getAwaitedType(result) ?? result
      const parameter = statement.parameters[0]
      if (parameter) {
        const type = checker.getTypeAtLocation(parameter)
        if (
          parameter.questionToken ||
          (type.isUnion() && type.types.some((member) => member.flags & ts.TypeFlags.Undefined))
        )
          optionalInputs.push(name)
      }
      const input = parameter ? this.inputSchema(checker, parameter) : { type: 'null' as const }
      operations[name] = {
        summary: ts.displayPartsToString(signature.getDocumentationComment(checker)),
        input,
        output: this.schema(checker, output),
        effects: effect,
        hasInput: Boolean(parameter),
        allowedModes: mode ? ['execute'] : undefined,
      }
    }
    const methods = Object.keys(operations)
    if (isEmpty(methods)) throw new AppError('VALIDATION', 'Skill 能力声明至少需要一个导出函数')
    const printer = ts.createPrinter()
    const body = file.statements
      .map((statement) => {
        const node = ts.isFunctionDeclaration(statement)
          ? ts.factory.updateFunctionDeclaration(
              statement,
              statement.modifiers?.filter(
                (modifier) => modifier.kind !== ts.SyntaxKind.DeclareKeyword
              ),
              statement.asteriskToken,
              statement.name,
              statement.typeParameters,
              statement.parameters,
              statement.type,
              statement.body
            )
          : statement
        return printer.printNode(ts.EmitHint.Unspecified, node, file)
      })
      .join('\n')
    return {
      specifier,
      optionalInputs,
      namespace: specifier,
      methods,
      declarations: `declare module ${JSON.stringify(specifier)} {\n${body}\n}\n`,
      template: `import * as capability from ${JSON.stringify(specifier)};`,
      revision: createHash('sha256').update(source).digest('hex'),
      operations,
    }
  }
}

/** 合同编译不持有会话状态，可以跨安装共享。 */
export const scriptContractCompiler: ScriptContractCompilerApi = new ScriptContractCompiler()
