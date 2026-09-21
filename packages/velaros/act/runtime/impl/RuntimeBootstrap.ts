import {createHash} from 'node:crypto'
import {mkdir,realpath,stat} from 'node:fs/promises'
import {isAbsolute,join,relative,sep} from 'node:path'

import type {ActRunLimits} from '@velaros-ai/agent'
import type {ContextStorage} from '@velaros-ai/context'
import {localContextStorage} from '@velaros-ai/context/node'
import {isFalse,isTrue,isUndefined} from '@velaros-ai/core'
import { isEmpty } from '@velaros-ai/core'
import type {OperationModuleDefinition} from '@velaros-ai/kernel'
import type {ModelDriver} from '@velaros-ai/model'
import {createAiSdkModelDriver,createModelRuntimeComposition} from '@velaros-ai/model'
import type {CodeRunnerApi} from '@velaros-ai/script'
import {nodeSubprocessCodeRunner} from '@velaros-ai/script'

import type {MemoryScopePort} from '../../../memory/index.js'
import {createMemoryStore} from '../../../memory/index.js'
import {createProjectContextSource,createProjectKernel} from '../../../project/index.js'
import type {VelarosSearchOptions} from '../../search/index.js'
import {ModelToolLimits,RuntimeModelLimits,RuntimeSearchProfile,VelarosRunLimits} from '../contract/constants.js'
import type {VelarosAgentsOptions,VelarosRuntimeOptions} from '../contract/requires.js'

import {createProjectCapabilityModule} from './StandardModules.js'

/** 在同一正式入口内建立缺省依赖，具体机制仍归原能力单元。 */
export interface RuntimeBootstrapApi {
 /** 核验配置并解析为现有运行时的具体依赖。 */
 prepare(options:VelarosRuntimeOptions):Promise<RuntimeBootstrapOptions>
}
/** 完成默认装配之后注入唯一运行时的具体依赖。 */
export interface RuntimeBootstrapOptions extends Omit<VelarosRuntimeOptions,'storage'|'runner'|'modules'|'model'|'memory'|'search'|'agents'|'limits'> {
 /** 已建立的唯一持久存储。 */
 readonly storage:ContextStorage
 /** 已选定的隔离执行器。 */
 readonly runner:CodeRunnerApi
 /** 实际挂载的业务模块。 */
 readonly modules:readonly OperationModuleDefinition[]
 /** 已解析的模型驱动。 */
 readonly model?:ModelDriver
 /** 长期记忆作用域工厂。 */
 readonly memory?:((sessionId:string)=>MemoryScopePort)
 /** 已解析的高级搜索配置。 */
 readonly search?:VelarosSearchOptions
 /** 已解析的业务子任务配置。 */
 readonly agents?:VelarosAgentsOptions
 /** 完整主运行预算。 */
 readonly limits:ActRunLimits
}

class RuntimeBootstrap implements RuntimeBootstrapApi {
 public async prepare(options:VelarosRuntimeOptions):Promise<RuntimeBootstrapOptions>{
  const modules=[...options.modules??[]]; const sources=[...options.context?.sources??[]]
  let workspace:Optional<string>
  if(options.workspace){
   if(!isAbsolute(options.workspace))throw new Error('workspace 需要绝对路径')
   workspace=await realpath(options.workspace)
   if(!(await stat(workspace)).isDirectory())throw new Error('workspace 必须是已有目录')
   if(modules.some(module=>module.binding.moduleId==='velaros:project')||sources.some(source=>source.id==='project'))throw new Error('workspace 已装配 project，不能重复挂载同一能力或来源')
  }
  const dataDir=options.dataDir
  if(dataDir){
   if(!isAbsolute(dataDir))throw new Error('dataDir 需要绝对路径')
   if(workspace){const path=relative(workspace,dataDir);if(path!=='..'&&!path.startsWith(`..${sep}`)&&!isAbsolute(path))throw new Error('dataDir 应位于业务工作区之外，避免被项目能力当作任务文件处理')}
   await mkdir(dataDir,{recursive:true})
   if(workspace){const path=relative(workspace,await realpath(dataDir));if(path!=='..'&&!path.startsWith(`..${sep}`)&&!isAbsolute(path))throw new Error('dataDir 的真实位置不能在业务工作区内')}
  }
  if(!options.storage&&!dataDir)throw new Error('需要 dataDir 保存运行状态，或注入 ContextStorage')
  if(workspace){
   const root=workspace
   const transactionStatePath=dataDir?join(dataDir,'projects',createHash('sha256').update(root).digest('hex'),'transactions.json'):undefined
   const kernel=await createProjectKernel({root,transactionStatePath})
   modules.push(createProjectCapabilityModule({instanceId:root,project:{getRootPath:()=>root,kernel:async()=>kernel,queryCode:async()=>{throw Object.assign(new Error('此项目没有装配代码智能端口'),{code:'UNAVAILABLE'})}}}))
   sources.push(createProjectContextSource({id:'project',kernel}))
  }
  let model:RuntimeBootstrapOptions['model']
  if(options.model&&'stream' in options.model)model=options.model
  else if(options.model){
   const config=options.model; const limits={...RuntimeModelLimits,...config.limits}
   if(!config.model?.trim()||!config.apiKey?.trim())throw new Error('模型配置需要 model 和 apiKey')
   const url=new URL(config.baseURL)
   if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('模型 baseURL 需要不含凭据或查询参数的 HTTP(S) 地址')
   if(Object.values(limits).some(value=>!Number.isSafeInteger(value)||value<1)||limits.inputTokens+limits.outputTokens+VelarosRunLimits.safetyTokens>limits.contextTokens)throw new Error('模型窗口预算需要覆盖输入、输出和安全余量')
   const providers=createModelRuntimeComposition({environment:{},providerScripts:{configPaths:[]}})
   const factory=providers.modelAdapterRegistry.createLanguageModelFactory(config)
   model=createAiSdkModelDriver({id:`${config.provider}/${config.model}`,model:factory(config.model),limits})
  }
  const defaults=Boolean(options.workspace||options.model&& !('stream' in options.model))
  const search=isFalse(options.search)?undefined:options.search&&!isTrue(options.search)?options.search:(defaults||isTrue(options.search))&&model&&!isEmpty(sources)?{model,profiles:{standard:{...RuntimeSearchProfile,outputTokens:Math.min(RuntimeSearchProfile.outputTokens,model.limits.outputTokens)}},defaultProfile:'standard'}:undefined
  if(isTrue(options.search)&&!search)throw new Error('启用搜索需要模型和真实证据来源')
  const agents=isFalse(options.agents)?undefined:options.agents&&!isTrue(options.agents)?options.agents:(defaults||isTrue(options.agents))&&model?{profiles:{worker:{model,modules:[...modules.map(module=>module.binding.moduleId),...(search?['velaros:search']:[])]}},concurrency:ModelToolLimits.concurrency,maxChildren:ModelToolLimits.maxChildren}:undefined
  if(isTrue(options.agents)&&!agents)throw new Error('启用子任务需要模型')
  const scope=createHash('sha256').update(workspace??dataDir??'injected').digest('hex')
  const memoryStore=dataDir&&isUndefined(options.memory)?createMemoryStore({root:join(dataDir,'memory')}):undefined
  const memory=isFalse(options.memory)?undefined:options.memory??(memoryStore?(()=>memoryStore.scope(scope)):undefined)
  // 存储最后建立；此前的配置失败不会遗留数据库句柄。
  const storage=options.storage??localContextStorage({path:join(dataDir!,'context.sqlite')})
  return {...options,workspace,dataDir,storage,model,modules,runner:options.runner??nodeSubprocessCodeRunner,memory,search,agents,context:{...options.context,sources},limits:{...VelarosRunLimits,outputTokens: model ? model.limits.outputTokens : VelarosRunLimits.outputTokens,...options.limits}}
 }
}
/** 普通配置与底层端口共享的默认装配器。 */
export const runtimeBootstrap:RuntimeBootstrapApi=new RuntimeBootstrap()
