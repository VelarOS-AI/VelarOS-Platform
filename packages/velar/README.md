# @velaros-ai/velar

模型在程序里 import 的能力单元：`velar:files`、`velar:images`、`velar:shell`、`velar:sandbox`。
一件能力一个目录，目录名就是模块名（`velar:files` ⇄ `files/`）；每个空间挂哪几件、给每件装什么端口，由空间的装配表决定
（系统空间在 `@velaros-ai/system`，项目空间在 `@velaros-ai/project`）。

| 单元 | 模型写 | 做什么 | 谁挂 |
| --- | --- | --- | --- |
| `files/` | `import { read, edit, undo } from 'velar:files'` | 本机文件：带行号地读、按行号改或整份写、整次撤回 | 系统空间 |
| `images/` | `import { view } from 'velar:images'` | 把图片交到模型眼前，超出上限的请宿主压 | 系统空间、项目空间 |
| `shell/` | `import { run, listTasks, refreshEnvironment } from 'velar:shell'` | 跑命令、看后台任务、刷新 shell 环境 | 系统空间、项目空间 |
| `sandbox/` | `import { create, run, diff, apply, discard } from 'velar:sandbox'` | 演练沙箱：在镜像里先跑，看过变化再落回 | 系统空间、项目空间 |

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
  template.js     代码模版：一整份能照抄的程序，嵌进生成声明的模块头
  spec/           不变量登记 invariants.md 与验收测试 acceptance.test.ts
  test/           实现细节测试
```

模型看到的声明从源码生成（`baselines/code-surface/<单元>.d.ts`，`bun run generate:code-surface`），
门禁：`bun run check:module-ownership`、`bun run check:code-surface`。
