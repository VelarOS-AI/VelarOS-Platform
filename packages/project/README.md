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

`project:read.maxChars` 是一次调用中所有文件共享的总预算；每个被截断的文件都返回可再次
传给 `project:read` 的 `continuation`。续读落在超长行中时使用 1-based UTF-16
`startColumn`，不会跳过该行剩余内容。

文本编辑中的 `expectedMatches` 只断言文件内的匹配总数。多处匹配时用 1-based
`occurrence` 选择一处，或传 `replaceAll: true` 明确修改全部。JSON Patch 的 `add` 与
`replace` 必须携带 JSON `value`；路径按 JSON Pointer 解析，且不会自动创建缺失的父节点。

已读取明确行号时，可用 `replace_lines` 避免复述旧源码及其反斜杠：

```json
{
  "edits": [{
    "type": "replace_lines",
    "path": "src/index.ts",
    "baseRevision": "从 project:read 的 snapshot.revision 原样复制",
    "startLine": 12,
    "endLine": 14,
    "newLines": ["const ready = true", "run(ready)"]
  }]
}
```

模型入口使用扁平 `edits` 数组；SDK `prepareEdit` 保持 `operations: [{ operation }]`，
用于插件意图、约束和审计。一次模型调用可包含 1–1000 个操作。
模型用 `replace_text` 的空 `newText` 删除片段；SDK 继续兼容 `delete_text`。
单文件追加/前置使用 `project:write`，多文件原子追加/前置仍可在 `edits` 中组合。
范围从 1 开始且包含两端，每项是一行（保留缩进，不含 CR/LF），空数组删除所选行。
工具沿用目标区域换行符和末尾换行状态；范围越界或 revision 过期会拒绝。
同文件连续的 `replace_lines` 使用同一读取版本的原始行号，工具按原快照解析不重叠范围并一次拼接
结果，不要求模型手算前序操作引起的位移。随后仍可接文本、符号操作及其他文件编辑。

默认事务预算为 100 个文件、每文件净变更 20,000 行、每事务净变更 50,000 行；宿主可通过
`corePolicy` 收紧或扩大。准备失败返回操作序号、阶段和读取恢复参数，任何准备失败都不写盘。
revision 默认使用内容指纹，能够检测同大小、保留 mtime 的外部修改。
文本写入通过同目录临时文件、同步与原子替换提交，保留文件 mode 和文本编码。
不完整 Unicode 会在准备阶段拒绝，文本里的字面反斜杠保持原义。

## 内部职责

| 目录 | 职责 |
| --- | --- |
| `types` | 公共领域类型与文件访问端口 |
| `runtime` | Kernel 组装、策略、生命周期与事务提交协调 |
| `files` | 有界读取、发现、搜索、Git 索引及原子文件 IO |
| `edits` | 模型 schema、定位反馈、纯补丁策略 |
| `transactions` | 规划、暂存视图、验证、状态机、锁与恢复 |
| `persistence` | 事务日志、change feed 与审计存储 |
| `execution` | 命令行为策略 |
| `agent` | 模型协议与宿主端口适配 |

公共导出路径保持稳定。架构门禁禁止文件、编辑、事务服务反向依赖 Kernel 组装和 Agent。

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
