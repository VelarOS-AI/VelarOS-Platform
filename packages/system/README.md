# @velaros-ai/system

System 是 `@velaros-ai` 品牌下的系统空间聚合包，由四个单一职责子路径组成：

- `@velaros-ai/system/files`
- `@velaros-ai/system/execution`
- `@velaros-ai/system/processes`
- `@velaros-ai/system/desktop`

模型工具使用 canonical `namespace:tool` 协议：

```text
system:read
system:write
system:edit
system:list
system:search
system:run
system:processes
system:open
system:refresh-environment
system:list-tasks
system:terminate-task
```

这些工具保留的理由是跨平台文件约束、敏感路径审批、可取消执行、后台任务生命周期、
结构化进程/端口信息或桌面打开语义。项目发现、开发环境摘要和诊断快捷工具已经从模型面删除；
能由普通命令稳定完成的操作直接使用 `system:run`。

`system:processes.filter` 会对进程、端口与后台任务的完整命令行做不区分大小写的匹配，
再分别应用 `limit`；命令特征不会因先截断任务列表而被漏掉。

## Windows 命令运行环境

Windows 按 **Git Bash → PowerShell 7 → Windows PowerShell → CMD** 的顺序选择可用环境。
推荐安装 [Git for Windows](https://git-scm.com/download/win)，以获得 Bash 和 Unix 命令工具。
Git 发现覆盖系统安装、当前用户安装及 PATH；`VELAROS_GIT_BASH` 可以指定自定义 Git 安装的
`bin\bash.exe` 或 `usr\bin\bash.exe`。全部候选不可用时返回 `SYSTEM_SHELL_UNAVAILABLE`。

Node 宿主从 `@velaros-ai/system/execution` 调用异步 `resolveSystemShellReady()`。自检带短超时，
验证启动、版本和 UTF-8；只有自检阶段可以尝试下一候选。返回的 `kind/name/shellPath/args`、
`readiness/version/recommendation` 可以向界面和模型报告，`env` 仅用于宿主进程执行。
在生成命令前报告实际 shell，使用该描述符调用 `getShellCommandSpec(command, shell)` 并将
`shell.env` 传给子进程。用户命令执行一次，失败后按原始退出码和输出诊断。

Git Bash 使用 `--noprofile --norc -c`，PATH 优先使用 Git 工具；PowerShell 使用无 profile 的
非交互会话，显式设置 UTF-8 并传回原生命令退出码；CMD 会初始化 UTF-8 代码页。
Windows 子进程同时设置 Python UTF-8。第三方程序仍需遵循自身的输出编码配置。

`resolveSystemCommand(name, shell)` 使用实际 shell 的查找规则并报告 native/script/batch/builtin。
宿主已知的工具调用通过 `nativeCommand: { file, args, env? }` 传递，授权与日志展示由该结构生成。
原生 argv 直接传给进程，避免 MSYS 把路径形状的普通参数转换；批处理入口使用明确的 CMD 适配，
包括 npm `.cmd` shim 的双层转义。该字段只供宿主组合能力使用，不出现在模型工具 schema 中。

`refreshWindowsEnvironment()` 异步重读用户/系统环境，保留启动器额外 PATH 和应用覆盖项，返回
revision 并清空此前 Shell 选择。宿主重新自检后向已打开的工作区发布新的运行环境描述符。
`SystemPlatformCompatibility` 与描述符类型保持可用于浏览器，文件发现和自检属于 Node 执行层。

## 进程约束契约

`@velaros-ai/system/execution` 提供统一的 `read-only`、`workspace-write` 与
`danger-full-access` 进程约束。macOS 使用 Seatbelt，Linux 使用 bubblewrap；宿主也可以注入
Windows restricted-token、容器或更强的实现。受约束模式没有可用后端时以
`SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE` 拒绝执行，不会静默退回裸进程。

新执行器应在 `SystemCommandResult.confinement` 报告真实的
`SystemProcessConfinementEvidence`：请求模式、实际后端、约束强度、原因与生效写根。
审批与约束是两件事：宿主仍拥有执行授权和额外写根，已审批命令也不能仅凭审批记录宣称被隔离。

`LocalSystemKernel` 为兼容既有宿主，缺省使用显式 `danger-full-access`，并报告
`enforcement: "none"`。Windows 目前没有包内置后端；需要受约束执行的 Windows 宿主必须注入
provider，否则会明确失败。
