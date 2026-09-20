import type { KernelScriptSessionOptions } from '../contract/requires.js'
import type { CodeProgramRequest, CodeProgramCheckResult, CodeProgramTargetEdit, CodeProgramEditResult, GrantedModule } from '../types/script.js'
import type { CodeSurfaceOutcome } from '../types/outcome.js'
import { VelarosStandardDeclarations } from '../utils/standard.js'
import { readModuleSpecifiers } from '../utils/module-form.js'
import { describeProgramOversize } from '../utils/result.js'
import { applyProgramEdits } from '../utils/edit.js'
import { CodeProgramEditLimits, CodeSurfaceErrorCodes } from '../contract/constants.js'

import { codeProgramChecker } from './CodeProgramChecker.js'
import { createCodeSurfaceSession } from './CodeSurfaceSession.js'
import { KernelInvocationPort } from './KernelInvocationPort.js'

/** 在同一个 Kernel 上检查并运行脚本的入口。 */
export interface KernelScriptSessionApi {
  /** 按同一底稿精确应用整组编辑，不检查或执行代码。 */
  edit(program:CodeProgramRequest, edits:readonly CodeProgramTargetEdit[]):CodeProgramEditResult
  /** 只检查源码与当前能力声明，不执行任何代码。 */
  check(program:CodeProgramRequest):CodeProgramCheckResult
  /** 源码与输出有界；初次 import 即取得当前挂载的准确声明。 */
  run(program: CodeProgramRequest, signal?: AbortSignal): Promise<CodeSurfaceOutcome>
}

class KernelScriptSession implements KernelScriptSessionApi {
  private used = false

  public constructor(private readonly options: KernelScriptSessionOptions) {}

  public edit(program:CodeProgramRequest, edits:readonly CodeProgramTargetEdit[]):CodeProgramEditResult {
    if(!Array.isArray(edits)||edits.length<1||edits.length>CodeProgramEditLimits.edits)return {ok:false,code:'SCRIPT_EDIT',message:`edits 必须包含 1 到 ${CodeProgramEditLimits.edits} 项`}
    const groups=new Map<string|undefined,{index:number;edit:CodeProgramTargetEdit}[]>()
    for(const [index,edit] of edits.entries()){
      if(!edit||typeof edit.oldText!=='string'||typeof edit.newText!=='string'||(edit.module!==undefined&&typeof edit.module!=='string'))return {ok:false,code:'SCRIPT_EDIT',editIndex:index,message:'编辑项必须提供 oldText/newText 字符串与可选 module'}
      if(edit.module!==undefined&&!Object.hasOwn(program.modules??{},edit.module))return {ok:false,code:'SCRIPT_EDIT',editIndex:index,message:`附属模块不存在：${edit.module}`}
      groups.set(edit.module,[...(groups.get(edit.module)??[]),{index,edit}])
    }
    let source=program.source
    const modules={...program.modules}
    for(const [target,items] of groups){
      const result=applyProgramEdits(target===undefined?program.source:program.modules![target]!,items.map(item=>item.edit))
      if('failed' in result)return {ok:false,code:'SCRIPT_EDIT',editIndex:items[result.editIndex]!.index,message:result.failed}
      if(target===undefined)source=result.source
      else Object.defineProperty(modules,target,{value:result.source,enumerable:true,writable:true,configurable:true})
    }
    return {ok:true,program:{...program,source,...(program.modules?{modules}:{})},changed:source!==program.source||Object.entries(modules).some(([key,value])=>value!==program.modules?.[key])}
  }

  public check(program:CodeProgramRequest):CodeProgramCheckResult {
    const oversized=describeProgramOversize(program.source,program.blobs,program.input)
    if(oversized)throw Object.assign(new Error(oversized),{code:CodeSurfaceErrorCodes.tooLarge})
    const imported=new Set([program.source,...Object.values(program.modules??{})].flatMap(readModuleSpecifiers))
    if(imported.has('velaros'))for(const name of ['modules','execution','artifacts','results','programs'])imported.add(`velaros:${name}`)
    const port=new KernelInvocationPort(this.options,imported)
    return codeProgramChecker.check({...program,granted:[{namespace:'velaros',declarations:VelarosStandardDeclarations},...Object.keys(port.listOperations()).map(namespace=>({namespace,declarations:this.options.runtime.describe(namespace).declarations}))]})
  }

  public run(program: CodeProgramRequest, signal?: AbortSignal): Promise<CodeSurfaceOutcome> {
    if(this.used)return Promise.reject(new Error('同一脚本执行身份不能再次运行；继续工作请创建新的执行'))
    this.used=true
    const imported=new Set([program.source,...Object.values(program.modules??{})].flatMap(readModuleSpecifiers))
    if(imported.has('velaros'))for(const name of ['modules','execution','artifacts','results','programs'])imported.add(`velaros:${name}`)
    const port = new KernelInvocationPort(this.options,imported)
    const granted:GrantedModule[] = [
      { namespace: 'velaros', declarations: VelarosStandardDeclarations },
      ...Object.keys(port.listOperations()).map(moduleId => ({ namespace: moduleId, declarations: this.options.runtime.describe(moduleId).declarations })),
    ]
    const session = createCodeSurfaceSession({ checker: codeProgramChecker, runner: this.options.runner, capabilities: port })
    return session.submit({ program, signal, granted })
  }
}

/** 组装脚本检查和隔离桥，不创建第二份模块注册表或调用日志。 */
export function createKernelScriptSession(options: KernelScriptSessionOptions): KernelScriptSessionApi {
  return new KernelScriptSession(options)
}
