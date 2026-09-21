#!/usr/bin/env node
// Act 的生产依赖图和唯一发送/执行路径；类型引用与值引用同样检查。
import assert from 'node:assert/strict'
import {readFileSync,readdirSync,existsSync} from 'node:fs'
import {resolve,dirname} from 'node:path'
import ts from 'typescript'
const root=resolve(import.meta.dirname,'../..')
const read=path=>readFileSync(resolve(root,path),'utf8')
function files(path){return readdirSync(path,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(resolve(path,e.name)):e.name.endsWith('.ts')?[resolve(path,e.name)]:[])}
const agent=files(resolve(root,'packages/agent/src'))
for(const file of agent){
 const ast=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true)
 const visit=node=>{
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier){const name=node.moduleSpecifier.text;assert(!/^(ai|@ai-sdk\/|electron|@velaros-ai\/(velaros|development|ui|system))/.test(name),`${file}: reverse dependency ${name}`)}
  ts.forEachChild(node,visit)
 };visit(ast)
}
for(const pkg of ['kernel','model','context','script'])for(const file of files(resolve(root,`packages/${pkg}/src`)))assert(!readFileSync(file,'utf8').includes("from '@velaros-ai/agent"),`${file}: lower layer depends on agent`)
const required=[
 ['packages/velaros/act/runtime/impl/RuntimeSession.ts','createActRunService'],
 ['packages/agent/src/impl/ActRunService.ts','createActLoop'],
 ['packages/agent/src/impl/ActLoop.ts','createProviderRequestCompiler'],
 ['packages/agent/src/impl/ActLoop.ts','boundedModelStream'],
 ['packages/agent/src/impl/ActLoop.ts','this.options.execution.invoke'],
 ['packages/velaros/act/runtime/impl/RuntimeSession.ts','createKernelScriptSession'],
 ['packages/script/src/impl/KernelScriptSession.ts','KernelInvocationPort'],
 ['packages/model/src/impl/requests/AiSdkModelDriver.ts','streamText'],
 ['packages/velaros/act/search/impl/AdvancedSearch.ts','this.dependencies.open'],
 ['packages/velaros/act/runtime/impl/ComposedRuntime.ts','createAgentSupervisor'],
 ['packages/agent/src/impl/AgentSupervisor.ts','this.options.open'],
 ['packages/agent/src/impl/ActLoop.ts','frames.maintain'],
 ['packages/velaros/act/runtime/impl/ContextMaintenance.ts','this.dependencies.open'],
 ['packages/velaros/act/runtime/impl/ContextMaintenance.ts','state.apply'],
 ['packages/velaros/act/runtime/impl/ComposedRuntime.ts','new ModelToolRuntime'],
]
for(const [file,token] of required)assert(read(file).includes(token),`${file}: missing production edge ${token}`)
for(const file of agent)if(readFileSync(file,'utf8').includes('driver.stream('))assert(file.endsWith('/utils/model-stream.ts'),'model calls must use bounded receive')
assert.equal(agent.filter(file=>/\/ProviderRequestCompiler\.ts$/.test(file)).length,0,'compiler belongs to model')
assert(!existsSync(resolve(root,'packages/agent/src/impl/tools/ToolExecutor.ts')),'parallel tool dispatch')
const manifest=JSON.parse(read('packages/agent/package.json'))
assert.deepEqual(Object.keys(manifest.exports),['.','./contracts'])
assert(Number(manifest.version.split('.')[0])>=4,'breaking migration requires major version')
console.log(`Act architecture: ${agent.length} files, ${required.length} production edges, dependency direction and entrypoints verified`)
