# @velaros-ai/cli

**可嵌入的命令命名空间路由器**(capabilities 域,住 `packages/cli`;
2026-07-30 QI 批从 `packages/capabilities/` 提到顶层,和其余能力包平级)。
它提供 `velaros` 这个 bin,以及一条把各领域包的 CLI runner 组合成一个命令行的装配线。

**本包只做组合。** 它不含任何工具实现——`velaros workspace …` 的活是
`@velaros-ai/workspace` 干的,本包只负责把 `argv[0]` 派给它。

## 分区

| 入口 | 内容 |
| --- | --- |
| `@velaros-ai/cli` | 库面:`VelarosCliRouter` / `createVelarosCliRouter()` / `runVelarosCli` / `main` 与相关类型 |
| `@velaros-ai/cli/cli` | 进程入口,同时是 bin `velaros` 的目标 |

两个入口导出同一组符号(`cli.ts` 把 `router.ts` 原样转出),
区别只在于 `/cli` 被直接执行时会自跑 `main()`。

## 内置命名空间

| 命名空间 | 实现在哪 |
| --- | --- |
| `workspace` | `@velaros-ai/workspace/cli` |
| `system` | `@velaros-ai/system-tools/cli` |
| `office` | `@velaros-ai/office-tools/cli` |
| `agent` | **本包自己的 `src/agent.ts`** |

`agent` 命名空间是唯一住在本包里的实现,而且它**不依赖 `@velaros-ai/agent`**:
它只读工作区里 `.velaros/agent-runs` 下的任务产物文件(`help` / `manifest` / `status`),
所以 CLI 不会因此拽进整个 agent 执行栈。

`BuiltinNamespaceRunners` 是**产品默认集,不是准入白名单**——
`includeBuiltinNamespaces: false` 可以整组关掉,做一个只有自己命名空间的最小 CLI。

## 设计要点

- **方向铁律**:router → 命名空间是**单向**的。命名空间不认识 router,也不许回调它。
  加命名空间走 `createVelarosCliRouter({ namespaces })` 注册,**不改本包源码**。
- **router 只消费 `text` 与 `exitCode`**。stdout / stderr 往哪写、
  进程退出码是多少,由宿主(`main()`)按这两个字段决定。
- **`envelope` 刻意不钉死结构**,router 原样透出。
  它由各命名空间自持:workspace 自持 `workspaceRoot` 轴的信封
  (错误 kind = `velaros.workspaceCli.error`),其余命名空间走 core 的
  `namespace` / `command` / `cwd` 轴。两者在 `text` / `exitCode` 上一致,所以透传是安全的。
  **不要在 router 里重建 envelope**:`text` 已由各命名空间自己序列化完毕,
  只改 `envelope` 会让同一个结果的两个字段自相矛盾;要统一就得连 `text` 一起改,
  那会改掉 `velaros workspace … --json` 的 stdout,属跨包契约决策。
  第三方命名空间甚至可以完全不给 envelope。
- **router 自身永不向宿主抛**。未知命名空间 → `UNKNOWN_NAMESPACE`,退出码 2;
  命名空间抛出的任何异常都在 `run()` 里收成错误信封。宿主拿到的永远是可打印结果。
- 构造后命名空间集合被冻结,`run()` 可安全并发调用
  (领域 runner 自己支不支持并发是它自己的事)。**库入口从不主动退出进程**,
  嵌入式应用可以长期持有一个 router。

## 典型用法

产品发行版补上自己的命名空间:

```ts
import { createVelarosCliRouter } from '@velaros-ai/cli'

const run = createVelarosCliRouter({
  namespaces: {
    browser: runBrowserCli,
    memory: runMemoryCli,
  },
})
```

只要路由、不要内置命名空间:

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
process.stdout.write(result.text)
```

命令行:

```bash
velaros help
velaros agent manifest --json
velaros agent status --workspace-root . --json
```

## 可注入项

`CreateVelarosCliRouterOptions` 全部是为了让 router 可测、可嵌:

- `namespaces` —— 第三方 runner;
- `includeBuiltinNamespaces: false` —— 建最小路由器;
- `now` —— 确定性时钟;
- `resolveDefaultCwd` —— 宿主自己的工作目录解析器(默认 `process.cwd`)。

## 边界:本包不负责什么

不拥有工具实现、存储适配器、产品 IPC、渲染层 UI 或任何宿主专属运行时状态。
领域包各自暴露自己的 CLI runner,由应用发行版用 `createVelarosCliRouter()` 组合。

**browser-safe 的消费方应该直接从领域包的 `/contracts` 入口导入类型**,
不要指望 CLI 转发跨运行时契约——本包是 Node 进程面的东西。

## 相邻包

| 包 | 关系 |
| --- | --- |
| `@velaros-ai/core` | `@velaros-ai/core/cli` 提供参数解析、结构化输出信封、`VelarosCliError` |
| `@velaros-ai/workspace` / `system-tools` / `office-tools` | 三个内置命名空间的实现方 |

## 门

`check:capabilities-arch`(包集合冻结、入口冻结、依赖方向)、
`check:capabilities-schemas`。
