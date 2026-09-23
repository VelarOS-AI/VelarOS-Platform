# @velaros-ai/velaros/shell

替 agent 跑 shell 命令：代码面 `velaros:shell` 的 `run`、`listTasks`、`stop`、`refreshEnvironment`，危险命令先经审批端口问用户。系统空间和项目空间挂同一份实现，差别全在空间端口；真正起进程的本机宿主、给演练沙箱用的受约束执行器在 `./local`。

## 用法

```ts
import { createShellCapabilityModule } from '@velaros-ai/velaros'
import type { ApprovalPort } from '@velaros-ai/kernel'
import { shellOperations, type ShellOperationContext, type ShellSpacePort } from '@velaros-ai/velaros/shell'
import { createLocalShellHost, createShellEnvironment } from '@velaros-ai/velaros/shell/local'

// 危险命令经它问用户；无人值守的宿主给默认拒绝的端口
declare const approval: ApprovalPort

// 应用持有一份登录环境，本机宿主借用它；相对路径相对 cwd，~ 展开到家目录
const environment = createShellEnvironment()
const host = createLocalShellHost({ cwd: process.cwd(), environment })

// 空间端口 = 本机宿主的执行那几件 + 这个空间自己的作用域与确认口径
const shell: ShellSpacePort = {
  resolveCwd: async (cwd) => host.resolvePath(cwd),
  commandPolicy: (cwd) => ({ scopeLabel: cwd ?? '系统运行环境', riskScope: 'system-command:dangerous' }),
  runCommand: (command, options, allowDangerous, signal) => host.runCommand(command, options, allowDangerous, signal),
  // 观察模式的执行口：本机宿主给的是只读、断网的受约束执行
  runObservationCommand: host.runObservationCommand?.bind(host),
  listBackgroundTasks: (options) => host.listBackgroundTasks(options),
  refreshShellEnvironment: () => host.refreshShellEnvironment(),
  terminateBackgroundTask: (request) => host.terminateBackgroundTask(request),
}

// 宿主自己调用：命令自己失败不抛错，看 success
const context: ShellOperationContext = { abortSignal: new AbortController().signal, shell, approval, sessionId: 'session-1' }
const result = await shellOperations.run({ command: 'git status --short' }, context)
if (!result.success) console.warn(result.exitCode, result.stderr)

// 挂成模型程序里可以 import 的 velaros:shell
export const shellModule = createShellCapabilityModule({ instanceId: 'system-shell', shell, approval })

// 应用退出时：宿主停掉自己起的后台进程，登录环境由持有它的应用关
export async function shutdown() {
  await host.dispose()
  await environment.dispose()
}
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros/shell` | 任何进程 | `shellOperations`、命令判定 `shellCommandPolicy`、危险命令的审批请求 `shellCommandApproval`、空间端口与调用上下文、本机实现的接口与配置（只有类型） |
| `@velaros-ai/velaros/shell/contracts` | 任何进程 | 上限 `ShellLimits`、shell 种类 `ShellCommandKinds`、错误码 `ShellErrorCodes`、环境变量表、可移植数据、模型面 `VelarShellModule` |
| `@velaros-ai/velaros/shell/local` | Node | 本机宿主 `createLocalShellHost`、受约束执行器 `createConfinedShellRunner`、登录环境 `createShellEnvironment` |

## 约定

- 作用域在空间端口：`resolveCwd` 要对越界的目录抛 `PERMISSION`，它排在确认与执行之前；`commandPolicy` 给确认文案里「在哪儿执行」和风险分类，宿主靠 `:dangerous` 后缀认出硬门。
- 只有危险命令（递归删除、丢未提交改动的 git、提权这类）经 `approval` 问，每次都问、不可记忆；被拒时一个进程都不起，拒绝原样抛出。别的命令直接跑，长驻命令自动转后台。
- 命令自己失败（非零退出、超时、取消）不抛错，看回执的 `success`；超时钳到 `ShellLimits.timeoutMs`，输出不折叠，超过 `ShellLimits.outputChars` 只留末尾并标 `truncated`。
- 观察模式只跑前台、不危险的命令（否则抛 `OBSERVATION_EFFECT_DENIED`），只走端口的 `runObservationCommand`，端口没给就抛 `OBSERVATION_SHELL_UNAVAILABLE`，不退回普通执行。
- 挑了本机没有的 `shell` 在起进程之前抛 `VALIDATION`，不换默认 shell 照跑；一个能用的 shell 都找不到抛 `SHELL_UNAVAILABLE`。
- 后台任务按 `sessionId` 登记和核对归属，不给就不隔离；任务表在本机宿主的内存里，`dispose()` 停掉它起的、还在跑的后台进程。
- 本机宿主缺省不约束进程，回执如实报 `enforcement: none`；要约束却没有后端（macOS 没有 sandbox-exec、Linux 没装 bubblewrap、Windows 没注入 `confinementProvider`）时抛 `SHELL_CONFINEMENT_UNAVAILABLE`，不退回裸进程；macOS 的约束报 `partial`。
- 不给 `environment` 时命令用当前进程的环境；`createShellEnvironment()` 读登录 shell 的环境并按代次缓存，谁创建谁 `dispose()`，本机宿主只借用。
- Windows 上子进程随父进程一起退出靠原生进程宿主 `velaros-process-host.exe`，按 `VELAROS_PROCESS_HOST`、应用资源目录的 `windows-execution/`、包里的 `shell/native/win32-<架构>/` 依次找（在 Windows 上用 `shell/native/build.mjs` 构建）；都找不到时退回按进程树清理。
