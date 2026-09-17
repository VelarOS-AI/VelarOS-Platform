# @velaros-ai/system

> 模块卡片见 [MODULE.md](./MODULE.md)。本文是操作手册。

系统空间：本机能力的实现（本地内核），加上把三件跨空间能力配上系统空间端口的那张装配表。
能力本身各在各的包里，模型在程序里这样用它们：

```js
import { edit, read, view } from 'velar:files'       // @velaros-ai/files
import { listTasks, run } from 'velar:shell'         // @velaros-ai/shell-command
import { apply, create, diff } from 'velar:sandbox'  // @velaros-ai/rehearsal-sandbox
```

系统空间的端口决定这三件能力在这台机器上怎么落地：路径可以是本机任意位置，`~` 展开到家目录、相对路径相对内核的工作目录；
凭证文件与系统敏感路径先问用户；写是逐个原子替换；命令在本机任意目录跑；沙箱能镜像任意目录，镜像里的命令被进程约束钉在镜像内。

```ts
import { createLocalSystemKernel, createSystemSpace } from '@velaros-ai/system'
import { createCapabilityPort } from '@velaros-ai/code-surface'

const kernel = createLocalSystemKernel({ cwd: homeDirectory })
const space = createSystemSpace({
  host: kernel,
  // 每次调用都会被叫一次：审批通道、取消信号、会话是这一次调用的
  resolveCall: (signal) => ({ abortSignal: signal ?? new AbortController().signal, approval, sessionId }),
})
const capabilities = createCapabilityPort(space.operations)
```

对外两个入口：`@velaros-ai/system`（Node 宿主用的全部公开面）与 `@velaros-ai/system/contracts`（可移植数据，浏览器也能用）。
跨平台兼容层与共享资源目录在 `@velaros-ai/platform`。

## Windows 命令运行环境

Windows 按 **Git Bash → PowerShell 7 → Windows PowerShell → CMD** 的顺序选择可用环境。
推荐安装 [Git for Windows](https://git-scm.com/download/win)，以获得 Bash 和 Unix 命令工具。
Git 发现覆盖系统安装、当前用户安装及 PATH；`VELAROS_GIT_BASH` 可以指定自定义 Git 安装的
`bin\bash.exe` 或 `usr\bin\bash.exe`。全部候选不可用时返回 `SYSTEM_SHELL_UNAVAILABLE`。

本地内核执行每条命令前都做一次 shell 自检：带短超时，验证启动、版本和 UTF-8；
只有自检阶段可以尝试下一候选。`inspectEnvironment()` 与命令回执里的 `shell` 报告实际选中的
`kind/name/shellPath/args`、`readiness/version/recommendation`，可以给界面和模型看。
用户命令只执行一次，失败后按原始退出码和输出诊断。

Git Bash 使用 `--noprofile --norc -c`，PATH 优先使用 Git 工具；PowerShell 使用无 profile 的
非交互会话，显式设置 UTF-8 并传回原生命令退出码；CMD 会初始化 UTF-8 代码页。
Windows 子进程同时设置 Python UTF-8。第三方程序仍需遵循自身的输出编码配置。

`inspectEnvironment(commands)` 按实际 shell 的查找规则报告每个命令是 native、script、batch 还是 builtin。
宿主已知的工具调用通过 `nativeCommand: { file, args, env? }` 传递，授权与日志展示由该结构生成。
原生 argv 直接传给进程，避免 MSYS 把路径形状的普通参数转换；批处理入口使用明确的 CMD 适配，
包括 npm `.cmd` shim 的双层转义。该字段只供宿主组合能力使用，不进模型面。

Windows 上刷新环境时，本包异步重读用户与系统环境变量，保留启动器额外 PATH 和应用覆盖项，并给出新的 revision。
本包读写的环境变量全部登记在 `SystemEnvironmentVariables`。

## 进程约束契约

本地内核按 `LocalSystemKernelOptions.processConfinement` 执行统一的 `read-only`、`workspace-write` 与
`danger-full-access` 进程约束。macOS 使用 Seatbelt，Linux 使用 bubblewrap；宿主也可以通过注入面的
`SystemProcessConfinementProvider` 注入 Windows restricted-token、容器或更强的实现。受约束模式没有可用后端时以
`SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE` 拒绝执行，不会静默退回裸进程。

命令回执的 `confinement` 报告真实的约束证据：请求模式、实际后端、约束强度、原因与生效写根。
审批与约束是两件事：宿主仍拥有执行授权和额外写根，已审批命令也不能仅凭审批记录宣称被隔离。

本地内核为兼容既有宿主，缺省使用显式 `danger-full-access`，并报告 `enforcement: "none"`。
Windows 目前没有包内置后端；需要受约束执行的 Windows 宿主必须注入 provider，否则会明确失败。
