# @velaros-ai/cli

`@velaros-ai/cli` 是 VelarOS 唯一的正式命令行发行包，装出来的可执行文件叫 `velaros`。
它只做两件事：把命令行的第一段路由到对应的**运维命名空间**，以及给出稳定的输出信封与退出码。
命令本身不在它手里——`velaros terminal` 起的是独立发行的 Termel，产品自己的运维命令由产品注册进来。

它刻意不承载模型工具：Project、System、Browser、Office 与 Memory 的模型能力留在 Mod 工具面，
不会复制成 `velaros <域> tools ...` 的第二套入口。它也不扫 PATH、不读安装目录、不维护领域白名单，
命令集合只由代码里的注册决定，不随机器环境漂移。

## 给谁使用

- 终端用户：`velaros terminal` 启动独立安装的 Termel。
- 产品开发者：用 `createVelarosCliRouter()` 注册产品自有的运维命名空间，组一份自己的命令行。
- 自动化与 CI：所有命令都支持 `--json`，信封字段与错误码是稳定契约。

Desktop、Workbench 与 Extension 都不拥有这条命令，也不通过 IPC 转发它。

## 安装与命令

配置好 VelarOS GitHub Packages 权限后，全局安装即可获得 `velaros` 可执行文件；
仓库开发依赖用 `bun add --dev @velaros-ai/cli`。

```sh
npm install --global @velaros-ai/cli
# 或：bun add --global @velaros-ai/cli
```

```sh
velaros help          # 列出当前可用的命名空间（中文帮助）
velaros terminal      # 启动独立安装的 Termel，参数原样转交
velaros help --json   # 同样的内容，给自动化用的信封
```

`velaros terminal` 启动哪个命令由环境变量 `VELAROS_TERMEL_COMMAND` 决定，不设时是 `termel`；
本包不装配 Termel 的运行时、界面、权限、数据根、IPC 与 Extension Bridge，只负责把它起起来，
并把它的退出码原样透出。

## 公共入口

| 子路径 | 职责 |
| --- | --- |
| `@velaros-ai/cli` | 路由器 `velarosCli`、工厂 `createVelarosCliRouter()`、进程壳 `velarosCliProcess` 与它们的接口 |
| `@velaros-ai/cli/contracts` | 只有数据：信封的结构版本、错误码、退出码、环境变量表与信封的 TypeScript 形状 |

`./contracts` 整条引用链不碰 Node 内置模块，渲染进程与浏览器里解析 `--json` 输出的代码可以直接 import。
装出来的命令不在这两个入口里：`package.json` 的 `bin` 指向包根的 `bin/velaros.mjs`，
那是一个三行的壳，把 `process.argv` 与 `process.env` 交给 `velarosCliProcess`，判参数与算退出码都在包里的类上。

## 注册自己的命名空间

```ts
import { createVelarosCliRouter } from '@velaros-ai/cli'

const router = createVelarosCliRouter({
  includeBuiltinNamespaces: false,
  namespaces: {
    acme: (argv, { cwd }) => ({
      exitCode: 0,
      text: `cwd=${cwd}; args=${argv.join(',')}\n`,
    }),
  },
})

const result = await router.run(['acme', 'status'], { cwd: process.cwd() })
```

## 边界

- 路由方向始终是 router → namespace；namespace 不认识也不回调 router。
- 路由器只依赖命名空间返回的 `text` 与 `exitCode`，`envelope` 原样透出。
- 未知命名空间给 `UNKNOWN_NAMESPACE`（退出码 2），命名空间抛的异常收成 `EXECUTION_ERROR`（退出码 1）；
  库入口永不抛错、也不退出进程。
- 构造后的命名空间集合冻结，同一份路由器可以并发调用。
- 用户看得到的文字一律中文，命令名、错误码、环境变量名原样夹在里面；自动化按 `error.code` 判断，不按文字。

本包拥有命令路由、输出信封契约、进程输出与官方命名空间的装配；不拥有模型工具、存储、IPC、UI
与 Host 运行时状态。
