# @velaros-ai/project

Project 是 `@velaros-ai` 的项目空间聚合包，统一项目根内的读取、编辑、事务、代码查询与命令执行：

- `@velaros-ai/project/files`：有界读取、列举、正文搜索与路径约束。
- `@velaros-ai/project/changes`：多文件事务、修订防护、预览、回滚与审计钩子。
- `@velaros-ai/project/execution`：项目边界内的可取消、可审计命令执行策略。
- `project:code`：符号、引用候选、依赖、关系、影响与诊断；宿主提供语言服务和可选 CodeGraph 后端。
- `@velaros-ai/project/transaction-controller`：给 Desktop/Editor 的有限事务面；只有
  `list/get/subscribe/apply/rollback`，不暴露项目根、状态路径、provider 或 prepare 能力。

宿主通过 `@velaros-ai/project/composition` 创建能力实例，通过
`@velaros-ai/project/agent` 注入模型工具。默认提供六个工具，另外两个按任务通过能力目录加载：

```text
project:read
project:list
project:search
project:file
project:edit
project:run

# 按需加载
project:code
project:change
```

Provider 不支持冒号时，由 Agent Runtime 在请求编译阶段映射成诸如
`project__read` 的传输名；权限、历史和工具结果始终保存 canonical id。

普通命令使用 `project:run`；代码查询使用 `project:code` 的六类 action：
`symbols/references/dependencies/relations/impact/diagnostics`。结果携带来源、覆盖与降级信息。
高级 `trace/cycles/deadcode/routing` 由宿主按实际能力提供 `project:code-analysis`，索引生命周期由宿主管理。

文件创建、整文件覆盖、移动和删除使用 `project:file`。局部修改使用 `project:edit` 的
`replace/insert`。混合文件动作和编辑的事务计划使用 `project:change.apply`；回执通过
`change.inspect` 检查、`change.undo` 撤销，共用 Kernel 授权、校验和事务边界。

批量统一磁盘编码使用 `project:file` 的 `recode` 动作：传 `paths` 与可选 `encoding`
（utf-8/utf-16le/utf-16be/gb18030，默认 utf-8）、`bom`、`newline`（lf/crlf）。框架探测每个文件
的原编码并按目标格式重写字节，Unicode 正文不变；已是目标格式的文件跳过。转换是普通事务，回执带
`recode.converted/unchanged`，可用 `change.undo` 或回滚恢复原字节。这是统一项目编码的备用入口：
读取、搜索、编辑永远只处理文本，不提供也不接受编码参数。

`project:read.maxChars` 是一次调用中所有文件共享的总预算。能够保存完整源引用时，被截断的文件
返回可原样传给 `project:read` 的 `continuation`；其中保存续读行列坐标，模型无需补列号。

读取结果的 `lines` 每项为 `[行号, 原始行文本]`，数字是定位元数据；`fragments` 包含明确的部分行。
`match/text` 只填写源码。`fileRef` 绑定路径、版本、会话与最终模型请求实际可见的源码范围。
正文按一次 JSON 解码后的 Unicode 字面源码表达，跨行使用 LF，反斜杠不再次解码。
新建文本文件统一使用 UTF-8、无 BOM、LF；现有文件的磁盘编码、BOM 和换行格式由底层维护。
无 BOM 的 UTF-16 编辑后若无法可靠识别，底层自动补同字节序 BOM；撤销恢复原始字节。
差异计算使用有界预算，无法定位的内部片段可能采用等价字节编码；Unicode 正文保持一致，撤销独立使用完整原字节。
编辑中的 `range` 接受单行 `51`、`[51]`，或闭区间 `[42,45]`。
下面是参数模板：`<fileRef>` 必须替换为真实读取回执中的引用，范围与正文按当前源码填写：

```json
{
  "files": [{
    "fileRef": "<fileRef>",
    "edits": [
      { "op": "replace", "range": [12,14], "text": "const ready = true\nrun(ready)" },
      { "op": "replace", "range": 20, "match": "oldCall()", "text": "newCall()" }
    ]
  }]
}
```

只有 range 时选择完整行；加 match 后在区域内选择唯一原文片段；只有 match 时搜索引用的实际可见范围。
`replace` 的 `text:""` 删除目标。`insert` 使用 `side:before|after` 在目标边界插入；
文件头尾使用互斥的 `at:start|end` 形式。同文件批量修改保持输入版本的固定坐标，重叠冲突明确拒绝。
行编辑维护换行边界，字符编辑保留字面内容。范围越界、引用过期或歧义都不会静默扩大修改。

已保存且确认未落盘的失败保留原参数引用，模型用 `reuse + changes` 可仅修正定位字段。
可验证且预算内的定位问题返回版本绑定的候选，确认后才可继续；过期目标不能安全定位时要求重读。
完整候选仅用于下一次模型决策，之后投影为短归档回执；
原始结果可主动召回。成功后当前源码视图升级，历史版本保留明确的历史语义。
历史文件召回也向模型提供 Unicode/LF 正文，原始档案保持完整；续读必须原样使用返回的
`nextOffset`，它采用归档原文坐标，不能按显示正文长度推算。

SDK `prepareEdit` 保持 `operations: [{ operation }]`，用于插件意图、约束和审计。
旧模型合同由 `legacyProjectTools` 显式提供；历史输入迁移要求可信作用域及未落盘证明。

默认事务预算为 100 个文件、每文件净变更 20,000 行、每事务净变更 50,000 行；宿主可通过
`corePolicy` 收紧或扩大。准备失败返回操作序号、阶段和读取恢复参数，任何准备失败都不写盘。
revision 默认使用内容指纹，能够检测同大小、保留 mtime 的外部修改。
文本写入通过同目录临时文件、同步与原子替换提交，保留文件 mode 和文本编码。
不完整 Unicode 会在准备阶段拒绝，文本里的字面反斜杠保持原义。
SDK 读取的 `maxBytes` 按逻辑 UTF-8 字节计费，CRLF 计一个换行；模型沿用返回的续读引用即可。

工具示例、schema 描述与实际提示词组装由[模型指导同步检查](../../docs/engineering/project-model-guidance-audit.md)约束，协议变更需要同步审核并通过测试。

## 内部职责

| 目录 | 职责 |
| --- | --- |
| `types` | 公共领域类型与文件访问端口 |
| `runtime` | Kernel 组装、策略、生命周期与事务提交协调 |
| `files` | 有界读取、发现、搜索、Git 索引及原子文件 IO |
| `editing` | 可见范围选择、固定坐标编译、定位恢复 |
| `file-operations` | 文件动作计划 |
| `context` | 版本与可见范围绑定的引用 |
| `compatibility` | 旧合同与历史参数迁移 |
| `edits` | SDK 编辑合同与纯补丁策略 |
| `transactions` | 规划、暂存视图、验证、状态机、锁与恢复 |
| `persistence` | 事务日志、change feed 与审计存储 |
| `execution` | 命令行为策略 |
| `agent/contracts`、`agent/tools` | 模型协议、工具编排与宿主端口适配 |

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
