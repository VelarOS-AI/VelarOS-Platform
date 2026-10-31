# @velaros-ai/velaros/project

普通文件读写使用 Node，遍历、搜索、差异使用 globby、ripgrep、diff 等现有库。`velaros:project` 按需提供一次提交的事务、原文冲突保护和撤回；`velaros:code` 提供定义、引用、调用、依赖、影响面与诊断。项目内核、语言服务与宿主端口也在本单元。

## 用法

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCapabilityModule, createProjectCapabilityModule } from '@velaros-ai/velaros'
import {
  createFileProjectChangeFeed,
  createProjectCodeQuery,
  createProjectKernel,
  projectCodeOperations,
  projectFileOperations,
  typeScriptProjects,
  type ProjectCodeIndexApi,
  type ProjectOperationContext,
  type ProjectSpacePort,
} from '@velaros-ai/velaros/project'
import { VelarCodeModule } from '@velaros-ai/velaros/project/contracts'

// 项目根，与这个项目在宿主私有目录里的状态目录（不要放进项目树）
declare const root: string
declare const stateDir: string
// 宿主的代码图谱后端；没有就给一个 isAvailable() 恒为 false 的
declare const codeIndex: ProjectCodeIndexApi

// 每个项目根一个内核：变更记录落盘，事务状态文件让中断的提交在重启后恢复
const changeFeed = createFileProjectChangeFeed({ path: `${stateDir}/changes.jsonl` })
const kernel = await createProjectKernel({ root, changeFeed, transactionStatePath: `${stateDir}/transactions.json` })
const project: ProjectSpacePort = {
  getRootPath: () => root,
  kernel: async () => kernel,
  queryCode: createProjectCodeQuery(codeIndex),
}

// 宿主自己调用：直接复用 Node 已读的原文，一次事务，不额外 read/select 或申请编辑引用
const context: ProjectOperationContext = { abortSignal: new AbortController().signal, project, sessionId: 'session-1' }
const before = await readFile(join(root, 'src/index.ts'), 'utf8')
const change = await projectFileOperations.edit({ steps: [
  { action: 'write', path: 'src/index.ts', expectedText: before, text: before.replace('// index', '// 入口') },
] }, context)
// 只有需要撤回才调用；inspect 也不是提交后的必经步骤。
if (change.changeRef) await projectFileOperations.undo({ changeRef: change.changeRef }, context)

// 挂成模型程序里可以 import 的 velaros:project 与 velaros:code
export const projectModule = createProjectCapabilityModule({ instanceId: root, project })
export const codeModule = createCapabilityModule({
  surface: VelarCodeModule,
  implementation: projectCodeOperations,
  instanceId: root,
  context: (call) => ({ abortSignal: call.signal, project, sessionId: call.invocation.sessionId }),
})

// 关项目时：放掉这个项目的 TypeScript 语言服务，关掉变更记录文件
export function closeProject() {
  typeScriptProjects.release(root)
  changeFeed.close()
}
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros/project` | Node | 两件能力的操作、项目内核 `createProjectKernel` 与有限事务面、变更记录、项目资源门、共用能力的项目端口 `projectCapabilityPorts`、验证判据、语言服务（`createProjectCodeQuery`、`languageQueries`、`createExternalLanguageService`、`typeScriptProjects`）、项目证据源、插件扩展点 |
| `@velaros-ai/velaros/project/contracts` | 任何进程 | 错误码 `ProjectErrorCodes`、上限 `ProjectFileLimits` / `ProjectCodeLimits`、内核缺省策略 `ProjectPolicyDefaults`、语言服务身份与外部语言服务表、模型面 `VelarProjectModule` / `VelarCodeModule` |

## 约定

- `snapshot` 共用正式项目读门与内核：一份 files 计划最多 20 项、每次捕获最多 500000 字符，前后两遍都完整且相同才返回纯值；任何缺口或变化都失败。`format:'json'` 与有界 JSON Pointer 只用于固定纯派生，`range` 仍是连续行。捕获给 `value.files`、此次值指纹与内核生命周期身份，不给编辑凭据；不保证读取期间没有 ABA，也不跳过 IO。失败捕获的实际读取请求数与材料字节数可随 Kernel 独立诊断保存。
- `createProjectObservationProvider()` 登记固定 Project files 计划，真实读取始终由已授权的 `velaros:project.snapshot` 派发。默认 workspace Runtime 自动装配；自己装项目模块时把该提供者放入 `context.snapshots`。完整同值只复用确定性的派生结果，权限、任务、重置、绑定或提供者变化重新核对，阶段结束与重启遵循 Runtime 生命周期。

- 路径按真实路径钳在项目根内，出了项目抛 `PERMISSION_DENIED`；没有读写名单、不问人。同一项目根上写串行、读并发（进程内的项目资源门），项目里的前台命令也排进这扇门。
- `read`、`search` 交回连续正文与 `target`（有完整可编辑版本时）；每个断开的窗口独立绑定。`select` 通过 JS/TS/JSX/TSX、Python/pyi 语法解析定位完整声明，或在 `within` 中定位精确字面片段。歧义提供完整候选，解析错误与其他语言使用文本目标。
- `patch` 直接复用目标、只发送新正文；工具计算 UTF-16 坐标，按同一原始版本每个文件拼接一次，整批经同一事务内核提交。片段按字符，完整结构/整行保留末行原换行；新块带自身缩进、所需装饰器和注释。目标之外的版本变化同样拒绝，先重新定位；只改 mtime 且正文相同可用。
- `patch` 缺省摘要，`receipt: 'full'` 返回完整差量与变更窗口；原始差量、事务验证和撤销证据始终保留，`inspect(changeRef)` 可取回。`blocked` 明确整批未写入，保留结构化问题与 `planRef`；用原下标 `amendments` 只修正错误项，再次验证完整批次。取消与未知写入状态继续抛错。
- `createProjectCapabilityModule` 将领域确认的实际写入效果交给 Kernel：blocked 和无变化记录为 none，真实变化记录为 committed。自行装配项目操作时，调用上下文的 `recordWriteOutcome` 应连接宿主 `recordEffect`；SDK 直接调用不要求效果日志。
- `edit` 按路径指文件：`write` 整份写入（没有就新建），`replace` 把唯一的一段原文换掉；同文件接连几步按前一步结果计算。读取凭据由系统在规划时获取。
- `write.expectedText` 可直接接收 Node 已读的完整原文，`null` 表示仅允许新建，空串表示现有空文件；省略时才按提交时内容覆盖。核对忽略输入开头的编码 BOM，换行与其他正文逐字比较，不匹配报 `BASE_REVISION_MISMATCH` 且整批未写入。同文件多步核对前一步结果；规划至提交期间继续使用内核版本保护。编码和原换行仍保留，撤回仍检查外部修改。
- `replace` 直接按唯一原文定位，外部对其他位置的修改保留，目标消失或歧义时拒绝整批。无需先 `select`；全文变换优先复用已有原文和 `write.expectedText`。只有结构定位、特殊编码读取或减少大块传输时才选择 `read/select + patch`。
- `changeRef`、选区与失败计划分别为 `change:`、`target:`、`plan:` 加 8 位十六进制。按会话与项目核对，内部保留完整 SHA256；碰撞重新签发，已签发身份和已消费计划保留轻量占用记录。正文受条数和字符预算约束；过期后重新读取定位，提交成功的计划不能重放。源码和编辑视图内部使用 `source:` / `view:`，历史完整引用在所属会话内精确解析。
- `edit` 的步骤合成一个事务，全成或全不成；失败时一个文件都没写，按 `error.code`（`ProjectErrorCodes` 里的码）分支，第几步、候选与下一步都在 message 里。
- 模型模板优先展示精确替换、复用已读原文的一次多文件 `edit` 和 `undo`。普通读取失败就停止依赖的提交，不把成功子集当整批；冲突后重新读取、合并，不移除保护重试。高级结构编辑才使用 `select/patch`：一次最多 1000 个目标、100 个源码文件，完整源码与输出各最多 20000000 字符，一项歧义最多 20 个完整候选。超过上限按独立范围拆分，每次提交各自成事务。
- `undo` 遇到外部改动抛 `CONFLICT_WITH_EXTERNAL_EDIT`、不覆盖，撤过的再撤是幂等成功；可撤销历史按条数和字节预算淘汰，被挤出去的撤销报 `NOT_SUPPORTED`。
- 读、列、搜不折叠，`ProjectFileLimits` 只为守内存：超了整个失败，批量读里装不下的文件进 `issues`；一个事务缺省最多改 `ProjectPolicyDefaults.maxChangedFilesPerTransaction` 个文件，建内核时用 `corePolicy` 调。
- `search.contextLines` 接受非负安全整数，缺省 1；命中窗口止于文件边界，相交或相邻的段合并。合并后的连续正文一次最多 20000000 个 Unicode 字符，超限明确失败，减小 contextLines、收窄范围或用 read 的 range 分段读取。
- 不给 `changeFeed` 时变更记录只在内存里；给了 `transactionStatePath`，重启建内核时恢复中断的提交或回滚，遇到归属不明的改动报 `TRANSACTION_RECOVERY_CONFLICT` 并保留现场。
- `velaros:code` 的语言动作由本轮选择的语言服务答，答不准时结果带 `degraded`；图谱动作没有后端时 `query` 记成降级，`analyze` 抛 `UNAVAILABLE`。外部语言服务不下载命令，用完 `stop()`。
- 项目空间里的 `velaros:sandbox`、`velaros:images` 用 `projectCapabilityPorts` 按每次调用的 `ProjectHostPort` 现装的端口：沙箱源目录与图片都钳在项目内，宿主没给沙箱时沙箱操作报 `UNAVAILABLE`。
- 工作区通过内置 project Skill 绑定项目内核与通用代码查询；JS/TS 服务由 jsts Skill 的语言贡献启用。createProjectCodeQuery 的第二参数可固定本轮语言集合，空集合明确返回不可用；省略参数的 SDK 调用保留既有语言集合。
- `createRuntime({ workspace })` 已经按工作区装好 `velaros:project` 和 id 为 `project` 的证据源（`project: { code: true, images: true }` 时另挂 `velaros:code` 与项目里的 `velaros:images`），再挂同名模块或来源报 `VALIDATION`；要自己装就传 `project: false`，证据源用 `createProjectContextSource({ id, kernel })` 交进 `context.sources`。

通用文件读写使用 Node 标准库；项目事务能力由 `velaros:project` 的 read/select/patch/edit/inspect/undo 提供。宿主文件搜索 `createLocalFileSearch` 服务产品文件浏览器。
