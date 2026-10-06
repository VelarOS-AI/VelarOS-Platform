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
| `@velaros-ai/velaros/execution/local` | Node | `createLocalShellHost`、`createShellEnvironment`、`createConfinedShellRunner` |

执行授权发生在 Node 启动之前；操作系统权限覆盖该进程及其子进程。能力 RPC 另外使用领域授权。约束结果报告实际覆盖范围：macOS 文件写约束为 partial，缺少约束后端时拒绝启动。源码中的 Execa 调用遵循其原生 API。

共享登录环境由应用创建并负责关闭，工作区宿主借用它。执行结束或取消时回收所属进程树；Windows 使用 Job Object，交互终端由 PTY 提供者管理。输出按字节接收后解码 UTF-8，并如实保留退出、截断和清理状态。
