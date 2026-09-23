// Act 能力目录：从登记表（surfaces.mjs）与构建出的生成物（各组的 contract/surface.js）写出 packages/velaros/act/README.md。
// 不带参数是校验（与仓里的清单不一致就退 1）；带 --write 才落盘。改了 Act 的操作接口或模板，先构建 Velaros、`bun run generate:script`，再跑这里。
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { SystemMembers } from '../../packages/velaros/dist/act/system/contract/constants.js'

import { CodeSurfaces, surfaceConstantName } from './surfaces.mjs'

const Destination = fileURLToPath(new URL('../../packages/velaros/act/README.md', import.meta.url))

/** 每种合同投影什么时候挂上：由宿主配置、会话作用域与授权决定。 */
const Activation = Object.freeze({
  'system-goal': '主会话',
  modules: '默认装配',
  'system-memory-local': '搜索或未启用整理的会话',
  'system-memory': '具备整理模型的主线或业务子任务',
  'system-memory-persistent-local': '主线宿主配置 memory，没有整理模型',
  'system-memory-persistent': '主线宿主配置 memory，且具备整理模型',
  'system-store': '获配创建空间能力',
  'system-store-write': '获配空间写入范围',
  'system-store-read': '共享空间只读授权',
  'context-materials': '整理作用域',
  interaction: '默认装配',
  agents: '宿主配置 agents',
  search: '宿主配置 search',
  evidence: '搜索作用域',
})

const entries = CodeSurfaces.filter((surface) => surface.unit?.startsWith('act/'))
const missing = entries
  .filter((entry) => !Activation[entry.namespace])
  .map((entry) => entry.namespace)
if (missing.length > 0)
  throw new Error(`act-catalog.mjs 缺这些投影的可用条件：${missing.join('、')}`)

const surfaces = await Promise.all(
  entries.map(async (entry) => {
    const module = await import(`../../packages/velaros/dist/${entry.unit}/contract/surface.js`)
    return { entry, surface: module[surfaceConstantName(entry.namespace)] }
  })
)

/** 模块在模型那边的叫法：velaros:system 的成员写成 system.<成员>，其余就是 import 用的名字。 */
function modelName(specifier) {
  const member = Object.entries(SystemMembers).find(([, ids]) => ids.includes(specifier))
  return member ? `system.${member[0]}` : specifier
}

const rows = surfaces.map(({ entry, surface }) => {
  const group = entry.unit.slice('act/'.length)
  const templates = [entry.templates]
    .flat()
    .map((name) => `[${name}](${group}/${name})`)
    .join(' + ')
  return `| [${group}/ — ${entry.namespace}](${group}/README.md) | ${surface.methods.map((name) => `\`${name}\``).join('、')} | ${Activation[entry.namespace]} | ${templates} |`
})
const operations = [
  ...new Set(
    surfaces.flatMap(({ surface }) =>
      surface.methods.map((name) => {
        const operation = surface.operations[name]
        const modes =
          operation.allowedModes ??
          (operation.effects === 'none' ? ['observe', 'execute'] : ['execute'])
        const summary = operation.summary.replaceAll('\n', ' ').replaceAll('|', '\\|')
        return `| \`${modelName(surface.specifier)}.${name}\` | ${modes.map((mode) => `\`${mode}\``).join('、')} | \`${operation.effects}\` | ${summary} |`
      })
    )
  ),
]
const projected = surfaces.reduce((count, { surface }) => count + surface.methods.length, 0)

const body = `# Act 能力目录

<!-- 由 scripts/script/act-catalog.mjs 从 surfaces.mjs 的登记与生成的模型面写出，不要手改。 -->

当前共 ${surfaces.length} 种合同投影、${projected} 个投影操作、${operations.length} 项去重后的用法。系统包 \`velaros:system\` 有 ${Object.keys(SystemMembers).length} 个成员（${Object.keys(SystemMembers).join('、')}），每个成员按宿主装配与会话授权挂上其中一种投影；实际可用项由宿主配置、会话作用域和当前授权决定。

| 目录 | 模型操作 | 可用条件 | 使用模板 |
| --- | --- | --- | --- |
${rows.join('\n')}

共享会话、协议解析、程序版本、结果租约与五分区组装位于 [runtime/](runtime/README.md)。搜索执行与预算在 [search/](search/README.md)。

模型面只有一个来源：各组 \`impl/*Operations.ts\` 里的操作接口——方法上的 \`@AgentView\` 说明、\`@OperationEffect\` 效果与 \`@OperationModes\` 入口，加上入参与回执类型及其注释。\`bun run generate:script\` 由它写出各组的 \`contract/surface.ts\`（给模型的声明、由类型派生的 schema）与 \`baselines/script/\` 下的同一份声明；\`impl/*Module.ts\` 只把生成的模型面接到会话端口上，取值上限由实现自己核对。模板位于组目录。

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

修改后先构建 Velaros、运行 \`bun run generate:script\`，再运行 \`bun run generate:act-catalog\` 更新本清单；\`bun run check:act-catalog\` 检查漂移。模板随生成的模型面经 Kernel 的 \`describe\` 返回，构建时一同复制到发布目录。
`

if (process.argv.includes('--write')) {
  writeFileSync(Destination, body)
  process.stdout.write(
    `✓ ${Destination.slice(Destination.indexOf('packages/'))}：${surfaces.length} 种合同投影、${operations.length} 项用法\n`
  )
} else if (readFileSync(Destination, 'utf8') !== body) {
  process.stdout.write(
    '✗ packages/velaros/act/README.md 与生成的模型面不一致；`bun run generate:act-catalog` 重算并提交\n'
  )
  process.exit(1)
} else {
  process.stdout.write(`✓ Act 能力目录与生成的模型面一致（${surfaces.length} 种合同投影）\n`)
}
