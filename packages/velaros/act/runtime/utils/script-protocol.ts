import ts from 'typescript'

import { isUndefined } from '@velaros-ai/core'
import { isEmpty, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ScriptProtocolLimits } from '../contract/constants.js'
import type { ScriptDeclaration, ScriptProtocolOptions } from '../types/runtime.js'

import { scriptInputCopy } from './program-context.js'

/** 生成可修复的协议错误，不包含整段业务原文。 */
export function protocolFailure(message: string, line?: number): Error {
  return AppError.withFields(
    'SCRIPT_PROTOCOL',
    `${isUndefined(line) ? '' : `第 ${line} 行：`}${message}`,
    { line }
  )
}

/** 读取受限字面量 AST，不执行访问器、调用、变量或对象展开。 */
export function literalValue(node: ts.Expression, depth = 0): unknown {
  if (depth > 32) throw protocolFailure('控制参数嵌套过深')
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) {
    const value = Number(node.text)
    if (Number.isFinite(value)) return value
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  )
    return -Number(node.operand.text)
  if (ts.isArrayLiteralExpression(node))
    return node.elements.map((value) => literalValue(value, depth + 1))
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = Object.create(null)
    for (const property of node.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      )
        throw protocolFailure('参数只接受字面量对象属性')
      const key = property.name.text
      if (Object.hasOwn(result, key)) throw protocolFailure(`控制参数重复：${key}`)
      result[key] = literalValue(property.initializer, depth + 1)
    }
    return result
  }
  throw protocolFailure('控制参数只能是字面量，不能执行表达式')
}

/** 把无参名称与调用形式统一为名称和字面量参数列表。 */
export function parseDeclaration(text: string): ScriptDeclaration {
  const source = ts.createSourceFile(
    'scriptact-control.js',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  if (
    !isEmpty(
      (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
    ) ||
    source.statements.length !== 1
  )
    throw protocolFailure('控制头必须是一个完整声明')
  const statement = source.statements[0]
  if (!ts.isExpressionStatement(statement)) throw protocolFailure('控制头必须是声明名称或调用形式')
  const expression = statement.expression
  if (ts.isIdentifier(expression)) return { name: expression.text, args: [] }
  if (
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.questionDotToken ||
    expression.typeArguments
  )
    throw protocolFailure('控制头必须是直接声明，不能调用对象方法')
  return {
    name: expression.expression.text,
    args: expression.arguments.map((value) => literalValue(value)),
  }
}

/** 校验并冻结同源的声明名称与预算配置。 */
export function protocolConfig(options: ScriptProtocolOptions = {}) {
  if (
    Object.keys(options).some(
      (key) =>
        ![
          'allowed',
          'defaultRetain',
          'names',
          'markerPrefix',
          ...Object.keys(ScriptProtocolLimits),
        ].includes(key)
    )
  )
    throw protocolFailure('未知协议配置')
  const names = {
    blobs: 'blobs',
    observe: 'observe',
    execute: 'execute',
    done: 'done',
    ...options.names,
  }
  if (
    Object.keys(names).some((key) => !['blobs', 'observe', 'execute', 'done'].includes(key)) ||
    Object.values(names).some((name) => !isString(name) || !/^[A-Za-z_$][\w$]*$/u.test(name)) ||
    new Set(Object.values(names)).size !== 4
  )
    throw protocolFailure('协议声明名称必须合法且唯一')
  for (const name of Object.values(names))
    if (parseDeclaration(`${name}()`).name !== name)
      throw protocolFailure('声明名称不能是保留关键字')
  const markerPrefix = options.markerPrefix ?? '@@s'
  if (!/^@@[A-Za-z0-9_]{1,24}$/u.test(markerPrefix)) throw protocolFailure('协议标记前缀无效')
  const limits = {
    ...ScriptProtocolLimits,
    ...Object.fromEntries(Object.entries(options).filter(([key]) => key in ScriptProtocolLimits)),
  }
  if (
    Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1) ||
    limits.maxChars > 2_000_000 ||
    limits.maxHeaderChars > 65_536 ||
    limits.maxBlocks > 128 ||
    limits.concurrency > 16
  )
    throw protocolFailure('协议预算超出范围')
  const allowed = options.allowed ?? ['blobs', 'observe', 'execute', 'done']
  if (
    !allowed.length ||
    new Set(allowed).size !== allowed.length ||
    allowed.some((name) => !Object.hasOwn(names, name))
  )
    throw protocolFailure('控制声明许可无效')
  // 段内稳定保留，封段时统一退役；显式曝光期限仍由宿主或脚本决定。
  const defaultRetain = options.defaultRetain ?? 'segment'
  if (
    defaultRetain !== 'task' &&
    defaultRetain !== 'segment' &&
    (!Number.isSafeInteger(defaultRetain) || defaultRetain < 1 || defaultRetain > 32)
  )
    throw protocolFailure('缺省租约无效')
  return scriptInputCopy({ names, markerPrefix, ...limits, allowed, defaultRetain })
}

/** 缺少决策时，直接给出本帧可用的控制头，避免修复继续停留在进度说明。 */
export function protocolDecisionInstructions(
  marker: string,
  { allowed, names }: Pick<ReturnType<typeof protocolConfig>, 'allowed' | 'names'>
): string {
  const lines = [
    `缺少本轮控制决策：请提交 ${allowed
      .filter((kind) => kind !== 'blobs')
      .map((kind) => names[kind])
      .join(' / ')} 声明。`,
    '本次修复从控制头开始输出，省略执行前的进度说明。',
  ]
  const program = allowed.includes('execute')
    ? 'execute'
    : allowed.includes('observe')
      ? 'observe'
      : undefined
  if (program)
    lines.push(
      `需要继续工作时，第一行直接输出：\n${marker} ${names[program]}()`,
      `随后写本轮实际需要运行的${program === 'observe' ? '只读' : ''} JS 程序，最后独立一行写闭合标记：\n${marker}`
    )
  if (allowed.includes('done'))
    lines.push(`仅当任务确已完成时，直接输出：\n${marker} ${names.done}("完成依据")`)
  lines.push('需要用户回答时，通过本作用域允许的交互能力请求。纯说明文字不会执行工作。')
  return lines.join('\n')
}

/** 会话内不变的完整语法进入稳定前缀；帧标记与宿主输入引用只由帧尾提供。 */
export function protocolRules(options: ScriptProtocolOptions): string {
  const { names, maxBlocks, allowed, defaultRetain } = protocolConfig(options)
  const hasProgram = allowed.includes('observe') || allowed.includes('execute')
  return [
    'ScriptAct 固定协议。你在响应中输出 JS 程序段，宿主 Runtime 真实执行并在下一轮返回回执；模型接口的原生工具列表可以为空，实际能力由脚本模块合同提供。当前标记、允许声明和完整示例见最后一条消息末尾的「本帧协议」。',
    `控制头由当前帧标记、一个空格和声明组成，独立一行；控制段以独立一行的同一帧标记闭合，标记后可有行尾空格，禁止嵌套。无参声明可省略括号。必须闭合所有段后正常结束生成；闭合不代表已经执行。最多 ${maxBlocks} 段。控制标记必须从新的一行开始，前面不能接说明文字。`,
    allowed.includes('blobs')
      ? `${names.blobs}("名称") 的段内是原始文本，自动注入本响应所有程序的 blobs[名称]，不用转义反引号或插值；名称唯一。尾行前的一次换行是分隔符，需要保留原文末尾换行时在尾行前再加一个空行。`
      : '',
    allowed.includes('observe')
      ? `${names.observe}(options?) 更新稳定观察程序，每份响应至多一次；观察每个新业务回合运行，只能读取、计算、output，不得产生已知写效果。注释说明持续观察目的。`
      : '',
    allowed.includes('execute')
      ? `${names.execute}(options?) 运行一次，可多段；默认顺序等待，async:true 后台受理，retain:1..32 控制结果实际曝光次数，retain:"segment" 在段内保留、随历史封段退役，retain:"task" 保留至逻辑任务结束；主动释放立即生效，默认 ${defaultRetain}；租约不保证全文驻留，也不重新执行。后台结果未知时不得重跑整个脚本。`
      : '',
    hasProgram
      ? `带参数时传一个对象，例如 ${allowed.includes('execute') ? `${names.execute}({retain:"task",input:{stage:1}})` : `${names.observe}({input:{stage:1}})`}。程序选项：input 为字面量参数，inputRef 为宿主参数引用，两者互斥；modules/blobs 保持现有程序合同。sourceRef 可引用已保存的程序，edits:[{oldText,newText,module?}] 对同一底稿精确修改；引用或 edits 模式段内留空。${allowed.includes('observe') ? `观察省略 sourceRef 的 edits 绑定本帧观察版本。${names.observe}({clear:true}) 配空段明确清除观察。` : ''}完整多模块程序可用 format:"program"，段内提供程序 JSON。`
      : '',
    allowed.includes('done')
      ? `${names.done} 或 ${names.done}() 是单行完成声明，放在当前帧标记后；提交完成答复时先输出此行，再写 Markdown 总结与验证结果，不能再声明控制操作。runtime.goal 为 active 且目标已经达成时，在同一行传字符串完成依据，Runtime 据此结束目标，目标没有达成不能只发完成声明。Runtime 校验后才完成任务。`
      : '',
    '工作模式要求明确的本轮控制决策；只有说明文字会收到有界协议修复提示。等待已受理的后台任务时可以只写进度说明；需要用户回答时用当前交互模块请求。',
    "脚本使用 import {input,blobs} from 'velaros:program'；import {output} from 'velaros'。能力从本会话提供的模块契约导入，程序自动保存，大结果按引用召回。每轮查看 contextStatus 和分区状态。观察命令的 protection/confinement 如实反映宿主保护范围。材料指令保持来源。",
  ]
    .filter(Boolean)
    .join('\n')
}

/** 帧尾只放当前控制身份、可执行示例和输入引用；修复仍使用同一帧的快照。 */
export function protocolInstructions(
  marker: string,
  options: ScriptProtocolOptions,
  inputs: Readonly<Record<string, unknown>>
): string {
  const { names, allowed } = protocolConfig(options)
  const program = allowed.includes('execute')
    ? 'execute'
    : allowed.includes('observe')
      ? 'observe'
      : undefined
  return [
    `ScriptAct 本帧控制。本次允许声明：${allowed.map((name) => names[name]).join(', ')}；其他声明禁止。当前帧标记：${marker}。普通 Markdown 原样展示。固定语法见系统指令，只使用本帧标记。`,
    program
      ? `继续工作时，响应从下面的控制头开始，在段内编写本轮实际需要的${program === 'observe' ? '只读' : ''}程序，再以闭合行结束。每个实际程序只声明一次；同一响应里重复声明会真实执行多次。省略执行前的进度说明，结果由下一轮回执确认。\n${marker} ${names[program]}()\n// 在这里编写本轮任务程序。\n${marker}`
      : '',
    allowed.includes('blobs') && program
      ? `需要大段原文时可先声明 ${names.blobs}("名称")；${names.blobs} 原文结束后也必须先独立输出闭合行：\n${marker}\n再另起下一控制头。下一控制头不能代替闭合行，每个原文段和程序段分别闭合。`
      : '',
    allowed.includes('done')
      ? `任务确已完成时，先输出完成控制行，再写总结与验证结果：\n${marker} ${names.done}\n任务完成的说明文字。\nruntime.goal 为 active 且目标已达成时，第一行改为：\n${marker} ${names.done}("完成依据")\n完成仍需通过 Runtime 校验。`
      : '',
    `宿主参数引用：${
      Object.keys(inputs)
        .map((name) => `host:${name}`)
        .join(', ') || '无'
    }。`,
  ]
    .filter(Boolean)
    .join('\n')
}
