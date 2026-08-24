# @velaros-ai/project

Project 是 `@velaros-ai` 品牌下的项目空间聚合包。它负责锚定项目根之后的四类能力：

- `@velaros-ai/project/files`：有界读取、列举、正文搜索与路径约束。
- `@velaros-ai/project/changes`：多文件原子事务、修订防护、预览、回滚与审计钩子。
- `@velaros-ai/project/execution`：项目边界内的可取消、可审计命令执行策略。
- `project:query-code`：内置语言服务驱动的代码理解；CodeGraph 安装后覆盖同一工具的图谱 action。
- `@velaros-ai/project/transaction-controller`：给 Desktop/Editor 的有限事务面；只有
  `list/get/subscribe/apply/rollback`，不暴露项目根、状态路径、provider 或 prepare 能力。

宿主通过 `@velaros-ai/project/composition` 创建能力实例，通过
`@velaros-ai/project/agent` 注入模型工具。公共模型协议只有：

```text
project:read
project:list
project:search
project:query-code
project:write
project:edit
project:rollback
project:run
```

Provider 不支持冒号时，由 Agent Runtime 在请求编译阶段映射成诸如
`project__read` 的传输名；权限、历史和工具结果始终保存 canonical id。

Git、项目信息、验证计划和批处理不属于 Project 模型工具。普通命令能够稳定完成的事情直接
使用 `project:run`；符号、引用、诊断和结构化代码关系统一使用 `project:query-code`。
CodeGraph 是可选增强资源，不拥有第二个工具身份，也不会决定基础工具是否可见。

完整单文件内容使用浅层 `project:write`；精确文本、符号、导入、JSON 与多操作原子事务
使用 `project:edit`。两者共享同一套 Project Kernel 授权、事务和回滚边界。

## 可恢复事务与 Desktop 边界

需要跨进程重启继续 apply/rollback 的宿主，应把状态和 ChangeFeed 放在宿主私有目录，
并把有限 controller 交给 UI transport；路径只在 host 侧出现：

```ts
import { FileProjectChangeFeed } from '@velaros-ai/project/changes'
import { createProjectKernel } from '@velaros-ai/project/runtime'
import { createProjectTransactionController } from '@velaros-ai/project/transaction-controller'

const changeFeed = new FileProjectChangeFeed({ path: hostOwnedChangeFeedPath })
const project = await createProjectKernel({
  root: authorizedProjectRoot,
  changeFeed,
  transactionStatePath: hostOwnedTransactionStatePath,
})

const transactions = createProjectTransactionController(project)
```

`transactionStatePath` 启用写前恢复计划：apply/rollback 在第一处项目文件写入前先提交计划，
成功后再原子提交终态。重启发现中断操作时，只会还原“原状态”或能证明属于该事务的内容；
遇到无法归属的外部编辑会以 `TRANSACTION_RECOVERY_CONFLICT` 拒绝覆盖并保留现场。
ChangeFeed 是可重建的审计投影，不能领先或否定事务主状态。
