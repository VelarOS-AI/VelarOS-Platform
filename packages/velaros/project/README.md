# @velaros-ai/velaros/project

项目的两件能力：`velaros:project`（受项目治理的读、列、搜、改、看改动、撤销，改动走带版本防护的事务）与 `velaros:code`（问定义、引用、调用、依赖、影响面、诊断），连同底下的项目内核与语言服务。给项目空间的宿主用；项目里的命令、沙箱、看图用这里的 `projectCapabilityPorts` 装端口，装成项目空间是产品的事。

## 用法

```ts
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

// 宿主自己调用：读出连续的正文，按路径改，凭 changeRef 撤销
const context: ProjectOperationContext = { abortSignal: new AbortController().signal, project, sessionId: 'session-1' }
const [file] = (await projectFileOperations.read({ files: [{ path: 'src/index.ts', range: [1, 20] }] }, context)).files
if (file?.text.startsWith('// index')) {
  const change = await projectFileOperations.edit(
    { steps: [{ action: 'replace', path: 'src/index.ts', oldText: '// index', newText: '// 入口' }] },
    context
  )
  await projectFileOperations.undo({ changeRef: change.changeRef }, context)
}

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

- 路径按真实路径钳在项目根内，出了项目抛 `PERMISSION_DENIED`；没有读写名单、不问人。同一项目根上写串行、读并发（进程内的项目资源门），项目里的前台命令也排进这扇门。
- `read`、`search` 交回连续的正文（`text` 带第一行的行号 `startLine`）；`edit` 按路径指文件：`write` 整份写入（没有就新建），`replace` 把唯一的一段原文换掉。读取凭据由 `edit` 自己按路径取，不经调用方的手。
- 编辑作用在提交那一刻的内容上：`replace` 要换的原文被外部改没了抛 `TARGET_NOT_FOUND`，`write` 整份换掉、不核对读过的版本，被换掉的内容靠这次改动的 `undo` 找回。
- `changeRef` 按 `sessionId` 签发与核对（不给的调用共用一份），存在进程内存里、有条数上限，进程重启后全部作废。
- `edit` 的步骤合成一个事务，全成或全不成；失败时一个文件都没写，按 `error.code`（`ProjectErrorCodes` 里的码）分支，第几步、候选与下一步都在 message 里。
- `undo` 遇到外部改动抛 `CONFLICT_WITH_EXTERNAL_EDIT`、不覆盖，撤过的再撤是幂等成功；可撤销历史按条数和字节预算淘汰，被挤出去的撤销报 `NOT_SUPPORTED`。
- 读、列、搜不折叠，`ProjectFileLimits` 只为守内存：超了整个失败，批量读里装不下的文件进 `issues`；一个事务缺省最多改 `ProjectPolicyDefaults.maxChangedFilesPerTransaction` 个文件，建内核时用 `corePolicy` 调。
- 不给 `changeFeed` 时变更记录只在内存里；给了 `transactionStatePath`，重启建内核时恢复中断的提交或回滚，遇到归属不明的改动报 `TRANSACTION_RECOVERY_CONFLICT` 并保留现场。
- `velaros:code` 的语言动作由内置的 JS/TS、Python 语言服务答，答不准时结果带 `degraded`；图谱动作没有后端时 `query` 记成降级，`analyze` 抛 `UNAVAILABLE`。外部语言服务不下载命令，用完 `stop()`。
- 项目空间里的 `velaros:shell`、`velaros:sandbox`、`velaros:images` 用 `projectCapabilityPorts` 按每次调用的 `ProjectHostPort` 现装的端口：工作目录、沙箱源目录与图片都钳在项目内，宿主没给沙箱时沙箱操作报 `UNAVAILABLE`。
- `createRuntime({ workspace })` 已经按工作区装好 `velaros:project` 和 id 为 `project` 的证据源（`project: { code: true, images: true }` 时另挂 `velaros:code` 与项目里的 `velaros:images`），再挂同名模块或来源报 `VALIDATION`；要自己装就传 `project: false`，证据源用 `createProjectContextSource({ id, kernel })` 交进 `context.sources`。
