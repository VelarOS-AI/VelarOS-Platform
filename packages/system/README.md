# @velaros-ai/system

> 七个工具都在 [src/impl/SystemTools.ts](./src/impl/SystemTools.ts)；模块卡片见 [MODULE.md](./MODULE.md)。本文是操作手册。

System 是 `@velaros-ai` 品牌下的系统空间包。对外只有两个入口，里面只有接口标注过的整件能力、宿主要注入的接口和数据，
零件不出包（详见 [MODULE.md](./MODULE.md) 的「提供什么」）；跨平台兼容层与共享资源目录在 `@velaros-ai/platform`：

- `@velaros-ai/system`：Node 宿主用的全部公开面，包括七个工具、内置 mod、内核模块、本地内核、命令策略。
- `@velaros-ai/system/contracts`：可移植数据，浏览器也能用。

模型工具使用 canonical `namespace:tool` 协议：

```text
system:read
system:view
system:edit
system:run
system:refresh-environment
system:list-tasks
system:sandbox
```

复杂迁移、批量改写、删目录的脚本先走演练沙箱：`system:sandbox create` 把目录镜像到临时区，脚本用 `system:edit` 写进镜像、用 `system:run` 传 `cwd=镜像根` 跑——镜像里的命令被进程约束钉在镜像内，写到源目录会直接失败；`diff` 看变了什么，`apply` 经用户确认后落回源目录（源文件变过整批不落），`discard` 丢弃。见 ADR 0006。

只留 `system:run` 替代不了的：读和写把文件内容和精确匹配绕开 shell 引号，并过敏感路径审批（整个文件的重写并在 `system:edit` 里）；看图片要把内容当图交给模型（PDF 与其他文档归别的 mod）；
后台任务表只在本包；刷新环境要把 Windows 上重读到的环境变量写回宿主进程，子进程做不到。能由普通命令稳定完成的操作直接用 `system:run`：
列目录、搜文本、看进程和端口、终止进程、打开文件和应用。原来的 `system:list`、`system:search`、`system:processes`、
`system:terminate-task`、`system:open`，以及更早的项目发现、开发环境摘要、诊断快捷工具，都已从模型面删除。

## Windows 命令运行环境

Windows 按 **Git Bash → PowerShell 7 → Windows PowerShell → CMD** 的顺序选择可用环境。
推荐安装 [Git for Windows](https://git-scm.com/download/win)，以获得 Bash 和 Unix 命令工具。
Git 发现覆盖系统安装、当前用户安装及 PATH；`VELAROS_GIT_BASH` 可以指定自定义 Git 安装的
`bin\bash.exe` 或 `usr\bin\bash.exe`。全部候选不可用时返回 `SYSTEM_SHELL_UNAVAILABLE`。

本地内核（`createLocalSystemKernel`）执行每条命令前都做一次 shell 自检：带短超时，验证启动、版本和 UTF-8；
只有自检阶段可以尝试下一候选。`inspectEnvironment()` 与命令结果里的 `shell` 报告实际选中的
`kind/name/shellPath/args`、`readiness/version/recommendation`，可以给界面和模型看。
用户命令只执行一次，失败后按原始退出码和输出诊断。

Git Bash 使用 `--noprofile --norc -c`，PATH 优先使用 Git 工具；PowerShell 使用无 profile 的
非交互会话，显式设置 UTF-8 并传回原生命令退出码；CMD 会初始化 UTF-8 代码页。
Windows 子进程同时设置 Python UTF-8。第三方程序仍需遵循自身的输出编码配置。

`inspectEnvironment(commands)` 按实际 shell 的查找规则报告每个命令是 native、script、batch 还是 builtin。
宿主已知的工具调用通过 `nativeCommand: { file, args, env? }` 传递，授权与日志展示由该结构生成。
原生 argv 直接传给进程，避免 MSYS 把路径形状的普通参数转换；批处理入口使用明确的 CMD 适配，
包括 npm `.cmd` shim 的双层转义。该字段只供宿主组合能力使用，不出现在模型工具 schema 中。

Windows 上刷新环境时，本包异步重读用户与系统环境变量，保留启动器额外 PATH 和应用覆盖项，并给出新的 revision。
跨平台兼容层（`@velaros-ai/platform` 的 `currentPlatform`）与描述符类型可以在浏览器里用；文件发现和自检只在 Node 里做。
本包读写的环境变量全部登记在 `SystemEnvironmentVariables`。

## 进程约束契约

本地内核按 `LocalSystemKernelOptions.processConfinement` 执行统一的 `read-only`、`workspace-write` 与
`danger-full-access` 进程约束。macOS 使用 Seatbelt，Linux 使用 bubblewrap；宿主也可以通过注入面的
`SystemProcessConfinementProvider` 注入 Windows restricted-token、容器或更强的实现。受约束模式没有可用后端时以
`SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE` 拒绝执行，不会静默退回裸进程。

新执行器应在 `SystemCommandResult.confinement` 报告真实的
`SystemProcessConfinementEvidence`：请求模式、实际后端、约束强度、原因与生效写根。
审批与约束是两件事：宿主仍拥有执行授权和额外写根，已审批命令也不能仅凭审批记录宣称被隔离。

本地内核为兼容既有宿主，缺省使用显式 `danger-full-access`，并报告
`enforcement: "none"`。Windows 目前没有包内置后端；需要受约束执行的 Windows 宿主必须注入
provider，否则会明确失败。
