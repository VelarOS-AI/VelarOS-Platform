# @velaros-ai/velaros/project

普通文件读写使用 Node，遍历、搜索、差异使用 globby、ripgrep、diff 等现有库。`velaros:project` 按需提供一次提交的事务、原文冲突保护和撤回；`velaros:code` 提供定义、引用、调用、依赖、影响面与诊断。项目内核、语言服务与宿主端口也在本单元。

## 用法

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createFileProjectChangeFeed,
  createProjectCodeQuery,
  createProjectCapabilityModule,
  createProjectCodeModule,
  createProjectContextSource,
  createProjectObservationProvider,
  createProjectKernel,
  projectFileOperations,
  typeScriptProjects,
  type ProjectCodeIndexApi,
  type ProjectOperationContext,
  type ProjectSpacePort,
} from '@velaros-ai/velaros/project'

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
export const codeModule = createProjectCodeModule({ instanceId: root, project })
// 产品选择是否把模块与证据交给 createRuntime；基础 Runtime 不推导项目能力。
export const modules = [projectModule, codeModule]
export const contextOptions = {
  sources: [createProjectContextSource({ id: 'project', kernel })],
  snapshots: [createProjectObservationProvider()],
}

// 关项目时：放掉这个项目的 TypeScript 语言服务，关掉变更记录文件
export function closeProject() {
  typeScriptProjects.release(root)
  changeFeed.close()
}
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros/project` | Node | 显式模型模块工厂、两件能力的操作、项目内核 `createProjectKernel` 与有限事务面、变更记录、项目资源门、共用能力的项目端口 `projectCapabilityPorts`、验证判据、语言服务（`createProjectCodeQuery`、`languageQueries`、`createExternalLanguageService`、`typeScriptProjects`）、项目证据源、插件扩展点 |
| `@velaros-ai/velaros/project/contracts` | 任何进程 | 错误码 `ProjectErrorCodes`、上限 `ProjectFileLimits` / `ProjectCodeLimits`、内核缺省策略 `ProjectPolicyDefaults`、语言服务身份与外部语言服务表、模型面 `VelarProjectModule` / `VelarCodeModule` |

## 约定

- `snapshot` 共用正式项目读门与内核：一份 files 计划最多 20 项、每次捕获最多 500000 字符，前后两遍都完整且相同才返回纯值；任何缺口或变化都失败。`format:'json'` 与有界 JSON Pointer 只用于固定纯派生，`range` 仍是连续行。捕获给 `value.files`、此次值指纹与内核生命周期身份，不给编辑凭据；不保证读取期间没有 ABA，也不跳过 IO。失败捕获的实际读取请求数与材料字节数可随 Kernel 独立诊断保存。
- `createProjectObservationProvider()` 登记固定 Project files 计划，真实读取始终由已授权的 `velaros:project.snapshot` 派发。产品显式挂载项目模块时，把该提供者放入 `context.snapshots`。完整同值只复用确定性的派生结果，权限、任务、重置、绑定或提供者变化重新核对，阶段结束与重启遵循 Runtime 生命周期。

- 路径按真实路径钳在项目根内，出了项目抛 `PERMISSION_DENIED`；没有读写名单、不问人。同一项目根上写串行、读并发（进程内的项目资源门），项目里的前台命令也排进这扇门。
- `createProjectCapabilityModule` 将领域确认的实际写入效果交给 Kernel：拒绝、重试和无变化记录为 none，真实变化记录为 committed。自行装配项目操作时，调用上下文的 `recordWriteOutcome` 应连接宿主 `recordEffect`；SDK 直接调用不要求效果日志。

- 新提交的 changeRef 绑定会话与真实项目根；旧 edit 的 change: 引用仍按原签发规则解析。
- `undo` 遇到外部改动抛 `CONFLICT_WITH_EXTERNAL_EDIT`、不覆盖，撤过的再撤是幂等成功；可撤销历史按条数和字节预算淘汰，被挤出去的撤销报 `NOT_SUPPORTED`。

- 不给 `changeFeed` 时变更记录只在内存里；给了 `transactionStatePath`，重启建内核时恢复中断的提交或回滚，遇到归属不明的改动报 `TRANSACTION_RECOVERY_CONFLICT` 并保留现场。
- `velaros:code` 的语言动作由本轮选择的语言服务答，答不准时结果带 `degraded`；图谱动作没有后端时 `query` 记成降级，`analyze` 抛 `UNAVAILABLE`。外部语言服务不下载命令，用完 `stop()`。
- 项目空间里的 `velaros:sandbox`、`velaros:images` 用 `projectCapabilityPorts` 按每次调用的 `ProjectHostPort` 现装的端口：沙箱源目录与图片都钳在项目内，宿主没给沙箱时沙箱操作报 `UNAVAILABLE`。
- 产品显式选择项目根、项目内核与语言服务。`createProjectCodeQuery` 的第二参数固定本轮语言集合，空集合明确返回不可用；省略参数的 SDK 调用使用内置语言集合。接入已审核的 Skill 语言贡献时，显式调用 `createSkillProjectCodeQuery(codeIndex, skills)`；目录来自 `skills.session.catalog` 或固定租约 `skills.lease.skills`，每次调用重新核对当前代际授权，优先复用已激活的所有者，按需激活剩余所有者后再查询。项目只借用授权与激活端口，不发现、安装或自动选择 Skill。
- 产品把 `createProjectCapabilityModule`、`createProjectCodeModule`、`createProjectImagesModule` 的结果显式放入 Runtime 的 `modules`；项目证据源用 `createProjectContextSource({ id, kernel })` 交进 `context.sources`。项目内核、模块身份、授权根和会话的对应关系由产品负责，不由模型输入或基础 Runtime 推导。

模型通过 `commit({changes})` 提交，`inspect({changeRef, path})` 展开已提交差量，`undo({changeRef})` 核对磁盘后整批撤回。Node 客户端将原始 Buffer 基线转为 SHA-256，将字节结果编码传输；文本结果沿用项目编码。紧凑回执最多携带 8192 字符差量。

`undo` 回执给出 `status:'rolled_back'`、`changed`、实际文件和反向 `diff`，同样按 8192 字符截断并标记 `diffTruncated`。重复撤回返回 `changed:false`、`alreadyUndone:true` 与空差量。遇到后续修改时错误文字指出冲突路径，整批保持现场。常用提交、检查与撤回合同随 Node 指令提供，其余能力按需定向发现。

事务请求归属会话和项目，Node 客户端自动分配请求号，连接中断后用同号重试一次；其他宿主默认取调用号。持久历史保留期内，`inspect({requestId})` 可在重启后定位请求，`inspect({})` 取当前会话在目标根最近的一笔，previousChangeRef 可向前浏览。相同请求并发或重试只返回留存事务；同号异内容拒绝。快照继续供只读观察计划使用。宿主的语言服务、文件浏览和历史记录使用各自的公开端口。
- 沙箱调用在授权与排队前固定本次目标和路径；项目证据源只将明确的无权或目标不存在判为不可访问，后端读取故障原样交回。
- 语言查询需要完整源码；达到读取边界时明确报 `NOT_SUPPORTED`，不把截断尾部的结果当完整答案。`definition` 的符号位置没有解析快照版本时交回 `coverage.versioned: false` 与降级原因，不绑定到另一次独立读取的版本。
