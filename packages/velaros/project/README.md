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
const change = await projectFileOperations.commit({ changes: [
  { path: 'src/index.ts', before, after: before.replace('// index', '// 入口') },
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
- `createProjectCapabilityModule` 将领域确认的实际写入效果交给 Kernel：拒绝、重试和无变化记录为 none，真实变化记录为 committed。自行装配项目操作时，调用上下文的 `recordWriteOutcome` 应连接宿主 `recordEffect`；SDK 直接调用不要求效果日志。

- 新提交的 changeRef 绑定会话与真实项目根；旧 edit 的 change: 引用仍按原签发规则解析。
- `undo` 遇到外部改动抛 `CONFLICT_WITH_EXTERNAL_EDIT`、不覆盖，撤过的再撤是幂等成功；可撤销历史按条数和字节预算淘汰，被挤出去的撤销报 `NOT_SUPPORTED`。

- 不给 `changeFeed` 时变更记录只在内存里；给了 `transactionStatePath`，重启建内核时恢复中断的提交或回滚，遇到归属不明的改动报 `TRANSACTION_RECOVERY_CONFLICT` 并保留现场。
- `velaros:code` 的语言动作由本轮选择的语言服务答，答不准时结果带 `degraded`；图谱动作没有后端时 `query` 记成降级，`analyze` 抛 `UNAVAILABLE`。外部语言服务不下载命令，用完 `stop()`。
- 项目空间里的 `velaros:sandbox`、`velaros:images` 用 `projectCapabilityPorts` 按每次调用的 `ProjectHostPort` 现装的端口：沙箱源目录与图片都钳在项目内，宿主没给沙箱时沙箱操作报 `UNAVAILABLE`。
- 工作区通过内置 project Skill 绑定项目内核与通用代码查询；JS/TS 服务由 jsts Skill 的语言贡献启用。createProjectCodeQuery 的第二参数可固定本轮语言集合，空集合明确返回不可用；省略参数的 SDK 调用保留既有语言集合。
- `createRuntime({ workspace })` 已经按工作区装好 `velaros:project` 和 id 为 `project` 的证据源（`project: { code: true, images: true }` 时另挂 `velaros:code` 与项目里的 `velaros:images`），再挂同名模块或来源报 `VALIDATION`；要自己装就传 `project: false`，证据源用 `createProjectContextSource({ id, kernel })` 交进 `context.sources`。

模型通过 `commit({changes})` 提交，`inspect({changeRef, path})` 展开已提交差量，`undo({changeRef})` 核对磁盘后整批撤回。Node 客户端将原始 Buffer 基线转为 SHA-256，将字节结果编码传输；文本结果沿用项目编码。紧凑回执最多携带 8192 字符差量。

事务请求归属会话和项目，Node 客户端自动分配请求号，连接中断后用同号重试一次；其他宿主默认取调用号。持久历史保留期内，`inspect({requestId})` 可在重启后定位请求，`inspect({})` 取当前会话在目标根最近的一笔，previousChangeRef 可向前浏览。相同请求并发或重试只返回留存事务；同号异内容拒绝。快照继续供只读观察计划使用。宿主的语言服务、文件浏览和历史记录使用各自的公开端口。
