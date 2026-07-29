# @velaros-ai/cli 中文接口文档

## 定位与非目标

本包是可嵌入的命令命名空间路由器，默认组合 Workspace、System、Office 和 Agent 命名空间，也允许第三方应用只注册自己的命名空间。

本包不拥有领域实现、进程退出策略、输出流、产品状态或 UI。

## 安装

```bash
npm install @velaros-ai/cli
```

要求 Node.js 20 及以上。命令行可通过 `velaros` bin 使用。

## 公共入口

```ts
import {
  VelarosCliRouter,
  createVelarosCliRouter,
  runVelarosCli,
  type VelarosCliNamespaceRunner,
} from '@velaros-ai/cli'
```

`@velaros-ai/cli/cli` 额外导出进程入口 `main()`。

## 核心类与接口

- `VelarosCliRouter`：不可变的命名空间注册表和路由对象。
- `VelarosCliNamespaceRunner`：单个命名空间的最小执行协议。
- `createVelarosCliRouter()`：兼容函数式调用方的 facade。
- `runVelarosCli`：带内置命名空间的无状态默认 runner。
- `main()`：唯一负责写 stdout/stderr 和设置 `process.exitCode` 的进程入口。

## 生命周期/并发

构造后命名空间集合被冻结，可安全并发调用 `run()`。领域 runner 是否支持并发由各自实现决定。库入口从不主动退出进程；嵌入式应用可以长期持有一个 router。

## 依赖注入

构造选项支持：

- `namespaces`：第三方 runner；
- `includeBuiltinNamespaces: false`：创建最小路由器；
- `now`：可测试时钟；
- `resolveDefaultCwd`：宿主工作目录解析器。

## 错误模型

路由错误使用 `VelarosCliError`，并由 `formatVelarosCliError()` 转成稳定的 `VelarosCliRunResult`。未知命名空间返回退出码 2；库调用不会直接抛出可预期的命令错误。

## 最小第三方示例

```ts
import { VelarosCliRouter } from '@velaros-ai/cli'

const router = new VelarosCliRouter({
  includeBuiltinNamespaces: false,
  namespaces: {
    acme: async (argv, { cwd }) => ({
      exitCode: 0,
      json: false,
      text: `cwd=${cwd}; args=${argv.join(',')}\n`,
    }),
  },
})

const result = await router.run(['acme', 'status'], {
  cwd: process.cwd(),
})
process.stdout.write(result.text)
```

## 扩展点

第三方应用通过命名空间注册扩展，不需要修改本包。runner 应返回结构化 `VelarosCliRunResult`，避免直接写流或修改进程退出码。

## 兼容策略

`createVelarosCliRouter()` 和 `runVelarosCli` 保持原行为。`VelarosCliRouter` 是新增的对象式 API；禁用内置命名空间是显式选择，不影响现有消费方。

`0.2.10` 使用 Workspace `1.2.5`、System Tools `0.2.8` 与 Office Tools `0.2.7`
重建内置命名空间，不改变 CLI 路由协议。Office `0.2.7` 的环境平台字段为宿主中立、
前向兼容契约。浏览器侧共享类型应直接从各领域包的 `/contracts` 入口导入，CLI
不承担跨运行时契约转发。
