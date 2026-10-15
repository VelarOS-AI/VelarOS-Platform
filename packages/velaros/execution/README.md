# @velaros-ai/velaros/execution

宿主拥有的进程执行基础设施：Node 进程的操作系统约束、实时输出、取消与进程树清理，以及产品终端和后台任务的生命周期。命令管道使用 Execa，交互终端使用宿主注入的 PTY。

## 用法

```ts
import { createNodeExecutionEnvironment, createRuntime } from '@velaros-ai/velaros'
import { createLocalShellHost } from '@velaros-ai/velaros/execution/local'

const cwd = '/absolute/workspace'
const host = createLocalShellHost({cwd, processConfinement: {mode:'workspace-write', workspaceRoot:cwd}})
const runtime = await createRuntime({
  workspace:cwd,
  dataDir:'/absolute/state',
  node:createNodeExecutionEnvironment({cwd,directory:'/absolute/state/node',host}),
})
try {
  const session = await runtime.openSession('example')
  await session.context.append({kind:'user',body:'检查 Node 版本'})
  await session.execute({source:"import {execa} from 'execa';console.log((await execa(process.execPath,['--version'])).stdout)"})
} finally {
  await runtime.close()
  await host.dispose()
}
```

## 入口

| 入口 | 环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros/execution` | 可移植 | 宿主契约、命令风险分类与审批请求构造 |
| `@velaros-ai/velaros/execution/contracts` | 可移植 | 进程、环境、终端数据与常量 |
| `@velaros-ai/velaros/execution/local` | Node | `createLocalShellHost`、`createShellEnvironment`、`createConfinedShellRunner`、`createNpmClient`、`createLocalNodeValidationHost` |

执行授权发生在 Node 启动之前；操作系统权限覆盖该进程及其子进程。能力 RPC 另外使用领域授权。约束结果报告实际覆盖范围：macOS 文件写约束为 partial，缺少约束后端时拒绝启动。源码中的 Execa 调用遵循其原生 API。

共享登录环境由应用创建并负责关闭，工作区宿主借用它。执行结束或取消时回收所属进程树；Windows 使用 Job Object，交互终端由 PTY 提供者管理。输出按字节接收后解码 UTF-8，并如实保留退出、截断和清理状态。

`createNpmClient` 使用宿主提供的 Node、npm CLI、私有缓存和 ShellHostPort 查询 registry、安装或按锁文件恢复依赖；沿用宿主约束、输出、取消与进程树回收。Skill 安装和 agent 自管环境共用此执行机制。

本机命令回执的 `ownership.cleanupScope` 声明实际清理边界：POSIX 为原进程组，Windows 原生 Job 宿主为 Job，Windows 回退为当前可见进程树。`detachedDescendants: unknown` 表示脱组后代的收束未确认，`cleanupIncomplete: false` 和根命令退出 0 均不能证明它们已结束。长期工作使用受管后台任务的身份、输出和停止回执；进程组清理不承担未登记后台服务的生命周期。

`createLocalNodeValidationHost` 将带完整哈希的文本复制到只读输入区，通过现有进程监督执行有界 Node 验证。macOS 默认拒绝策略限制原工作区读取、网络、子进程和外部信号；每次先做真实边界预检，记录 Node、系统加载策略和宿主环境身份。仅独立临时目录可写，输出、期限及输入总量有界；取消后等待回收，缺少后端或清理证据时返回明确缺口。该后端尚无其他操作系统实现。
