import { createContextInvocationJournal } from '@velaros-ai/context'
import { createOperationRuntime, type ModuleDescription, type ModulePage, type ModuleQuery, type OperationRuntimeApi } from '@velaros-ai/kernel'

import { VelarosRunLimits } from '../contract/runtime.js'
import type { SessionProgramAccess } from '../interface/internal.js'
import type { VelarosRuntime, VelarosSession } from '../interface/provides.js'
import type { VelarosRuntimeOptions } from '../interface/requires.js'

import { createRuntimeSession } from './RuntimeSession.js'
import { standardModules } from './StandardModules.js'

class ComposedRuntime implements VelarosRuntime {
  private readonly kernel:OperationRuntimeApi
  private readonly sessions=new Map<string,VelarosSession>()
  private closing?:Promise<void>
  private readonly journal
  private readonly programAccess=new Map<string,SessionProgramAccess>()

  public constructor(private readonly options:VelarosRuntimeOptions) {
    this.options = {...options,context:options.context ?? {sources:[]}}
    const journal=this.journal=createContextInvocationJournal(options.storage)
    this.kernel=createOperationRuntime({journal,beforeDispatch:async(invocation,descriptor,signal)=>{
      if(invocation.mode==='observe'||descriptor.effects !== 'write'||['velaros:modules','velaros:artifacts','velaros:results','velaros:programs'].includes(invocation.binding.moduleId))return
      const view=this.sessions.get(invocation.sessionId)?.view
      if(!view)throw new Error('任务视图不可用')
      await view.assertCanWrite(invocation.executionId,signal)
    },modules:[...standardModules.create({journal,kernel:()=>this.kernel,programs:id=>{const access=this.programAccess.get(id);if(!access)throw new Error('会话尚未打开');return access},view:id=>{
      const view=this.sessions.get(id)?.view
      if(!view)throw Object.assign(new Error('当前会话尚未打开'),{code:'SESSION_NOT_OPEN'})
      return view
    }    }),...options.modules]})
  }

  public async openSession(id:string):Promise<VelarosSession> {
    if(this.closing||!id)throw new Error('运行时已关闭或会话身份无效')
    await this.kernel.start()
    if(this.closing)throw new Error('运行时已关闭')
    let session=this.sessions.get(id)
    if(!session){
      session=createRuntimeSession(id,{journal:this.journal,contextOptions:this.options.context,kernel:this.kernel,runner:this.options.runner,storage:this.options.storage,model:this.options.model,limits:this.options.limits??VelarosRunLimits,
        register:access=>{this.programAccess.set(id,access)}})
      this.sessions.set(id,session)
    }
    return session
  }

  public modules(query?:ModuleQuery):ModulePage {return this.kernel.list(query)}
  public describe(moduleId:string):ModuleDescription {return this.kernel.describe(moduleId)}

  public close():Promise<void> {
    this.closing??=this.shutdown()
    return this.closing
  }

  private async shutdown():Promise<void> {
    await Promise.all([...this.sessions.values()].map(session=>session.close()))
    await this.kernel.dispose()
    await this.options.storage.close()
    this.sessions.clear()
    this.programAccess.clear()
  }
}

/** 宿主提供模型周边资源，一份实例图统一维护模块、脚本与上下文。 */
export function createRuntime(options:VelarosRuntimeOptions):VelarosRuntime {return new ComposedRuntime(options)}
