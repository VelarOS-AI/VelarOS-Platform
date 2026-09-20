import { Ajv, type ValidateFunction } from 'ajv'

import type { ContextReadRange, ContextRef } from '@velaros-ai/context'
import type { ModuleQuery, OperationDefinition, OperationModuleDefinition } from '@velaros-ai/kernel'
import { modelRequestEncoder, type ModelResponseFormat } from '@velaros-ai/kernel'
import { CodeProgramEditLimits } from '@velaros-ai/script/contracts'

import { VelarShellModule } from '../../shell/contract/surface.js'
import { shellOperations } from '../../shell/impl/ShellOperations.js'
import type { ShellRunInput } from '../../shell/types/shell-command.js'
import { ScriptLeaseLimits,VelarosRuntimeContract } from '../contract/runtime.js'
import type { StandardModuleFactory, StandardModuleHost } from '../interface/internal.js'
import type { ScriptSubmission } from '../interface/provides.js'
import type { ShellCapabilityModuleOptions } from '../interface/requires.js'
import type { CapabilityModuleOptions } from '../interface/requires.js'
import { scriptInputCopy } from '../utils/program-context.js'
import { normalizeCapabilityValue } from '../utils/results.js'
import { contextRecordSchema, contextRefSchema, objectSchema, querySchema } from '../utils/schemas.js'

class StandardModules implements StandardModuleFactory {
  public readonly response:ModelResponseFormat
  private readonly validate:ValidateFunction

  public constructor() {
    const edits={type:'array',minItems:1,maxItems:CodeProgramEditLimits.edits,items:objectSchema({oldText:{type:'string',minLength:1},newText:{type:'string'},module:{type:'string'}},['oldText','newText'])} as const
    const values={input:{},blobs:{type:'object',additionalProperties:{type:'string'}}} as const
    const source={source:{type:'string',minLength:1},modules:{type:'object',additionalProperties:{type:'string'}},...values} as const
    const reference={sourceRef:{type:'string',minLength:1,maxLength:128},edits,...values} as const
    const lease={retainTurns:{type:'integer',minimum:1,maximum:ScriptLeaseLimits.maxTurns}} as const
    const observe={anyOf:[objectSchema(source,['source']),objectSchema(reference,['sourceRef']),objectSchema({edits,...values},['edits'])]}
    const execute={anyOf:[objectSchema({...source,...lease},['source']),objectSchema({...reference,...lease},['sourceRef'])]}
    const inputSchema={...objectSchema({observe,execute},[]),minProperties:1}
    this.response=scriptInputCopy({type:'json',name:'script_turn',description:'生成完整业务回合：message 为用户消息，observe 更新稳定观察，execute 本轮执行一次。observe/execute 使用 null 表示保持现状/不执行；同时为 null 时交还控制。',schema:{...objectSchema({message:{type:'string'},observe:{anyOf:[{type:'null'},...observe.anyOf]},execute:{anyOf:[{type:'null'},...execute.anyOf]}})}})
    this.validate=new Ajv({strict:true,allErrors:true,coerceTypes:false,useDefaults:false,removeAdditional:false}).compile(inputSchema)
  }

  public parseScript(input:unknown):ScriptSubmission {
    const copy=scriptInputCopy(input)
    if(!this.validate(copy))throw Object.assign(new Error(`输入不符合 script schema: ${JSON.stringify(this.validate.errors)}`),{code:'INPUT_SCHEMA',effect:'none'})
    return copy as ScriptSubmission
  }

  public parseTurn(value:unknown):{message:string;submission?:ScriptSubmission} {
    const turn=modelRequestEncoder.output(this.response,value) as {message:string;observe:ScriptSubmission['observe']|null;execute:ScriptSubmission['execute']|null}
    return {message:turn.message,...(turn.observe===null&&turn.execute===null?{}:{submission:this.parseScript({...(turn.observe===null?{}:{observe:turn.observe}),...(turn.execute===null?{}:{execute:turn.execute})})})}
  }

  public create(host: StandardModuleHost): readonly OperationModuleDefinition[] {
    const definitions: ReadonlyArray<[string, string, Record<string, OperationDefinition>]> = [
      ['modules', '查询实际挂载的模块及其精确使用契约', {
        list: { summary:'分页列出模块卡片',input:querySchema,output:{type:'object'},effects:'none',run: input=>host.kernel().list((input??{}) as ModuleQuery) },
        search: { summary:'按关键词搜索模块',input:querySchema,output:{type:'object'},effects:'none',run: input=>host.kernel().list((input??{}) as ModuleQuery) },
        describe: { summary:'读取模块 schema、方法与生成声明',input:objectSchema({module:{type:'string'}}),output:{type:'object'},effects:'none',run:input=>host.kernel().describe((input as {module:string}).module) },
        release: { summary:'释放本会话的模块绑定',input:objectSchema({module:{type:'string'}}),output:{type:'null'},effects:'write',run:(input,call)=>{host.kernel().release(call.invocation.sessionId,(input as {module:string}).module);return null} },
      }],
      ['artifacts', '存储有来源的模型材料，按任务范围分页读取', {
        put: { summary:'持久保存材料并返回引用',input:objectSchema({body:{type:'string'},sources:{type:'array',items:contextRefSchema}},['body']),output:contextRefSchema,effects:'write',run:(input,call)=>{const value=input as {body:string;sources?:readonly ContextRef[]};return host.view(call.invocation.sessionId).putArtifact(value.body,value.sources,call.signal)} },
        read: { summary:'按引用和字符范围召回任务材料',input:objectSchema({ref:contextRefSchema,range:objectSchema({offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1}},[])},['ref']),output:{type:'object'},effects:'none',run:(input,call)=>{const value=input as {ref:ContextRef;range?:ContextReadRange};return host.view(call.invocation.sessionId).readArtifact(value.ref,value.range)} },
      }],
      ['execution', '按调用引用查询真实意图、执行结果和外部效果', {
        inspect: {summary:'读取调用事实；receipt 为空表示仍需核对',input:objectSchema({id:{type:'string'}}),output:{anyOf:[{type:'object'},{type:'null'}]},effects:'none',run:(input,call)=>host.journal.read(call.invocation.sessionId,(input as {id:string}).id)},
      }],
      ['programs','按引用读取保存的脚本底稿，支持精确编辑和历史检查',{
        read:{summary:'读取当前会话的不可变脚本版本；包含 source/modules/input/blobs，offset/limit 支持分页。',input:objectSchema({ref:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:60_000}},['ref']),output:objectSchema({record:contextRecordSchema,text:{type:'string'},totalChars:{type:'integer'},offset:{type:'integer'}}),effects:'none',run:(input,call)=>{const value=input as {ref:string;offset?:number;limit?:number};return host.programs(call.invocation.sessionId).readProgram(value.ref,value.offset,value.limit)}},
      }],
      ['results','读取试探结果与有限续租，过期只退出上下文，原始结果仍保存',{
        read:{summary:'按结果 ref 读取历史原文，不重新执行、不自动续租；offset/limit 支持大结果分页。',input:objectSchema({ref:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:60_000}},['ref']),output:objectSchema({record:contextRecordSchema,text:{type:'string'},totalChars:{type:'integer'},offset:{type:'integer'}}),effects:'none',run:(input,call)=>{const value=input as {ref:string;offset?:number;limit?:number};return host.programs(call.invocation.sessionId).readResult(value.ref,value.offset,value.limit)}},
        retain:{summary:'从下一业务回合起将结果可见租约重设为 turns，不累加、不执行原程序；只能在一次性执行入口调用。',input:objectSchema({ref:{type:'string'},turns:{type:'integer',minimum:1,maximum:ScriptLeaseLimits.maxTurns}}),output:objectSchema({ref:{type:'string'},remainingTurns:{type:'integer'},executed:{const:false}}),effects:'write',run:(input,call)=>{const value=input as {ref:string;turns:number};return host.programs(call.invocation.sessionId).retainResult(value.ref,value.turns,call.signal)}},
      }],
    ]
    return definitions.map(([name,summary,operations])=>({binding:{moduleId:`velaros:${name}`,instanceId:`standard:${name}`,generation:VelarosRuntimeContract.generation,schemaRevision:VelarosRuntimeContract.schemaRevision},summary,operations}))
  }
}

/** 标准工具装配保持单一入口，模型看见的说明和执行使用同一份定义。 */
export const standardModules: StandardModuleFactory = new StandardModules()

/** 领域合同只装配一次，所有模块复用同一校验、派发、效果与持久回执链。 */
export function createCapabilityModule<T extends object>(options: CapabilityModuleOptions<T>): OperationModuleDefinition {
  const {surface,implementation} = options
  if (surface.methods.length !== Object.keys(surface.operations).length || new Set(surface.methods).size !== surface.methods.length) throw new Error('领域声明与操作表不一致')
  const operations:Record<string,OperationDefinition> = Object.create(null)
  for (const name of surface.methods) {
    const operation = surface.operations[name]
    const handler = Reflect.get(implementation,name)
    if (!operation || typeof handler !== 'function') throw new Error(`领域实现缺少 ${surface.specifier}.${name}`)
    const {hasInput,...descriptor} = operation
    const reconcile = options.reconcile?.[name as keyof T]
    const observe=options.observation?.[name as keyof T]
    operations[name] = {...descriptor,...(observe?{observe}:{}),...(reconcile ? {reconcile} : {}),run:async(input,call)=>{
      call.signal.throwIfAborted()
      let effectRecorded = false
      const context = await options.context({...call,recordEffect:effect=>{effectRecorded=true;call.recordEffect(effect)}})
      call.signal.throwIfAborted()
      const value:unknown = await Reflect.apply(handler,implementation,hasInput ? [input,context] : [context])
      if (!effectRecorded) call.recordEffect(descriptor.effects === 'none' ? 'none' : 'committed')
      return normalizeCapabilityValue(value)
    }}
  }
  return {
    binding:{moduleId:surface.specifier,instanceId:options.instanceId,generation:options.generation ?? 1,schemaRevision:surface.revision},
    summary:options.summary ?? surface.specifier, surface,operations,
    ...(options.activate ? {activate:()=>options.activate!()} : {}),...(options.dispose ? {dispose:()=>options.dispose!()} : {}),
  }
}

/** Shell 观察保留任意命令表达力，调用同一领域实现的宿主受限执行口。 */
export function createShellCapabilityModule(options:ShellCapabilityModuleOptions):OperationModuleDefinition {
  return createCapabilityModule({surface:VelarShellModule,implementation:shellOperations,instanceId:options.instanceId,
    context:call=>({shell:options.shell,approval:options.approval,abortSignal:call.signal,sessionId:call.invocation.sessionId}),
    observation:{run:async(input,call)=>{
      const result=await shellOperations.run(input as ShellRunInput,{shell:options.shell,approval:options.approval,abortSignal:call.signal,sessionId:call.invocation.sessionId,observation:true})
      call.recordEffect('unknown')
      return normalizeCapabilityValue(result)
    }}})
}
