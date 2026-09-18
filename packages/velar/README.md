# @velaros-ai/velar

模型在程序里 import 的能力单元：`velar:files`、`velar:images`、`velar:shell`、`velar:sandbox`、`velar:computer`、`velar:knowledge`，以及项目的两件 `velar:project`、`velar:code`。
这里只放工具：没有模型面的实现（语言服务、知识库引擎、本机宿主）是各自的包，宿主拿它们实现单元的空间端口。
一件能力一个目录，目录名就是模块名（`velar:files` ⇄ `files/`；问代码离不开项目内核，和 `velar:project` 同住 `project/`）；每个空间挂哪几件、给每件装什么端口，由空间的装配表决定
（系统空间在 `@velaros-ai/system`，项目空间在 `@velaros-ai/project`）。

| 单元 | 模型写 | 做什么 | 谁挂 |
| --- | --- | --- | --- |
| `files/` | `import { read, edit, undo } from 'velar:files'` | 本机文件：带行号地读、按行号改或整份写、整次撤回 | 系统空间 |
| `images/` | `import { view } from 'velar:images'` | 把图片交到模型眼前，超出上限的请宿主压 | 系统空间、项目空间 |
| `shell/` | `import { run, listTasks, stop, refreshEnvironment } from 'velar:shell'` | 跑命令、看和停后台任务、刷新 shell 环境 | 系统空间、项目空间 |
| `sandbox/` | `import { create, run, diff, apply, discard } from 'velar:sandbox'` | 演练沙箱：在镜像里先跑，看过变化再落回 | 系统空间、项目空间 |
| `project/` | `import { read, list, search, edit, inspect, undo } from 'velar:project'`、`import { query, analyze } from 'velar:code'` | 受项目治理的文件（fileRef、事务、撤销）与问代码，连同底下的项目内核 | 项目空间 |
| `computer/` | `import { screenshot, move, click, typeText, key } from 'velar:computer'` | 桌面控制：截主屏交给模型看，按截图坐标移动、点击，输入文字、按组合键；底下是管 Python helper 子进程的运行时与随包的 helper 脚本 | 宿主装了桌面控制插件时，挂在它的系统空间上 |
| `knowledge/` | `import { search, sync, diagnostics } from 'velar:knowledge'` | 工作区知识检索：全文加语义的混合检索、增量同步、看索引健康；知识库本身是 `@velaros-ai/knowledge` | 宿主开了知识库的空间 |

宿主按 `@velaros-ai/velar/<单元>` 引用（可移植数据在 `@velaros-ai/velar/<单元>/contracts`）。

## 单元的规范

每个单元目录长得一样，是普通的文件目录，不是单独的包：

```text
<单元>/
  MODULE.md       模块卡片：是什么、提供什么、骨干链路、依赖、状态、失败语义、不变量、非目标、结构
  index.ts        入口，只转发：操作、空间端口、它们用到的数据
  contracts.ts    可移植数据入口：常量表与不碰 Node 的类型
  contract/       provides.ts（操作的 API 登记）、requires.ts（空间端口与调用上下文）、constants.ts（错误码与公开上限）
  types/          只放类型；模型面上的类型带 @AgentView
  impl/           一类一文件：操作类（接口写在类上方，方法带 @AgentView 的才进模型面）
  utils/          纯函数与可调参数（tuning.ts）
  template.js     代码模版：日常用法的示例程序，只是示例、不要求照着写（一个单元出两件能力时，另一件的模版叫 <模块>-template.js）
  spec/           不变量登记 invariants.md 与验收测试 acceptance.test.ts
  test/           实现细节测试
```

模型看到的声明从源码生成（`baselines/code-surface/<单元>.d.ts`，`bun run generate:code-surface`），
门禁：`bun run check:module-ownership`、`bun run check:code-surface`。

## 项目内核：宿主怎么建

`project/` 单元里的项目内核按项目根建一个，经项目空间（`@velaros-ai/project`）的宿主端口交给两件工具。
需要跨进程重启继续 apply/rollback 的宿主，把事务状态和变更记录放在宿主私有目录，
并把有限事务面（只有 `list/get/subscribe/apply/rollback`，拿不到项目根、状态路径、provider）交给界面那一侧；路径只在宿主侧出现：

```ts
import { createFileProjectChangeFeed, createProjectKernel, createProjectTransactionController } from '@velaros-ai/velar/project'

const changeFeed = createFileProjectChangeFeed({ path: hostOwnedChangeFeedPath })
const project = await createProjectKernel({
  root: authorizedProjectRoot,
  changeFeed,
  transactionStatePath: hostOwnedTransactionStatePath,
})

const transactions = createProjectTransactionController(project)
```

`transactionStatePath` 启用写前恢复计划：apply/rollback 在第一处项目文件写入前先提交计划，成功后再原子提交终态。
重启发现中断操作时，只会还原「原状态」或能证明属于该事务的内容；遇到无法归属的外部编辑会以 `TRANSACTION_RECOVERY_CONFLICT` 拒绝覆盖并保留现场。
变更记录是可重建的审计投影，不能领先或否定事务主状态。
