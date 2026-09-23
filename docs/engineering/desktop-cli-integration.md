# Desktop CLI 宿主接入差量

日期：2026-09-23。

Desktop 的短命令使用 `@velaros-ai/velaros/shell/local` 的本机宿主执行。Platform 持有参数传递、标准输入、输出解码、超时与进程回收；Desktop 持有命令目标、应用生命周期、安装与鉴权策略。

## 公共合同

| 变更 | 理由与影响 |
| --- | --- |
| `ShellRunCommandOptions.stdin?: string` | CLI 需要一次性输入与 EOF。仅供宿主调用，UTF-8 写入后关闭输入；空串也发送 EOF。与 background 同传时在启动前返回 VALIDATION。 |
| `ShellRunCommandOptions.nativeCommand.env?: Record<string, string \| undefined>` | 宿主需要逐次覆盖和删除继承的环境键。undefined 删除本次进程的键，Windows 沿用不区分大小写的匹配；共享环境快照保持不变。 |
| INV-18 | 新增前台输入、EOF、输入端提前关闭、超时收尾、后台参数拒绝及环境快照隔离承诺。以真实子进程验收。 |

模型使用的 `ShellRunInput` 与 ScriptAct 操作沿用现有声明；上述字段只位于宿主端口。已有取消、进程树所有权和输出捕获链负责收尾，标准输入端提前关闭只记录调试信息，由命令终态表达执行结果。

## Desktop 装配

`CliService` 管理在途命令、账号退出中断和应用终止回执。`bootstrap/cli.ts` 创建本机宿主，借用应用登录环境，直接传递 argv、stdin、环境覆盖和超时；执行完成后释放本次宿主。引擎的版本、鉴权和安装引导由 EngineDriver 持有。

## 验证

Shell 验收及实现回归：95 通过，6 项 Windows 原生环境测试在 macOS 跳过。模块归属、Script 声明及 Act 目录检查通过。Desktop 类型、应用回归、产物和启动结果记录在 Desktop 的 `docs/architecture/main-cleanup.md`。
