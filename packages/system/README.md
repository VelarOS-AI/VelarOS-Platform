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
