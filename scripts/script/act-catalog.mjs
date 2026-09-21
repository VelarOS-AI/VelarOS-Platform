import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SystemPackage, LocalMemoryModuleId, MemoryModuleId, PersistentMemoryModuleId, StoreModuleId, StoreReadModuleId, StoreWriteModuleId } from '../../packages/velaros/dist/act/system/contract/constants.js'
import { standardModules } from '../../packages/velaros/dist/act/runtime/impl/StandardModules.js'

const modules = standardModules.create({ agentProfiles:()=>[], stores:{stores:()=>{throw new Error("目录生成不读取共享状态")}}, longTermMemory:{organize:true,scope:()=>{throw new Error("目录生成不读取长期记忆")}}, agents: {}, maintenance:{}, search: { profiles: () => ['host-profile'] } })
const destination = fileURLToPath(new URL('../../packages/velaros/act/README.md', import.meta.url))
const groups = { system: ['modules','memory','memory-local','memory-long-term','context-materials','store','store-write','store-read'], search: ['search','evidence'], agents: ['agents','interaction'] }
const defaults = { system: null, search: 'search', agents: 'agents' }
const rows = modules.map(module => {
  const name = module.binding.moduleId===StoreModuleId?'store':module.binding.moduleId===StoreWriteModuleId?'store-write':module.binding.moduleId===StoreReadModuleId?'store-read':module.binding.moduleId===PersistentMemoryModuleId?'memory-long-term':module.binding.moduleId===MemoryModuleId?'memory':module.binding.moduleId===LocalMemoryModuleId?'memory-local':module.binding.moduleId.split(':')[1]
  const group = Object.keys(groups).find(group => groups[group].includes(name))
  const template = defaults[group] === name ? 'template.js' : `${name}-template.js`
  const activation = name === 'store' ? '获配创建空间能力' : name === 'store-write' ? '获配空间写入范围' : name === 'store-read' ? '共享空间只读授权' : name === 'memory-long-term' ? '主线宿主配置 memory；整理按实际模型配置生成' : name === 'agents' ? '宿主配置 agents' : name === 'search' ? '宿主配置 search' : name === 'context-materials' ? '整理作用域' : name === 'memory' ? '具备整理模型的主线或业务子任务' : name === 'memory-local' ? '搜索或未启用整理的会话' : name === 'evidence' ? '搜索作用域' : '默认装配'
  return `| [${group}/ — ${name}](${group}/MODULE.md) | ${Object.keys(module.operations).map(op => `\`${op}\``).join('、')} | ${activation} | [${template}](${group}/${template}) |`
})
const projectedOperations = modules.flatMap(module => Object.entries(module.operations).map(([name, op]) => {
  const modes = op.allowedModes ?? (op.effects === 'none' ? ['observe', 'execute'] : ['execute'])
  return `| \`${[...Object.values(SystemPackage.exports),LocalMemoryModuleId,PersistentMemoryModuleId,StoreReadModuleId,StoreWriteModuleId].includes(module.binding.moduleId)?'system.'+(module.binding.moduleId==='velaros:modules'?'modules':[StoreModuleId,StoreReadModuleId,StoreWriteModuleId].includes(module.binding.moduleId)?'store':'memory'):module.binding.moduleId}.${name}\` | ${modes.map(mode => `\`${mode}\``).join('、')} | \`${op.effects}\` | ${op.summary.replaceAll('|', '\\|')} |`
}))
const operations=[...new Set(projectedOperations)]
const body = `# Act 能力目录

<!-- 由 scripts/script/act-catalog.mjs 从真实装配定义生成。 -->

当前共 ${modules.length} 种底层合同投影、${projectedOperations.length} 个投影操作、${operations.length} 项去重后的用法；其中系统包包含 ${Object.keys(SystemPackage.exports).length} 个成员、${modules.filter(module => Object.values(SystemPackage.exports).includes(module.binding.moduleId)).reduce((count,module)=>count+Object.keys(module.operations).length,0)} 个基础自管理操作，装配长期记忆时额外提供 recall/save/remove。同一会话的 memory 和 store 各使用一份实际授权合同。实际可用项由宿主配置、会话作用域和当前授权决定。

| 目录 | 模型操作 | 可用条件 | 使用模板 |
| --- | --- | --- | --- |
${rows.join('\n')}

共享会话、协议解析、程序版本、结果租约与五分区组装位于 [runtime/](runtime/MODULE.md)。搜索执行与预算在 [search/](search/MODULE.md)。

每个职责组统一管理契约、类型和实现。\`impl/*Module.ts\` 定义实际 schema、效果和处理器；对应模板位于组目录。单份类型或配置直接放成文件，多份内容才分目录。

模型使用示例：

\`\`\`js
import { output } from 'velaros';
import { modules } from 'velaros:system';
const usage = await modules.describe({ module: 'velaros:system', export: 'memory' });
output(usage.template, { type: 'code' }); // 按需读取模型用法；精确参数见 usage.declarations
\`\`\`

模型从 \`velaros:system\` 导入自管理成员。宿主的 \`@velaros-ai/velaros/act/system\` 入口提供装配实例和端口类型；[系统入口模板](system/template.js) 展示基本使用。

| 操作 | 允许入口 | 声明效果 | 用途 |
| --- | --- | --- | --- |
${operations.join('\n')}

修改后先构建 Velaros，再运行 \`bun run generate:act-catalog\` 更新本清单；\`bun run check:act-catalog\` 检查漂移。模板由模块装配并经 Kernel 的 \`describe\` 返回，构建时一同复制到发布目录。
`
if (process.argv.includes('--write')) writeFileSync(destination, body)
else if (readFileSync(destination, 'utf8') !== body) throw new Error('Act 能力清单与实际装配不一致，请运行 bun run generate:act-catalog')
console.info(`✓ Act: ${modules.length} 个模块，${operations.length} 个操作，目录与模式清单一致`)
