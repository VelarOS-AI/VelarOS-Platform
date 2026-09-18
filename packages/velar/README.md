# @velaros-ai/velar

模型在程序里 import 的能力单元：`velar:files`、`velar:images`、`velar:shell`、`velar:sandbox`、`velar:computer`、`velar:knowledge`、`velar:memory`、`velar:office`，以及项目的两件 `velar:project`、`velar:code`。
带工具的包整个搬进来，实现一起：单元底下就是服务它的那套实现（项目内核、桌面控制的 helper 运行时、知识库、记忆库、办公文档的生成与转换），外面不留第二份。
没有模型面的东西（语言服务、本机宿主）不是工具，是各自的包，宿主拿它们实现单元的空间端口。
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
| `knowledge/` | `import { search, sync, diagnostics } from 'velar:knowledge'` | 工作区知识检索：全文加语义的混合检索、增量同步、看索引健康；底下是知识库本身（摄入、分块、SQLite 全文与 LanceDB 向量索引、嵌入 profile 隔离、显式重建） | 宿主开了知识库的空间 |
| `memory/` | `import { save, search, get, archive } from 'velar:memory'` | 跨会话的长期记忆：写一条、按当前空间召回、按 id 读、归档；底下是记忆库本身（证据、树与文件与向量三档后端、接进内核的三端口适配器、回合召回） | 宿主开了长期记忆的空间 |
| `office/` | `import { createWord, createPresentation, createSpreadsheet, readPdf, wordToPdf, latexToPdf, editPdf, preview, toMarkdown } from 'velar:office'` | 办公文档：生成 Word、PowerPoint、Excel，读 PDF 的文字、编辑 PDF，Word 与 LaTeX 转 PDF，预览文档、转 Markdown；底下是文档生成、解析与渲染的全部实现，随包审过的 PptxGenJS，以及给 Document Renderer 的窄渲染面（`./office/renderer`） | 宿主挂在要写文档的空间上，端口给工作区根与跑外部命令的那一份 |

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
  test/           实现细节测试；要原生依赖或真实计时的探针放 test/probes/（不进 bun test，由仓库脚本拉起）
```

单元自带、随包发布的非代码资产（比如 `computer/runtime/` 的 Python helper、`office/vendor/` 的 PptxGenJS）登记在所有权门的 `assets` 里，并写进包清单的 `files`。

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
