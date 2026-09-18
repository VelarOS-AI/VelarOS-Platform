# @velaros-ai/project

项目空间包：一个项目根里的读取、编辑、事务、代码查询，以及项目空间的装配表。只有两个入口：

- `@velaros-ai/project`：给 Node 宿主。项目空间 `createProjectSpace`、两件项目独有的能力（`velar:project` 的 `projectFileOperations`、
  `velar:code` 的 `projectCodeOperations`）、领域内核 `createProjectKernel`、有限事务面、落盘变更记录、审批桥，
  注入面（宿主端口、provider、插件扩展点）以及它们用到的数据类型。
- `@velaros-ai/project/contracts`：可移植数据，浏览器和渲染进程也能用：常量表与经过宿主端口流动的数据类型。

## 项目空间

模型写程序、import 能力模块。项目空间挂五个：

```text
velar:project   read / list / search / edit / inspect / undo   受项目治理的文件（本包）
velar:code      query / analyze                               代码之间的关系（本包）
velar:shell     run / listTasks / refreshEnvironment          命令（@velaros-ai/velar 的 shell，项目端口）
velar:sandbox   create / run / diff / apply / discard         演练沙箱（@velaros-ai/velar 的 sandbox，项目端口）
velar:images    view                                          看图（@velaros-ai/velar 的 images，项目端口）
```

宿主用 `createProjectSpace({ resolveCall })` 装：每次调用给一份 `ProjectCallContext`（宿主端口 `ProjectHostPort`、审批端口、取消信号、会话），
操作表交给代码面的 `createCapabilityPort`。模型看到的是生成的声明（`baselines/code-surface/project.d.ts`、`code.d.ts`）与代码模版
（`templates/project.js`、`templates/code.js`）。

## 读和改

`read` 交回带行号的源码窗口：`lines` 每项 `[行号, 原文]`，长行给带列范围的 `fragments`；窗口上的 `fileRef` 绑定路径、版本和实际交给程序的那几行。
没读完的带 `continuation`，原样传回接着读。被脱敏遮住的窗口只能看、不给 `fileRef`。

`edit` 的 `steps` 一步一个目标（`create/overwrite/move/delete/recode/edit`），编成一个事务：全成或全不成、一次确认、跑校验器、一个 `changeRef`；
`inspect` 看差量，`undo` 整次撤销（外部改过拒绝覆盖，撤过的幂等成功）。`edit` 步是一个文件加它的几处 `replace/insert`：
`range` 选整行、`match` 选一段唯一的原文，两个一起给最稳；行号都按读到的那一版算。只能改 fileRef 看得到的行；
`overwrite` 要求看过全文，`move`、`delete` 只核对版本。回执带改动处的新窗口（新 `fileRef`），接着改不用重读。

文件在读完之后被改过时整批拒绝（`BASE_REVISION_MISMATCH`）；原来要改的地方还唯一时，message 给出新行号与签了新 fileRef 的确认窗口。
程序只看得见 `error.code` 与 `error.message`：code 是 `ProjectErrorCodes` 的原因码，第几步第几处、候选、诊断与下一步都写在 message 里。

新建文本文件统一是 UTF-8、无 BOM、LF；现有文件的磁盘编码、BOM 与换行由底层维护，只有 `recode` 步骤改磁盘编码（正文不变，可撤销）。
默认事务预算为 100 个文件、每文件净变更 20,000 行、每事务净变更 50,000 行；宿主可通过 `corePolicy` 收紧或扩大。
revision 默认使用内容指纹，能检测同大小、保留 mtime 的外部修改；文本写入经同目录临时文件、同步与原子替换提交。

## 内部结构

按仓库标准（`docs/architecture/module-ownership.md`）分层：`contract/`（产品面、注入面、常量表）、`types/`（只有类型；`files.ts` 与 `code.ts` 是两件能力的模型面，
`project.ts` 是可移植数据）、`impl/`（一类一文件；`ProjectSpace.ts` 是装配表，`operations/` 是两件能力的操作与资源门，`kernel/` 是领域内核，
`plugins/`、`transactions/`、`files/`、`strategies/`、`adapters/`、`registries/`、`persistence/` 依次往下）、`utils/`（纯函数与可调参数；
`agent/` 是两件能力的适配层，`editing/` 是编辑规划）。模块卡片见 [MODULE.md](./MODULE.md)，不变量见 [spec/invariants.md](./spec/invariants.md)。

## 可恢复事务与 Desktop 边界

需要跨进程重启继续 apply/rollback 的宿主，应把状态和 ChangeFeed 放在宿主私有目录，
并把有限事务面（只有 `list/get/subscribe/apply/rollback`，拿不到项目根、状态路径、provider）交给 UI transport；路径只在 host 侧出现：

```ts
import { createFileProjectChangeFeed, createProjectKernel, createProjectTransactionController } from '@velaros-ai/project'

const changeFeed = createFileProjectChangeFeed({ path: hostOwnedChangeFeedPath })
const project = await createProjectKernel({
  root: authorizedProjectRoot,
  changeFeed,
  transactionStatePath: hostOwnedTransactionStatePath,
})

const transactions = createProjectTransactionController(project)
```

`transactionStatePath` 启用写前恢复计划：apply/rollback 在第一处项目文件写入前先提交计划，
成功后再原子提交终态。重启发现中断操作时，只会还原“原状态”或能证明属于该事务的内容；
遇到无法归属的外部编辑会以 `TRANSACTION_RECOVERY_CONFLICT` 拒绝覆盖并保留现场。
ChangeFeed 是可重建的审计投影，不能领先或否定事务主状态。
