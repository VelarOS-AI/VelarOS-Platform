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
