import ts from 'typescript'

import {Log} from '@velaros-ai/core'
import {isUndefined} from '@velaros-ai/core'
import { isArray, isObject } from '@velaros-ai/core'

import { ScriptOutputLimits } from '../contract/constants.js'
import type { ScriptOutputConfig, ScriptOutputEdit, ScriptOutputManifest, ScriptOutputOptions } from '../types/output.js'
import type { CodeProgramRequest } from '../types/script.js'

import { validateOutputOptions, validateOutputView } from './output-capture.js'

/** 只解析字面量数据，拒绝 getter、计算属性、展开、函数及重复键。 */
function literal(node:ts.Expression):unknown {
  if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))return node.text
  if(ts.isNumericLiteral(node))return Number(node.text)
  if(node.kind===ts.SyntaxKind.TrueKeyword)return true
  if(node.kind===ts.SyntaxKind.FalseKeyword)return false
  if(node.kind===ts.SyntaxKind.NullKeyword)return null
  if(ts.isArrayLiteralExpression(node))return node.elements.map(v=>literal(v as ts.Expression))
  if(ts.isObjectLiteralExpression(node)){
    const value:Record<string,unknown>=Object.create(null)
    for(const prop of node.properties){
      if(!ts.isPropertyAssignment(prop)||!ts.isIdentifier(prop.name)&&!ts.isStringLiteral(prop.name))throw new Error('展示声明必须为字面量对象')
      const key=prop.name.text;if(Object.hasOwn(value,key))throw new Error('展示声明存在重复键')
      value[key]=literal(prop.initializer)
    }
    return value
  }
  throw new Error('展示声明含有动态表达式，不能自动编辑')
}

/** 按真实导入符号识别顶层声明；同名局部函数不会被误判。 */
function declarations(source:string){
  const file=ts.createSourceFile('observe.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
  const options={allowJs:true,noLib:true,noResolve:true,target:ts.ScriptTarget.Latest}
  const host=ts.createCompilerHost(options);host.getSourceFile=name=>name==='observe.js'?file:undefined;host.fileExists=name=>name==='observe.js';host.readFile=name=>name==='observe.js'?source:undefined
  const program=ts.createProgram(['observe.js'],options,host);const checker=program.getTypeChecker()
  const symbols=new Set<ts.Symbol>();let outputName:Optional<string>
  for(const node of file.statements)if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text==='velaros'){
    const bindings=node.importClause?.namedBindings
    if(bindings&&ts.isNamedImports(bindings))for(const member of bindings.elements)if((member.propertyName??member.name).text==='output'){
      const symbol=checker.getSymbolAtLocation(member.name);if(symbol)symbols.add(symbol);outputName=member.name.text
    }
  }
  const calls:Array<{call:ts.CallExpression;options:ts.ObjectLiteralExpression;data:ScriptOutputOptions}>=[]
  let config:Optional<ts.CallExpression>;let configData:ScriptOutputConfig={};let dynamicConfig=false
  for(const node of file.statements){
    if(!ts.isExpressionStatement(node)||!ts.isCallExpression(node.expression))continue
    const call=node.expression;const expr=call.expression
    if(ts.isIdentifier(expr)&&symbols.has(checker.getSymbolAtLocation(expr)!)){
      if(call.arguments.length!==2||!ts.isObjectLiteralExpression(call.arguments[1]!))continue
      try{const data=literal(call.arguments[1]!) as ScriptOutputOptions;validateOutputOptions(data);if(data.key)calls.push({call,options:call.arguments[1],data})}catch{Log.tag('ActRuntime').debug('output-source 已进入异常处理或降级分支');/* 动态声明可以运行，但不允许自动改写。 */}
    }
    if(ts.isPropertyAccessExpression(expr)&&expr.name.text==='configure'&&ts.isIdentifier(expr.expression)&&symbols.has(checker.getSymbolAtLocation(expr.expression)!)){
      if(config)throw new Error('output.configure 重复声明')
      config=call
      try{if(call.arguments.length!==1)throw new Error('配置参数无效');configData=literal(call.arguments[0]!) as ScriptOutputConfig;validateOutputOptions(configData,true)}catch{Log.tag('ActRuntime').debug('output-source 已进入异常处理或降级分支');dynamicConfig=true}
    }
  }
  if(new Set(calls.map(c=>c.data.key)).size!==calls.length)throw new Error('源码存在重复 output key')
  return {file,calls,config,configData,dynamicConfig,outputName}
}

/** 提取可管理的源码规则，只有展示参数作为纯数据交给 Runtime。 */
export function describeOutputSource(program:CodeProgramRequest):ScriptOutputManifest {
  try{const result=declarations(program.source);return {config:result.dynamicConfig?{}:result.config?{maxChars:ScriptOutputLimits.displayChars,...result.configData}:{},outputs:result.calls.map(c=>c.data)}}catch{Log.tag('ActRuntime').debug('output-source 已进入异常处理或降级分支');return {config:{},outputs:[]}}
}

/** 仅替换顶层 output 的 view 字面量及全局预算，采集表达式逐字保持。 */
export function editOutputSource(program:CodeProgramRequest,edit:ScriptOutputEdit):CodeProgramRequest {
  if(!edit||!isObject(edit) ||Object.keys(edit).some(k=>!['config','outputs'].includes(k))||!edit.config&&!edit.outputs?.length)throw new Error('输出补丁为空或含越权字段')
  const parsed=declarations(program.source)
  const changes:Array<{start:number;end:number;text:string}>=[]
  if(edit.config){
    validateOutputOptions(edit.config,true)
    if(parsed.dynamicConfig)throw new Error('动态 configure 不能自动改写')
    if(parsed.config)changes.push({start:parsed.config.arguments[0]!.getStart(parsed.file),end:parsed.config.arguments[0]!.end,text:JSON.stringify(edit.config)})
    else{
      if(!parsed.outputName)throw new Error('缺少直接导入的 output')
      const imports=parsed.file.statements.filter(ts.isImportDeclaration);const offset=imports.at(-1)?.end??0
      changes.push({start:offset,end:offset,text:`\n${parsed.outputName}.configure(${JSON.stringify(edit.config)});\n`})
    }
  }
  if(!isUndefined(edit.outputs)&&(!isArray(edit.outputs)||edit.outputs.length>64))throw new Error('输出编辑数量无效')
  const seen=new Set<string>()
  for(const item of edit.outputs??[]){
    if(!item||Object.keys(item).some(k=>!['key','view'].includes(k))||seen.has(item.key))throw new Error('输出编辑身份重复或包含越权字段')
    seen.add(item.key);validateOutputView(item.view)
    const target=parsed.calls.find(c=>c.data.key===item.key)
    if(!target)throw new Error(`输出 ${item.key} 不存在可管理的静态声明`)
    const property=target.options.properties.find(p=>ts.isPropertyAssignment(p)&&((ts.isIdentifier(p.name)||ts.isStringLiteral(p.name))&&p.name.text==='view')) as Optional<ts.PropertyAssignment>
    if(property)changes.push({start:property.initializer.getStart(parsed.file),end:property.initializer.end,text:JSON.stringify(item.view)})
    else{const props=target.options.properties;changes.push({start:target.options.end-1,end:target.options.end-1,text:`${props.length&&!props.hasTrailingComma?',':''}view:${JSON.stringify(item.view)}`})}
  }
  let source=program.source
  for(const change of changes.sort((a,b)=>b.start-a.start))source=source.slice(0,change.start)+change.text+source.slice(change.end)
  if(source.length>60000)throw new Error('编辑后的观察源码超限')
  return {...program,source}
}
