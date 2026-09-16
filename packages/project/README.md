# @velaros-ai/project

Project 是 `@velaros-ai` 的项目空间包，统一项目根内的读取、编辑、事务、代码查询与命令执行。只有两个入口：

- `@velaros-ai/project`：给 Node 宿主。产品面（七个模型工具、内置 mod 定义、内核模块、领域内核
  `createProjectKernel`、有限事务面、落盘变更记录、审批桥、文件上下文登记）、注入面（宿主端口、provider、插件扩展点）
  以及它们用到的数据类型。
- `@velaros-ai/project/contracts`：可移植数据，浏览器和渲染进程也能用。常量表（工具与 mod 身份、各工具上限、宿主代码查询的
  语言服务动作）和经过宿主端口流动的数据类型。

宿主用 `createProjectBundledModDefinition` 挂载项目空间（或者自己 `createProjectKernel` 配上 `projectTools`），工具上下文里注入 `ProjectToolApi`。
默认提供五个工具，另外两个按任务通过能力目录加载：

```text
project:read
project:list
project:search
project:edit
project:run

# 按需加载
project:code
project:sandbox
```

Provider 不支持冒号时，由 Agent Runtime 在请求编译阶段映射成诸如
`project__read` 的传输名；权限、历史和工具结果始终保存 canonical id。

复杂迁移、批量改写、删目录的脚本先走演练沙箱 `project:sandbox`：`create` 把项目镜像到临时区，`run` 在镜像里跑命令（进程约束钉在镜像内，写到项目会直接失败），`diff` 看变了什么，`apply` 经用户确认后落回项目（项目文件变过整批不落），`discard` 丢弃；宿主没接沙箱端口时这个工具不出现。见 ADR 0006。

普通命令使用 `project:run`；代码查询使用 `project:code` 的六类 action：
`symbols/references/dependencies/relations/impact/diagnostics`。结果携带来源、覆盖与降级信息。
高级 `trace/cycles/deadcode/routing` 由宿主按实际能力提供 `project:code-analysis`；代码索引的建与查是宿主自己的事，本包不发这类查询。

改文件只有 `project:edit` 一个入口，用 `action` 分辨做什么：`apply` 提交一次改动，`inspect` 查看，`undo` 撤销。
`apply` 的 `steps` 一步一个目标，按动作分辨（`create/overwrite/move/delete/recode/edit`）：新建、整文件覆盖、移动、
删除、转磁盘编码各是一个文件动作，`edit` 步是一个文件加它的几处 `replace/insert`。一次 apply 就是一次事务——
全成或全不成、一次确认、一个撤销句柄；回执凭 `changeRef` 用 `inspect` 检查、`undo` 撤销，共用 Kernel 授权、校验和事务边界。

批量统一磁盘编码使用 `recode` 步骤：传 `paths` 与可选 `encoding`
（utf-8/utf-16le/utf-16be/gb18030，默认 utf-8）、`bom`、`newline`（lf/crlf）。框架探测每个文件
的原编码并按目标格式重写字节，Unicode 正文不变；已是目标格式的文件跳过。转换是普通事务，回执带
`recode.converted/unchanged`，可用 `undo` 或回滚恢复原字节。这是统一项目编码的备用入口：
读取、搜索、编辑永远只处理文本，不提供也不接受编码参数。

`project:read` 的入参只有 `files`（每项一个文件，可带 `range`）与 `continuation` 两种，读一个文件就是只有一项的
`files`——和 `system:read` 同一种形状。`maxChars` 是一次调用中所有文件共享的总预算（缺省 24000）：预算没取完时只给完整的行，
某一行本身比预算还长才从行中间截。能够保存完整源引用时，被截断的文件返回可原样传给 `project:read` 的 `continuation`；
其中保存续读行列坐标，模型无需补列号。

读取结果的 `lines` 每项为 `[行号, 原始行文本]`，数字是定位元数据；`fragments` 包含明确的部分行。
`match/text` 只填写源码。`fileRef` 绑定路径、版本、会话与最终模型请求实际可见的源码范围。
正文按一次 JSON 解码后的 Unicode 字面源码表达，跨行使用 LF，反斜杠不再次解码。
`overwrite` 要求 `fileRef` 覆盖整个文件，`move`、`delete` 只核对版本。
新建文本文件统一使用 UTF-8、无 BOM、LF；现有文件的磁盘编码、BOM 和换行格式由底层维护。
无 BOM 的 UTF-16 编辑后若无法可靠识别，底层自动补同字节序 BOM；撤销恢复原始字节。
差异计算使用有界预算，无法定位的内部片段可能采用等价字节编码；Unicode 正文保持一致，撤销独立使用完整原字节。
编辑中的 `range` 接受单行 `51`、`[51]`，或闭区间 `[42,45]`。
下面是参数模板：`<fileRef>` 必须替换为真实读取回执中的引用，范围与正文按当前源码填写：

```json
{
  "action": "apply",
  "steps": [{
    "action": "edit",
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

默认事务预算为 100 个文件、每文件净变更 20,000 行、每事务净变更 50,000 行；宿主可通过
`corePolicy` 收紧或扩大。准备失败返回操作序号、阶段和读取恢复参数，任何准备失败都不写盘。
revision 默认使用内容指纹，能够检测同大小、保留 mtime 的外部修改。
文本写入通过同目录临时文件、同步与原子替换提交，保留文件 mode 和文本编码。
不完整 Unicode 会在准备阶段拒绝，文本里的字面反斜杠保持原义。
SDK 读取的 `maxBytes` 按逻辑 UTF-8 字节计费，CRLF 计一个换行；模型沿用返回的续读引用即可。

工具示例、schema 描述与实际提示词组装由[模型指导同步检查](../../docs/engineering/project-model-guidance-audit.md)约束，协议变更需要同步审核并通过测试。

## 内部结构

按仓库标准（`docs/architecture/module-ownership.md`）分五层：`contract/`（产品面、注入面、常量表）、`types/`（只有类型，
`types/project.ts` 是可移植数据）、`impl/`（一类一文件；`ProjectTools.ts` 是七个工具的定义，`operations/` 是工具背后的执行类，
`kernel/` 是领域内核，`plugins/`、`transactions/`、`files/`、`strategies/`、`adapters/`、`registries/`、`persistence/` 依次往下）、
`utils/`（纯函数与可调参数）、`exports/`（两个入口，只转发）。架构门禁禁止文件、编辑、事务服务反向依赖内核组装和 Agent 适配层。

## 可恢复事务与 Desktop 边界

需要跨进程重启继续 apply/rollback 的宿主，应把状态和 ChangeFeed 放在宿主私有目录，
并把有限事务面（只有 `list/get/subscribe/apply/rollback`，拿不到项目根、状态路径、provider）交给 UI transport；路径只在 host 侧出现：

```ts
import { createFileProjectChangeFeed, createProjectKernel, createProjectTransactionController } from '@velaros-ai/project'

const changeFeed = createFileProjectChangeFeed({ path: hostOwnedChangeFeedPath })
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
