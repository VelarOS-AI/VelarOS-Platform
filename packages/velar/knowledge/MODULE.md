# @velaros-ai/velar/knowledge 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 模型面是 `baselines/code-surface/knowledge.d.ts`（由 `@AgentView` 从 `KnowledgeOperationsApi` 与它引用的类型生成），那是模型看到的全部。
> 先看 `impl/KnowledgeOperations.ts` 类上方的接口，再看 `contract/requires.ts` 的空间端口；utils 里每个函数上方有一句说明。
> 门禁：`bun run check:module-ownership`、`bun run check:code-surface`。

## 这是什么

工作区知识检索：代码面 `velar:knowledge` 的三个操作——`search`（全文加语义的混合检索）、`sync`（把工作区增量同步进索引）、
`diagnostics`（看索引健康）。

本单元只是工具那一层：入参核对、定工作区、零命中时补一次同步、把结果投影成模型面的形状。知识库本身——摄入、分块、
SQLite 全文、LanceDB 向量、嵌入——在 `@velaros-ai/knowledge`，它不是工具、不在 velar 里；宿主拿它的领域门面实现本单元的空间端口。

**零命中替模型补一次同步。**「这个工作区里真没有」和「索引压根没建过」交回来都是零条，模型分不出来。所以零命中时补一次增量同步，
补进了内容就重搜一次，结果里的 `autoSync` 如实说明；它出现而 `count` 仍为 0，就是真没有。有命中时检索是纯读的，不写任何东西。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `knowledgeOperations` | `KnowledgeOperationsApi` | 代码面 `knowledge` 命名空间的 search、sync、diagnostics |
| `VelarKnowledgeModule` | 生成的合同（`contract/surface.ts`） | `velar:knowledge` 随包发布的模型面：模块名、放出去的方法、生成的完整声明（与 `baselines/code-surface/knowledge.d.ts` 同一份）与代码模版；空间挂这件能力时交给代码面的门 |

**常量表**是 `contract/constants.ts`：`KnowledgeSourceKinds`（来源类型）与 `KnowledgeSearchLimits`（limit 的缺省与上限、提示与文档 id 的条数），
都是写进声明给模型看的数字，两边一致由验收核对。

**数据面**是 `types/`：`types/knowledge.ts` 是可移植数据（模型面的入参与回执，加上空间端口上流过的形状——端口上的只写操作真会读的字段，
知识库引擎交回的比它宽，结构上满足它）；`types/search.ts` 是入参核对与索引问题归类的中间形状，不出单元。

两个入口对应包清单 `exports` 里的 `./knowledge` 与 `./knowledge/contracts`，源文件是单元目录上的 `index.ts` 与 `contracts.ts`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `./knowledge` | Node 宿主 | 三个操作、注入面与它们用到的数据 |
| `./knowledge/contracts` | 任何进程，含浏览器、渲染进程 | 常量表、可移植数据、`VelarKnowledgeModule` |

**注入面**在 `contract/requires.ts`：

| 接口 | 谁给、什么时候给 |
| --- | --- |
| `KnowledgeOperationContext` | 空间每次分发 `knowledge` 命名空间的调用时装好：取消信号与下面的端口 |
| `KnowledgeSpacePort` | 每个挂 `velar:knowledge` 的空间一份：`resolveWorkspace`（这次落在哪个工作区，空间的决定）加三个知识方法（`getDiagnostics`、`ensureWorkspaceSynced`、`searchKnowledge`，名字与形状就是知识库领域门面的，宿主直接转过去） |

**宿主怎么挂**：`createKnowledgeRuntime(providers)` 造一份知识库（`@velaros-ai/knowledge`），端口的三个知识方法转给它的 `knowledgeDomainService`，
`resolveWorkspace` 写空间自己的规矩（项目空间给项目根；没有默认工作区的空间在没给时抛 `VALIDATION`）；空间把三个操作挂到 `knowledgeOperations` 上，
门那边交 `VelarKnowledgeModule`。

## 骨干链路

每个操作的顺序都固定：先查取消、再核对入参、再定工作区、最后做事——入参错了一步都不做。

| 操作 | 链路 |
| --- | --- |
| `search` | 查取消 → `searchInput`：query 非空（去掉首尾空白）、来源类型只认常量表、提示与文档 id 不超上限、limit 缺省 8、最多 50 → `ctx.knowledge.resolveWorkspace` → `searchKnowledge` → 零命中时 `ensureWorkspaceSynced` 补一次（失败只是没有 autoSync），补进了内容才重搜一次 → `projectHit` 投影每条命中（`utils/mapper.ts`）→ `summarizeIndexIssues` 把命中里的索引错误按原因归类 |
| `sync` | 查取消 → `syncInput`：可以不给入参，给了就核对工作区与 force → `resolveWorkspace` → `ensureWorkspaceSynced(root, { force })` → 只交回同步的计数 |
| `diagnostics` | 查取消 → `getDiagnostics` → `projectHealth`：计数原样，文件索引、向量库、嵌入运行时各取模型用得上的那一项 |

## 依赖什么

- 上游包：`@velaros-ai/core`（类型守卫、`isEmpty`、`AppError`）。
- 只在验收里用：`@velaros-ai/code-surface`，跑端到端的程序、给代码模版做类型检查。
- 不依赖 `@velaros-ai/knowledge`：端口上的形状是本单元自己写的，引擎结构上满足它们；宿主同时装两边、在装配处接上。
- 没有 Node 内置模块、不读环境变量。

## 状态归谁

无状态：每次调用核对、交给端口、投影，不留任何东西。索引、同步节流台账、向量都在知识库引擎里。

## 生命周期

没有需要释放的东西。知识库的连接与向量库由宿主经 `@velaros-ai/knowledge` 的运行时开关。

## 失败语义

- 入参不合法（query 空、来源类型不认、条数超上限、limit 不是 1 到上限的整数、workspaceRoot 不是非空文字、force 不是布尔）：`VALIDATION`，端口一次都不调。
- 空间没有默认工作区、调用又没给 workspaceRoot：端口的 `resolveWorkspace` 抛 `VALIDATION`，message 说要给 workspaceRoot。
- 零命中时补的那次同步失败：不改写检索的成败，检索照常交回，只是没有 `autoSync`。
- 知识库引擎的其他失败原样交给程序；代码面只把 `code` 与 `message` 交给程序，所以模型要知道的都写在 message 里。
- 命中里记着的索引错误不是失败：按原因归类进 `indexIssues`，`actionable` 的（嵌入凭据坏了这类）附上该让用户做什么。

## 不变量

共 9 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 8 条、门禁 1 条。未验证 0 条。

## 非目标

- 不做知识库：摄入、分块、全文与向量检索、嵌入都在 `@velaros-ai/knowledge`。
- 不设确认闸（ADR 0009）：同步只改知识库自己的索引，不碰用户的文件。
- 不暴露重建索引：显式重建是设置页的入口，归宿主；模型要的「刚改过、马上搜到」由 `sync({ force: true })` 覆盖。
- 不读文件、不找代码符号：知道路径就读文件，符号与引用用代码能力，这里找的是「不知道在哪」的知识。

## 结构

```text
knowledge/
  contract/     对外合同：provides.ts 登记三个操作的 API，requires.ts 是调用上下文与空间端口，constants.ts 是来源类型与公开上限；surface.ts 是生成的模型面（随包发布的声明）
  types/        只放类型：knowledge.ts 是可移植数据（模型面与端口上的形状），search.ts 是入参核对与索引问题归类的中间形状
  impl/         一类一文件：KnowledgeOperations（velar:knowledge）
  utils/        纯函数：input.ts（入参核对）、mapper.ts（命中与诊断投影成模型面的形状）、index-issues.ts（索引问题归类）；每个函数上方一句说明
  index.ts      `./knowledge` 入口，只转发
  contracts.ts  `./knowledge/contracts` 入口，只转发
  template.js   代码模版：日常用法的示例程序，随模型面发布、按需读，不嵌进声明
  spec/         不变量登记、验收测试、共用的假知识库与模型程序跑法
  test/         实现细节测试：交给端口的请求、索引问题合并、取消；代码模版逐个函数跑通
```

**分层。** 只有一层：`KnowledgeOperations.ts`（代码面的三个操作）。

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出；公开的在 `contract/provides.ts` 登记。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `KnowledgeOperations.ts` | `KnowledgeOperationsApi`（同文件，provides 登记） | 代码面 `knowledge` 命名空间的三个操作 |
