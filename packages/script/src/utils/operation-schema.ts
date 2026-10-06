import ts from 'typescript'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { OperationSchema } from '@velaros-ai/kernel'

/** 将真实 TypeScript 数据类型映射为 Kernel 校验合同，递归对象共享局部 definitions。 */
export function operationTypeSchema(checker: ts.TypeChecker, root: ts.Type): OperationSchema {
  const definitions: Record<string, OperationSchema> = Object.create(null)
  const names = new Map<ts.Type, string>()
  const encode = (type: ts.Type): OperationSchema => {
    const flags = type.flags
    if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {}
    if (flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null))
      return { type: 'null' }
    if (flags & (ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.TypeParameter))
      throw new AppError('VALIDATION', `能力合同需要具体 JSON 类型：${checker.typeToString(type)}`)
    if (flags & ts.TypeFlags.Never) return { not: {} }
    if (type.isStringLiteral() || type.isNumberLiteral()) return { const: type.value }
    if (flags & ts.TypeFlags.BooleanLiteral) return { const: checker.typeToString(type) === 'true' }
    if (flags & ts.TypeFlags.StringLike) return { type: 'string' }
    if (flags & ts.TypeFlags.NumberLike) return { type: 'number' }
    if (flags & ts.TypeFlags.Boolean) return { type: 'boolean' }
    if (type.isUnion()) {
      const branches = type.types
        .filter((item) => !(item.flags & ts.TypeFlags.Undefined))
        .map(encode)
      return branches.length === 1
        ? branches[0]!
        : !isEmpty(branches)
          ? { anyOf: branches }
          : { type: 'null' }
    }
    if (names.has(type)) return { $ref: `#/definitions/${names.get(type)}` }
    const name = `T${names.size + 1}`
    names.set(type, name)
    definitions[name] = {}
    let schema: OperationSchema
    if (checker.isTupleType(type)) {
      const args = checker.getTypeArguments(type as ts.TypeReference)
      const elements = ((type as ts.TypeReference).target as ts.TupleType).elementFlags
      if (elements.some((flag) => flag & ts.ElementFlags.Rest))
        throw new AppError('VALIDATION', `能力合同不接受 rest tuple：${checker.typeToString(type)}`)
      const required = elements.filter((flag) => flag & ts.ElementFlags.Required).length
      const shapes: OperationSchema[] = Array.from(
        { length: args.length - required + 1 },
        (_, index) => {
          const length = required + index
          return length
            ? {
                type: 'array',
                items: args.slice(0, length).map(encode),
                minItems: length,
                maxItems: length,
                additionalItems: false,
              }
            : { type: 'array', maxItems: 0 }
        }
      )
      schema = shapes.length === 1 ? shapes[0]! : { anyOf: shapes }
    } else if (checker.isArrayType(type) || type.symbol?.name === 'ReadonlyArray') {
      schema = {
        type: 'array',
        items: encode(checker.getTypeArguments(type as ts.TypeReference)[0]!),
      }
    } else {
      if (type.getCallSignatures().length || type.getConstructSignatures().length)
        throw new AppError('VALIDATION', `能力数据不能包含函数：${checker.typeToString(type)}`)
      const properties: Record<string, OperationSchema> = Object.create(null)
      const required: string[] = []
      for (const property of checker.getPropertiesOfType(type)) {
        const declaration = property.valueDeclaration ?? property.declarations?.[0]
        if (!declaration) throw new AppError('VALIDATION', `能力字段缺少类型声明：${property.name}`)
        properties[property.name] = encode(checker.getTypeOfSymbolAtLocation(property, declaration))
        if (!(property.flags & ts.SymbolFlags.Optional)) required.push(property.name)
      }
      const index =
        checker.getIndexTypeOfType(type, ts.IndexKind.String) ??
        checker.getIndexTypeOfType(type, ts.IndexKind.Number)
      schema = {
        type: 'object',
        properties,
        required,
        additionalProperties: index ? encode(index) : false,
      }
    }
    definitions[name] = schema
    return { $ref: `#/definitions/${name}` }
  }
  const schema = encode(root)
  return !isEmpty(Object.keys(definitions)) ? { ...schema, definitions } : schema
}
