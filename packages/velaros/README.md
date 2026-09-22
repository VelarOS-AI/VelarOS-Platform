# @velaros-ai/velaros

正式入口 `await createRuntime({workspace, dataDir, model})` 装配同一 ScriptAct / Kernel / Context 主干。模型用 observe 维护每轮重跑的只读观察程序，用 execute 执行一次性代码；结果根据租约进入上下文。源码检查与发布先于操作派发，外部世界效果由各操作回执记录。见 [统一执行架构](../../docs/architecture/platform-runtime.md) 与 [运行时卡片](act/runtime/MODULE.md)。

```ts
import {createRuntime} from '@velaros-ai/velaros';
const runtime = await createRuntime({
  workspace: '/absolute/project',
  dataDir: '/absolute/agent-state',
  model: {
    provider: 'openai', model: 'your-model', baseURL: 'https://your-provider/v1',
    apiKey: process.env.MODEL_API_KEY!, reasoningLevel: 'high',
  },
});
try {
  const session = await runtime.openSession('work');
  for await (const event of session.submit('调查当前项目并完成任务')) {
    // 处理 text/program/state/verification/interaction 事件。
  }
  const trace = await runtime.trace('work'); // 原始请求、回复、脚本、回执及支线目录
} finally { await runtime.close(); }
```

指定 dataDir 时，项目事务状态也持久保存在按工作区绑定的私有路径，启动时复用项目内核的中断恢复。工作区预设包含项目文件、持久 store、长期记忆、worker 子任务与 standard 搜索档位。可用 agents/search/memory=false 关闭；特定业务模块通过 modules 注入，全部进入同一注册、权限和执行链。模型用 agents.profiles()/search.profiles() 选择实际档位。


模型自管理模块集中在 [act/system/](act/system/MODULE.md)，统一通过 `velaros:system` 导入；[入口模板](act/system/template.js) 与各成员模板展示真实用法。会话与脚本机制在 `act/runtime/`，高级搜索和任务委派分别在 `act/search/`、`act/agents/`。完整成员、操作和运行模式见 [Act 能力目录](act/README.md)。

模型在程序里 import 的能力单元：`velaros:files`、`velaros:images`、`velaros:shell`、`velaros:sandbox`、`velaros:computer`、`velaros:office`，项目的两件 `velaros:project`、`velaros:code`，以及浏览器的两件 `velaros:browser`、`velaros:devtools`。
带工具的包整个搬进来，实现一起：单元底下就是服务它的那套实现（项目内核、桌面控制的 helper 运行时、记忆库、办公文档的生成与转换、浏览器的驱动与会话运行时，
以及命令、沙箱、文件、看图在本机上的端口实现），外面不留第二份。没有模型面的东西（语言服务）不是工具，是各自的包。
一件能力一个目录，目录名就是模块名（`velaros:files` ⇄ `files/`；问代码离不开项目内核，和 `velaros:project` 同住 `project/`；`velaros:devtools` 与 `velaros:browser` 共用一个端口，同住 `browser/`）。
常规工作区由 createRuntime 装配。宿主需要浏览器、命令、办公或其他业务能力时，从对应单元取得端口并通过 modules 扩展；具体资源范围由该端口和统一 authorize 检查。memory 单元提供长期记忆的存储实现，模型通过 velaros:system.memory 使用。

| 单元 | 模型写 | 做什么 | 谁挂 |
| --- | --- | --- | --- |
| `files/` | `import { read, edit, undo } from 'velaros:files'` | 本机文件：带行号地读、按行号改或整份写、整次撤回 | 系统空间 |
| `images/` | `import { view } from 'velaros:images'` | 把图片交到模型眼前，超出上限的请宿主压 | 系统空间、项目空间 |
| `shell/` | `import { run, listTasks, stop, refreshEnvironment } from 'velaros:shell'` | 跑命令、看和停后台任务、刷新 shell 环境 | 系统空间、项目空间 |
| `sandbox/` | `import { create, run, diff, apply, discard } from 'velaros:sandbox'` | 演练沙箱：在镜像里先跑，看过变化再落回 | 系统空间、项目空间 |
| `project/` | `import { read, list, search, edit, inspect, undo } from 'velaros:project'`、`import { query, analyze } from 'velaros:code'` | 受项目治理的文件（fileRef、事务、撤销）与问代码，连同底下的项目内核 | 项目空间 |
| `computer/` | `import { screenshot, move, click, typeText, key } from 'velaros:computer'` | 桌面控制：截主屏交给模型看，按截图坐标移动、点击，输入文字、按组合键；底下是管 Python helper 子进程的运行时与随包的 helper 脚本 | 宿主装了桌面控制插件时，挂在它的系统空间上 |
| `office/` | `import { createWord, createPresentation, createSpreadsheet, readPdf, wordToPdf, latexToPdf, editPdf, preview, toMarkdown } from 'velaros:office'` | 办公文档：生成 Word、PowerPoint、Excel，读 PDF 的文字、编辑 PDF，Word 与 LaTeX 转 PDF，预览文档、转 Markdown；底下是文档生成、解析与渲染的全部实现，随包审过的 PptxGenJS，以及给 Document Renderer 的窄渲染面（`./office/renderer`） | 宿主挂在要写文档的空间上，端口给工作区根与跑外部命令的那一份 |
| `browser/` | `import { open, inspect, click, fill, screenshot, waitForSelector, table, content } from 'velaros:browser'`、`import { diagnostics, request, startTrace } from 'velaros:devtools'` | 浏览器：进站、看页面、按元素或坐标动手、等、取表格列表正文、下载与导出；排障时读控制台与网络、调页面条件、录 trace 与录屏、管用户脚本。底下是 CDP 驱动、页面引擎、Electron 会话运行时与站点工作区 | 宿主的浏览器空间；项目空间可以客居 |

宿主按 `@velaros-ai/velaros/<单元>` 引用（可移植数据在 `@velaros-ai/velaros/<单元>/contracts`）。
端口在本机上的实现只给 Node，各在单元的 `./local` 入口：`shell/local`（本机 shell 宿主：跑命令、后台任务、交互式控制台、shell 选择、进程约束，
外加宿主界面要的进程、端口、资源快照与环境体检；受约束执行器）、`sandbox/local`（本机演练沙箱）、`files/local`（本机文件端口、全局搜索）、
`images/local`（本机看图端口，macOS 上用 sips 缩图）。它们的接口与配置从单元根入口导出。

## 单元的规范

单元按 [模块所有权规范](../../docs/architecture/module-ownership.md) 登记，不单独发布包。通常使用以下布局；单份类型或参数可以直接登记成文件，Act 的具体目录见 [能力目录](act/README.md)：

```text
<单元>/
  MODULE.md       模块卡片：是什么、提供什么、骨干链路、依赖、状态、失败语义、不变量、非目标、结构
  index.ts        入口，只转发：操作、空间端口、它们用到的数据
  contracts.ts    可移植数据入口：常量表与不碰 Node 的类型
  local.ts        本机实现入口（有的单元才有）：空间端口在本机上的实现，只给 Node
  contract/       provides.ts（API 登记）、requires.ts（宿主端口）、constants.ts（公开常量）、生成的 surface.ts
  types/          只放类型；领域代码面类型带 @AgentView
  impl/           一类一文件，接口写在类上方；领域能力使用 @AgentView，系统模块在这里声明 Kernel 操作定义
  utils/          纯函数与可调参数（tuning.ts）
  template.js     按需返回的代码模版：日常用法的示例程序，只是示例、不要求照着写（一个单元出两件能力时，另一件的模版叫 <模块>-template.js）
  spec/           不变量登记 invariants.md 与验收测试 acceptance.test.ts
  test/           实现细节测试；要原生依赖或真实计时的探针放 test/probes/（不进 bun test，由仓库脚本拉起）
```

单元自带、随包发布的非代码资产（比如 `computer/runtime/` 的 Python helper、`office/vendor/` 的 PptxGenJS、`browser/vendor/` 的 DevTools 性能引擎、`shell/native/` 的 Windows 原生进程宿主）登记在所有权门的 `assets` 里，并写进包清单的 `files`。

模型看到的声明从源码生成（`baselines/script/<单元>.d.ts`，`bun run generate:script`），
门禁：`bun run check:module-ownership`、`bun run check:script`。

## 项目内核：宿主怎么建

`project/` 单元里的项目内核按项目根建一个，经宿主端口（`ProjectSpacePort` 的 `kernel()`）交给两件工具。
需要跨进程重启继续 apply/rollback 的宿主，把事务状态和变更记录放在宿主私有目录，
并把有限事务面（只有 `list/get/subscribe/apply/rollback`，拿不到项目根、状态路径、provider）交给界面那一侧；路径只在宿主侧出现：

```ts
import { createFileProjectChangeFeed, createProjectKernel, createProjectTransactionController } from '@velaros-ai/velaros/project'

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

## 项目语言服务

`@velaros-ai/velaros/project` 同时提供 `createProjectCodeQuery`、`languageQueries`、`createExternalLanguageService` 和 `typeScriptProjects`。宿主用 `createProjectCodeQuery(codeIndex)` 实现项目端口的 `queryCode`；语言服务只借 listFiles/read/listSymbols 三个只读方法，代码图谱仍由宿主提供。公开数据从 `@velaros-ai/velaros/project/contracts` 取。项目关闭时调用 `typeScriptProjects.release(projectRoot)`，外部语言服务实例调用 `stop()`。完整契约、失败语义与验收见 [项目模块卡片](project/MODULE.md)。
