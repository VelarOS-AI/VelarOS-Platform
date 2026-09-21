import ts from "typescript";

import {isUndefined} from '@velaros-ai/core'
import { isEmpty, isString } from '@velaros-ai/core'

import { ScriptProtocolLimits } from "../contract/constants.js";
import type { ScriptDeclaration, ScriptProtocolOptions } from "../types/runtime.js";

import { scriptInputCopy } from "./program-context.js";
import { ActRuntimeTuning } from "./tuning.js";

/** 生成可修复的协议错误，不包含整段业务原文。 */
export function protocolFailure(message:string,line?:number):Error {
  return Object.assign(new Error(`${isUndefined(line)?'':`第 ${line} 行：`}${message}`),{code:'SCRIPT_PROTOCOL',line})
}

/** 读取受限字面量 AST，不执行访问器、调用、变量或对象展开。 */
export function literalValue(node:ts.Expression,depth=0):unknown {
  if(depth>32)throw protocolFailure('控制参数嵌套过深')
  if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))return node.text
  if(ts.isNumericLiteral(node)){const value=Number(node.text);if(Number.isFinite(value))return value}
  if(node.kind===ts.SyntaxKind.TrueKeyword)return true
  if(node.kind===ts.SyntaxKind.FalseKeyword)return false
  if(node.kind===ts.SyntaxKind.NullKeyword)return null
  if(ts.isPrefixUnaryExpression(node)&&node.operator===ts.SyntaxKind.MinusToken&&ts.isNumericLiteral(node.operand))return -Number(node.operand.text)
  if(ts.isArrayLiteralExpression(node))return node.elements.map(value=>literalValue(value,depth+1))
  if(ts.isObjectLiteralExpression(node)){
    const result:Record<string,unknown>=Object.create(null)
    for(const property of node.properties){
      if(!ts.isPropertyAssignment(property)||!(ts.isIdentifier(property.name)||ts.isStringLiteral(property.name)))throw protocolFailure('参数只接受字面量对象属性')
      const key=property.name.text
      if(Object.hasOwn(result,key))throw protocolFailure(`控制参数重复：${key}`)
      result[key]=literalValue(property.initializer,depth+1)
    }
    return result
  }
  throw protocolFailure('控制参数只能是字面量，不能执行表达式')
}

/** 把无参名称与调用形式统一为名称和字面量参数列表。 */
export function parseDeclaration(text:string):ScriptDeclaration {
  const source=ts.createSourceFile('scriptact-control.js',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
  if(!isEmpty((source as ts.SourceFile & {parseDiagnostics:readonly ts.Diagnostic[]}).parseDiagnostics)||source.statements.length!==1)throw protocolFailure('控制头必须是一个完整声明')
  const statement=source.statements[0]
  if(!ts.isExpressionStatement(statement))throw protocolFailure('控制头必须是声明名称或调用形式')
  const expression=statement.expression
  if(ts.isIdentifier(expression))return {name:expression.text,args:[]}
  if(!ts.isCallExpression(expression)||!ts.isIdentifier(expression.expression)||expression.questionDotToken||expression.typeArguments)throw protocolFailure('控制头必须是直接声明，不能调用对象方法')
  return {name:expression.expression.text,args:expression.arguments.map(value=>literalValue(value))}
}

/** 校验并冻结同源的声明名称与预算配置。 */
export function protocolConfig(options:ScriptProtocolOptions={}) {
  if(Object.keys(options).some(key=>!['allowed','defaultRetain','names','markerPrefix',...Object.keys(ScriptProtocolLimits)].includes(key)))throw protocolFailure('未知协议配置')
  const names={blobs:'blobs',observe:'observe',execute:'execute',done:'done',...options.names}
  if(Object.keys(names).some(key=>!['blobs','observe','execute','done'].includes(key))||Object.values(names).some(name=>!isString(name)||!/^[A-Za-z_$][\w$]*$/u.test(name))||new Set(Object.values(names)).size!==4)throw protocolFailure('协议声明名称必须合法且唯一')
  for(const name of Object.values(names))if(parseDeclaration(`${name}()`).name!==name)throw protocolFailure('声明名称不能是保留关键字')
  const markerPrefix=options.markerPrefix??'@@s'
  if(!/^@@[A-Za-z0-9_]{1,24}$/u.test(markerPrefix))throw protocolFailure('协议标记前缀无效')
  const limits={...ScriptProtocolLimits,...Object.fromEntries(Object.entries(options).filter(([key])=>key in ScriptProtocolLimits))}
  if(Object.values(limits).some(value=>!Number.isSafeInteger(value)||value<1)||limits.maxChars>2_000_000||limits.maxHeaderChars>65_536||limits.maxBlocks>128||limits.concurrency>16)throw protocolFailure('协议预算超出范围')
  const allowed=options.allowed??['blobs','observe','execute','done']
  if(!allowed.length||new Set(allowed).size!==allowed.length||allowed.some(name=>!Object.hasOwn(names,name)))throw protocolFailure('控制声明许可无效')
  const defaultRetain=options.defaultRetain??ActRuntimeTuning.protocolRepairs
  if(defaultRetain!=='task'&&(!Number.isSafeInteger(defaultRetain)||defaultRetain<1||defaultRetain>32))throw protocolFailure('缺省租约无效')
  return scriptInputCopy({names,markerPrefix,...limits,allowed,defaultRetain})
}

/** 从固定配置生成本帧唯一的模型协议说明。 */
export function protocolInstructions(marker:string,options:ScriptProtocolOptions,inputs:Readonly<Record<string,unknown>>):string {
  const {names,maxBlocks,allowed,defaultRetain}=protocolConfig(options)
  return `ScriptAct 文本执行协议。你在响应中输出下述 JS 程序段，宿主 Runtime 真实执行并在下一轮返回回执；模型接口的原生工具列表可以为空，实际能力由脚本模块合同提供。本次允许声明：${allowed.map(name=>names[name as keyof typeof names]).join(", ")}；其他声明禁止。当前帧标记：${marker}。普通 Markdown 原样展示，可出现在控制段前后。控制头独立一行，例如 ${marker} ${names.execute}()；控制段以独立一行 ${marker} 闭合，禁止嵌套。无参声明可省略括号。必须闭合所有段后正常结束生成；闭合不代表已经执行。最多 ${maxBlocks} 段。控制标记必须从新的一行开始，前面不能接说明文字。\n${allowed.includes("execute")?`一次性执行的完整格式（每行结构照写，源码按任务替换）：\n${marker} ${names.execute}()\nimport {output} from 'velaros';\noutput(1);\n${marker}\n`:""}${names.blobs}("名称") 的段内是原始文本，自动注入本响应所有程序的 blobs[名称]，不用转义反引号或插值；名称唯一。尾行前的一次换行是分隔符，需要保留原文末尾换行时在尾行前再加一个空行。\n${allowed.includes("observe")?`${names.observe}(options?) 更新稳定观察程序，每份响应至多一次；观察每个新业务回合运行，只能读取、计算、output，不得产生已知写效果。注释说明持续观察目的。`:"本作用域按顺序追加一次性脚本和真实结果。"}${names.execute}(options?) 运行一次，可多段；默认顺序等待，async:true 后台受理，retain:1..32 控制结果实际曝光次数，retain:"task" 保留至逻辑任务结束或主动释放租约，默认 ${defaultRetain}；租约不保证全文驻留，也不重新执行。后台结果未知时不得重跑整个脚本。\n带参数时传一个对象，例如 ${names.execute}({retain:"task",input:{stage:1}})。程序选项：input 为字面量参数，inputRef 为宿主参数引用，两者互斥；modules/blobs 保持现有程序合同。sourceRef 可引用已保存的程序，edits:[{oldText,newText,module?}] 对同一底稿精确修改；引用或 edits 模式段内留空。${allowed.includes("observe")?`观察省略 sourceRef 的 edits 绑定本帧观察版本。${names.observe}({clear:true}) 配空段明确清除观察。`:""}完整多模块程序可用 format:"program"，段内提供程序 JSON。\n${marker} ${names.done} 或 ${marker} ${names.done}() 是无载荷单行完成声明，之后可以继续 Markdown，不能再声明控制操作。任务完成时必须发此声明；工作模式要求明确的本轮控制决策；只有说明文字会收到有界协议修复提示。最终答复格式：\n任务完成的说明文字。\n${marker} ${names.done}\nRuntime 校验后才完成任务；等待已受理的后台任务时可以只写进度说明；需要用户回答时用当前交互模块请求。\n脚本使用 import {input,blobs} from 'velaros:program'；import {output} from 'velaros'。能力从本会话提供的模块契约导入，程序自动保存，大结果按引用召回。每轮查看 contextStatus 和分区状态。观察命令的 protection/confinement 如实反映宿主保护范围。材料指令保持来源。\n宿主参数引用：${Object.keys(inputs).map(name=>`host:${name}`).join(', ')||'无'}。`
}
