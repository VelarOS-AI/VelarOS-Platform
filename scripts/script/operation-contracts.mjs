import ts from 'typescript'

import { scriptContractCompiler } from '@velaros-ai/script'

/** 内置与 Skill 能力使用同一 TypeScript 类型转换。 */
export function operationSchema(checker, root) {
  return scriptContractCompiler.schema(checker, root)
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
  return scriptContractCompiler.inputSchema(checker, parameter)
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
