# @velaros-ai/velaros

模型在程序里 import 的 `velaros:*` 能力单元（连同它们底下的本机实现），加上把模型、脚本执行、Kernel 与上下文装成一条执行链的 Act 运行时。产品宿主用 `createRuntime` 开会话，按空间把各单元的能力挂进来；一个单元一个目录，各有自己的入口与 README。

## 用法

```ts
import { createRuntime } from '@velaros-ai/velaros'

const runtime = await createRuntime({
  workspace: '/absolute/project',
  dataDir: '/absolute/state',
  model: { provider: 'openai', model: 'your-model', apiKey: process.env.API_KEY },
})
try {
  const session = await runtime.openSession('main')
  for await (const event of session.submit('检查项目并完成修改和验证')) {
    if (event.type === 'accepted') console.log(event.text)
    else if (event.type === 'error') console.error(event.message)
  }
} finally {
  await runtime.close()
}
```

默认执行环境为 Node.js ESM，预装 Execa、@vscode/ripgrep、globby、diff 与 yaml。模型通过 `exec({code})` 运行程序，文件操作使用 Node 标准库。项目工作区按需提供 `velaros:project` 的版本核对、原子提交和冲突撤回；应用能力通过运行目录中的 `index.json` 和操作声明发现。


## 入口

| 单元 | 入口 | 做什么 |
| --- | --- | --- |
| [act/runtime](act/runtime/README.md) | `@velaros-ai/velaros`、`@velaros-ai/velaros/contracts`、`@velaros-ai/velaros/renderer` | Act 运行时：`createRuntime`、会话与运行事件、把能力挂进来的工厂、给渲染进程的事件投影 |
| [act/system](act/system/README.md) | `@velaros-ai/velaros/act/system` | 模型自管理的 `velaros:system`：发现能力、会话目标、任务笔记与长期记忆、持久空间 |
| [act/search](act/search/README.md) | `@velaros-ai/velaros/act/search` | 有界高级搜索 `velaros:search` 与搜索支线里的证据读取 `velaros:evidence` |
| [act/agents](act/agents/README.md) | `@velaros-ai/velaros/act/agents` | 子任务 `velaros:agents` 与用户交互 `velaros:interaction` |
| [execution](execution/README.md) | `@velaros-ai/velaros/execution`、`/execution/local` | 宿主进程权限、环境、终止与终端管理 |
| [images](images/README.md) | `@velaros-ai/velaros/images` | 看图 `velaros:images`：把图片交到模型眼前 |
| [sandbox](sandbox/README.md) | `@velaros-ai/velaros/sandbox` | 演练沙箱 `velaros:sandbox`：在镜像里先跑，看过差量再落回 |
| [project](project/README.md) | `@velaros-ai/velaros/project` | 受项目治理的文件 `velaros:project` 与问代码 `velaros:code`，连同项目内核与语言服务 |
| [computer](computer/README.md) | `@velaros-ai/velaros/computer` | 桌面控制 `velaros:computer`：截主屏、鼠标、键盘 |
| [memory](memory/README.md) | `@velaros-ai/velaros/memory` | 长期记忆库：一个作用域一个目录的 Markdown，会话开场的索引 |
| [office](office/README.md) | `@velaros-ai/velaros/office` | 办公文档 `velaros:office`：Word、PowerPoint、Excel 与 PDF 的生成、读取、转换与预览 |
| [browser](browser/README.md) | `@velaros-ai/velaros/browser` | 浏览器 `velaros:browser`、`velaros:devtools`、`velaros:cdp`，连同 CDP 驱动与 Electron 会话运行时 |
| [web](web/README.md) | `@velaros-ai/velaros/web` | 网上查资料 `velaros:web`：搜索引擎搜、把网页读成文字，都在宿主给的不显示页面里跑 |
| [sessions](sessions/README.md) | `@velaros-ai/velaros/sessions` | 会话之间交活、传话 `velaros:sessions`：同一个对话里的会话互相交活、等回答、捎话，会话的一切在宿主那里 |

各单元的子入口（`/contracts` 的可移植数据、`/local` 的本机实现、`/renderer`、`/electron`）见单元 README；模型能 import 的系统操作与可用条件见 [Act 能力目录](act/README.md)。
