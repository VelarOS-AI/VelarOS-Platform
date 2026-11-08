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
| `@velaros-ai/velaros/execution/local` | Node | `createLocalShellHost`、`createShellEnvironment`、`createConfinedShellRunner`、`createNpmClient` |

## 约定

执行授权发生在 Node 启动之前；操作系统权限覆盖该进程及其子进程。能力 RPC 另外使用领域授权。约束结果报告实际覆盖范围：macOS 文件写约束为 partial，缺少约束后端时拒绝启动。源码中的 Execa 调用遵循其原生 API。

共享登录环境由应用创建并负责关闭，工作区宿主借用它。执行结束或取消时回收所属进程树；Windows 使用 Job Object，交互终端由 PTY 提供者管理。输出按字节接收后解码 UTF-8，并如实保留退出、截断和清理状态。

控制台中断在 PTY 中发送 Ctrl+C，在 POSIX 管道中发送 SIGINT；Windows 管道没有终端软中断，核对受管身份后强制终止进程树并等待退出及管道关闭。根进程退出但管道仍未收齐，以及有界清理未完成，任务状态均为 `unknown`；只有真实、完整的收尾回执才报告 `exited`。未确认任务保留其资源归属，不计入可淘汰的已结束历史。

宿主可通过每次命令的 `onBackgroundTaskState` 观察后台任务登记与真实有界收尾；回调在记录写入后、历史裁剪前收到独立副本，任务很快完成也不会漏掉终态。迟到的真实 close 补交当前 `exited` 状态，原有界 `unknown` 回执保持当时事实。观察方失败不改变进程事实，也不阻断收尾。`dispose()` 关闭命令准入、取消准备并等待自有前后台进程实际收尾；未确认任务保留记录并以 `PLATFORM` 失败，失败后仍可查询和重试，不以清空任务表冒充回收完成。

拥有本次临时资源的宿主可在前台调用中设置 `waitForClose: true`：调用无论兑现还是拒绝，都已确认本次没有启动进程，或受管进程退出且输出管道真实关闭，随后才可回收该资源。超时与取消仍按有界策略终止，返回回执保留原有 `cleanupIncomplete`、超时和取消事实；等待真实关闭不会把未知回执改成成功。若物理进程仍未关闭，该调用继续等待，而 `dispose()` 仍有界报告清理未完成并保留 owner 供重试。此选项与 `background` 同传会在启动之前以 `VALIDATION` 拒绝。

`createNpmClient` 使用宿主提供的 Node、npm CLI、私有缓存和 ShellHostPort 查询 registry、安装或按锁文件恢复依赖；沿用宿主约束、输出、取消与进程树回收。Skill 安装和 agent 自管环境共用此执行机制。

本机命令回执的 `ownership.cleanupScope` 声明实际清理边界：POSIX 为原进程组，Windows 原生 Job 宿主为 Job，Windows 回退为当前可见进程树。`detachedDescendants: unknown` 表示脱组后代的收束未确认，`cleanupIncomplete: false` 和根命令退出 0 均不能证明它们已结束。长期工作使用受管后台任务的身份、输出和停止回执；进程组清理不承担未登记后台服务的生命周期。

系统进程快照中拿不到的 CPU 为 `null`，Windows 的 tasklist 只提供内存数据。`topProcesses` 从完整快照先按已知 CPU 降序、未知 CPU 排后按内存降序，再取前列；全部 CPU 未知时按内存排序。指定最低 CPU 的过滤不把未知值当成零。当前平台进程与端口采样不提供工作目录，`cwd` 明确为 `null`。
