import ts from 'typescript'

/** 同一 TypeScript 类型生成 draft-07 数据校验，递归数据使用局部 definitions。 */
export function operationSchema(checker, root) {
  const definitions = {}
  const names = new Map()
  const encode = (type) => {
    const flags = type.flags
    if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {}
    if (flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null))
      return { type: 'null' }
    if (flags & (ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.TypeParameter))
      throw new Error(`模型契约不是具体 JSON 类型：${checker.typeToString(type)}`)
    if (flags & ts.TypeFlags.Never) return { not: {} }
    if (type.isStringLiteral?.() || type.isNumberLiteral?.()) return { const: type.value }
    if (flags & ts.TypeFlags.BooleanLiteral) return { const: type.intrinsicName === 'true' }
    if (flags & ts.TypeFlags.StringLike) return { type: 'string' }
    if (flags & ts.TypeFlags.NumberLike) return { type: 'number' }
    if (flags & ts.TypeFlags.Boolean) return { type: 'boolean' }
    if (type.isUnion?.()) {
      const branches = type.types
        .filter((item) => !(item.flags & ts.TypeFlags.Undefined))
        .map(encode)
      return branches.length === 1
        ? branches[0]
        : branches.length
          ? { anyOf: branches }
          : { type: 'null' }
    }
    if (names.has(type)) return { $ref: `#/definitions/${names.get(type)}` }
    const name = `T${names.size + 1}`
    names.set(type, name)
    definitions[name] = {}
    let schema
    if (checker.isTupleType(type)) {
      const args = checker.getTypeArguments(type)
      const flags = type.target.elementFlags
      if (flags.some((flag) => flag & ts.ElementFlags.Rest))
        throw new Error(`模型契约暂不支持 rest tuple：${checker.typeToString(type)}`)
      const required = flags.filter((flag) => flag & ts.ElementFlags.Required).length
      const shapes = Array.from({ length: args.length - required + 1 }, (_, index) => {
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
      })
      schema = shapes.length === 1 ? shapes[0] : { anyOf: shapes }
    } else if (checker.isArrayType(type) || type.symbol?.name === 'ReadonlyArray') {
      schema = { type: 'array', items: encode(checker.getTypeArguments(type)[0]) }
    } else {
      if (type.getCallSignatures().length || type.getConstructSignatures().length)
        throw new Error(`模型数据含函数：${checker.typeToString(type)}`)
      const properties = {},
        required = []
      for (const property of checker.getPropertiesOfType(type)) {
        const declaration = property.valueDeclaration ?? property.declarations?.[0]
        if (!declaration) throw new Error(`模型字段缺少类型位置：${property.name}`)
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
  return Object.keys(definitions).length ? { ...schema, definitions } : schema
}

/**
 * 方法说明里写给模型的那段：标记之后的正文，去掉注释符号与登记标记，逐行收尾空白、不留空行。
 * 结尾那行 ` *\/` 要整个去掉：先按行首的星号切会留下孤零零的 `/`，它曾经跟着每条摘要进了模块描述。
 */
function operationSummary(docs) {
  const lines = docs
    .slice(Math.max(docs.lastIndexOf('/**'), 0))
    .replace(/\/\*\*|\*\//gu, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*?/u, ''))
  const at = lines.findIndex((line) => /@AgentView\b/u.test(line))
  return lines
    .slice(Math.max(at, 0))
    .map((line) =>
      line.replace(/@AgentView\b|@OperationEffect\s+\w+|@OperationModes\s+\w+/gu, '').trim()
    )
    .filter(Boolean)
    .join('\n')
}

/**
 * 入参的 schema。写成 `input: Optional<X>` 的可以不给：模型不传参数时送来的是 null，所以同时收 null；
 * 递归类型的 definitions 留在根上，`$ref` 才找得到。
 */
function inputSchema(checker, parameter) {
  const type = checker.getTypeAtLocation(parameter)
  const schema = operationSchema(checker, type)
  if (!type.isUnion?.() || !type.types.some((member) => member.flags & ts.TypeFlags.Undefined))
    return schema
  const { definitions, ...value } = schema
  return definitions
    ? { anyOf: [{ type: 'null' }, value], definitions }
    : { anyOf: [{ type: 'null' }, value] }
}

/**
 * 每个操作显式声明世界效果，宿主上下文参数只由装配器注入。
 * `@OperationModes execute` 标出只许在一次性执行入口调用的操作（观察脚本每轮重跑，不该碰它）；不标就不限入口，写操作另由 Kernel 挡在观察入口外。
 */
export function operationContract(program, member, file, hostTypes) {
  const checker = program.getTypeChecker()
  const host = (parameter) =>
    parameter.type &&
    ts.isTypeReferenceNode(parameter.type) &&
    ts.isIdentifier(parameter.type.typeName) &&
    hostTypes.has(parameter.type.typeName.text)
  const inputs = member.parameters.filter((parameter) => !host(parameter))
  if (
    inputs.length > 1 ||
    member.parameters.filter(host).length !== 1 ||
    !host(member.parameters.at(-1))
  )
    throw new Error(`操作必须是 (input, context) 或 (context)：${member.name.text}`)
  const docs = file.text.slice(member.getFullStart(), member.getStart(file))
  const effect = docs.match(/@OperationEffect\s+(none|write)\b/u)?.[1]
  if (!effect) throw new Error(`${member.name.text} 缺少 @OperationEffect none|write`)
  const modes = docs.match(/@OperationModes\s+(\w+)/u)?.[1]
  if (modes && modes !== 'execute')
    throw new Error(`${member.name.text} 的 @OperationModes 只接受 execute`)
  const signature = checker.getSignatureFromDeclaration(member)
  const result = checker.getReturnTypeOfSignature(signature)
  const output = checker.getPromisedTypeOfPromise(result) ?? result
  const contract = {
    summary: operationSummary(docs),
    input: inputs.length ? inputSchema(checker, inputs[0]) : { type: 'null' },
    output: operationSchema(checker, output),
    effects: effect,
    hasInput: inputs.length === 1,
  }
  if (modes) contract.allowedModes = ['execute']
  return contract
}
