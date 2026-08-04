# @velaros-ai/cli

`@velaros-ai/cli` 是 VelarOS 唯一的正式命令行发行包，也是 `velaros` 进程入口。
它同时公开可嵌入的命名空间 Router，供其他产品组装自己的非工具型运维命令。

它只负责命令行组合与稳定的输出信封，不承载模型工具，也不把 Project、System、Browser、
Office 或 Memory 的模型能力复制成另一套 CLI。领域原生命令已经能稳定完成的操作应直接调用
对应命令；需要宿主状态、权限与会话上下文的能力只留在 Mod 工具面。

## 给谁使用

- 用户、Agent 与 CI：通过 `velaros agent ...` 查看工作区 Agent 任务制品，通过
  `velaros serve ...` 启动或管理可选的无界面 Velar Host。
- 产品开发者：使用 `VelarosCliRouter` 显式注册产品自有的运维命名空间。

Desktop、Workbench 与 Extension 都不拥有这条命令；应用只在开发或部署流程中消费 CLI，
不会通过 Desktop IPC 转发它。

## 安装与命令

配置好 VelarOS GitHub Packages 权限后，全局安装 `@velaros-ai/cli` 即可获得唯一的 `velaros`
可执行文件；仓库开发依赖则使用 `bun add --dev @velaros-ai/cli`。不要单独从 Host 包寻找第二个入口。

```sh
npm install --global @velaros-ai/cli
# 或：bun add --global @velaros-ai/cli
```

```sh
velaros help
velaros agent manifest --json
velaros agent status --workspace-root . [--task-id <id>|--latest] [--full] [--json]
velaros serve [start] [--project-root /path/to/project] [--data-root /path/to/data]
velaros serve status [--data-root /path/to/data] [--json]
velaros serve control [--data-root /path/to/data]
velaros serve computer install [--data-root /path/to/data] [--python COMMAND] [--json]
```

`agent` 只读取 `.velaros/agent-runs`；`serve` 的 Host 实现、权限、数据根、控制页与 Extension
Bridge 全部仍由 `@velaros-ai/serve-host` 拥有，CLI 只注册并格式化它的命名空间结果。

## 公共入口

| 子路径 | 职责 |
| --- | --- |
| `@velaros-ai/cli` | `VelarosCliRouter`、`createVelarosCliRouter()` 与相关类型 |
| `@velaros-ai/cli/cli` | `main()` 与 Router 库面；导入无副作用，真实 bin 使用独立入口启动 |

默认注册 `agent` 与 `serve`。产品可以显式注入其他非工具型运维命名空间；路由器不维护领域
白名单，也不自动扫描 PATH 或安装目录，避免命令集合随机器环境漂移。

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

本包拥有命令路由、参数/结果契约、进程输出和官方命名空间装配；不拥有模型工具、存储、IPC、
UI 或 Host 运行时状态。Project、System、Browser、Office 与 Memory 的模型能力不会复制成
`velaros <domain> tools ...`。
