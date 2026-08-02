# @velaros-ai/cli

`@velaros-ai/cli` 是可嵌入的命令命名空间路由器，也是 `velaros` 进程入口。

它只负责命令行组合与稳定的输出信封，不承载模型工具，也不把 Project、System、Browser、
Office 或 Memory 的模型能力复制成另一套 CLI。领域原生命令已经能稳定完成的操作应直接调用
对应命令；需要宿主状态、权限与会话上下文的能力只留在 Mod 工具面。

## 公共入口

| 子路径 | 职责 |
| --- | --- |
| `@velaros-ai/cli` | `VelarosCliRouter`、`createVelarosCliRouter()` 与相关类型 |
| `@velaros-ai/cli/cli` | 与包根相同的库面；直接执行时启动 `velaros` |

默认只注册 `agent` 运维命名空间，用于读取 `.velaros/agent-runs` 中的 manifest 和运行状态。
产品可以显式注入其他非工具型运维命名空间；路由器不维护领域白名单。

```ts
import { VelarosCliRouter } from '@velaros-ai/cli'

const router = new VelarosCliRouter({
  includeBuiltinNamespaces: false,
  namespaces: {
    acme: async (argv, { cwd }) => ({
      exitCode: 0,
      text: `cwd=${cwd}; args=${argv.join(',')}\n`,
    }),
  },
})

const result = await router.run(['acme', 'status'], { cwd: process.cwd() })
```

## 边界

- 路由方向始终是 router → namespace；namespace 不回调 router。
- 路由器只依赖 `text`、`exitCode` 和可选的透明 `envelope`。
- 未知命名空间与子命名空间异常都会被收成可打印结果，库入口不退出进程。
- 构造后的命名空间集合冻结，可并发调用。

本包不拥有工具实现、存储、IPC、UI 或宿主运行时状态。
