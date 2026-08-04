# @velaros-ai/project

Project 是 `@velaros-ai` 品牌下的项目空间聚合包。它只负责锚定项目根之后的三类能力：

- `@velaros-ai/project/files`：有界读取、列举、正文搜索与路径约束。
- `@velaros-ai/project/changes`：多文件原子事务、修订防护、预览、回滚与审计钩子。
- `@velaros-ai/project/execution`：项目边界内的可取消、可审计命令执行策略。

宿主通过 `@velaros-ai/project/composition` 创建能力实例，通过
`@velaros-ai/project/agent` 注入模型工具。公共模型协议只有：

```text
project:read
project:list
project:search
project:write
project:edit
project:rollback
project:run
```

Provider 不支持冒号时，由 Agent Runtime 在请求编译阶段映射成诸如
`project__read` 的传输名；权限、历史和工具结果始终保存 canonical id。

Git、项目信息、验证计划、批处理和语言导航快捷操作不属于 Project 模型工具。
普通命令能够稳定完成的事情直接使用 `project:run`；结构化代码关系查询由
Development 能力提供。

完整单文件内容使用浅层 `project:write`；精确文本、符号、导入、JSON 与多操作原子事务
使用 `project:edit`。两者共享同一套 Project Kernel 授权、事务和回滚边界。
