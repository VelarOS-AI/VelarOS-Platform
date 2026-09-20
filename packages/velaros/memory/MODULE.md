# @velaros-ai/velaros/memory 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 模型面是 `baselines/script/memory.d.ts`（由 `@AgentView` 从 `MemoryOperationsApi` 与它引用的类型生成），那是模型看到的全部。
> 先看 `impl/MemoryOperations.ts` 类上方的接口，再看 `impl/MemoryStore.ts`、`impl/MemoryScope.ts` 的接口；utils 里每个函数上方有一句说明。
> 设计与取舍见 `docs/decisions/0010-memory-slimming.md`。门禁：`bun run check:module-ownership`、`bun run check:script`。

## 这是什么

**跨会话的长期记忆：一个作用域一个目录的 Markdown。** 一条记忆一个 `<id>.md`，头部五个字段（title、description、type、tags、updated），
下面是正文。模型面是代码面 `velaros:memory` 的三个操作——`list`（这一份的全部记忆，含正文）、`save`（同一个 id 就整条覆盖，只有没给的 tags 沿用原来的）、
`remove`（真删）；宿主面是记忆库本身：给一个根目录，按作用域取一份，会话开场排一段索引放进系统提示词。

**记忆不认识工作区、项目、站点与空间。** 作用域是产品层给的任意非空字符串，记忆不解释它，只按它隔离：一个作用域一个目录，
目录名是小写可读前缀接作用域字符串的哈希。项目根、站点源怎么变成作用域，是产品层的事。

**召回没有检索层。** 会话开场的索引按类别分组、一行一条，模型读索引自己判断哪条相关，要正文就 `list()` 在程序里筛；
没有向量、没有全文索引、没有打分，删一个文件就删干净了。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `memoryOperations` | `MemoryOperationsApi` | 代码面 `memory` 命名空间的三个操作：查取消，再经 `ctx.memory` 调作用域 |
| `createMemoryStore` | `MemoryStoreApi` | 造记忆库：`scope(作用域)` 交回一份 `MemoryScopeApi`（三个操作要的端口加 `renderIndex`），`listScopes()` 列出有记忆的作用域 |
| `MemoryTypes`、`MemoryLimits` | 契约常量 | 四个类别（也是索引分组的顺序）与公开上限：id、标题、描述、正文、标签 |
| `VelarMemoryModule` | 生成的合同（`contract/surface.ts`） | `velaros:memory` 随包发布的模型面：模块名、放出去的方法、生成的完整声明（与 `baselines/script/memory.d.ts` 同一份）与代码模版；空间挂这件能力时交给代码面的门 |

**数据面**是 `types/memory.ts`，可移植：模型面的入参与回执（`MemoryEntry`、`MemorySaveInput`、`MemorySaved`、`MemoryIdInput`、`MemoryRemoved`、`MemoryType`），
以及管理页用的作用域概况 `MemoryScopeSummary`。

两个入口对应包清单 `exports` 里的 `./memory` 与 `./memory/contracts`，源文件是单元目录上的 `index.ts` 与 `contracts.ts`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `./memory` | Node 宿主 | 三个操作、记忆库的工厂、产品面与注入面的全部接口 |
| `./memory/contracts` | 任何进程，含浏览器与渲染进程 | 常量表、可移植数据、`VelarMemoryModule` |

**注入面**在 `contract/requires.ts`：

| 接口 | 谁给、什么时候给 |
| --- | --- |
| `MemoryScopePort` | 三个操作经 `ctx.memory` 调它；宿主不用自己实现，`createMemoryStore({ root }).scope(作用域)` 交回的就是一份 |
| `MemoryOperationContext` | 宿主每次分发 `memory` 命名空间的调用时装好：取消信号、这个会话的作用域端口 |
| `MemoryStoreOptions` | 宿主造记忆库时给：根目录（绝对路径） |

## 骨干链路

| 能力或动作 | 链路 |
| --- | --- |
| `list` | `memoryOperations.list` 查取消 → `ctx.memory.list()` → 列作用域目录（还没建就是空的）→ 只认 `<合法 id>.md` → 逐个读文件与修改时间，`parseMemoryFile` 宽容解析 → `compareByRecency` 从新到旧 |
| `save` | 查取消 → `ctx.memory.save(input)` → `saveInput` 核对并规整（id、类别、一行字段、正文、标签）→ 读这个 id 原来的文件（没有就是新建；入参没给 tags 时沿用它的标签）→ 建目录、`.scope` 没有就写上 → `serializeMemoryFile` 带上这次的更新时间 → 临时文件改名落盘 → `{ id, created }` |
| `remove` | 查取消 → `ctx.memory.remove(input)` → `removeInput` 核对 id → 删文件，本来就没有时 `removed` 为假 |
| 开场索引 | 宿主在会话开始时调 `scope.renderIndex()` → `list()` → `renderMemoryIndex`：先放 user 与 feedback、再按更新时间放 work 与 reference，条数或字数到上限就停 → 按类别分组、一行一条 → 现有标签一行 → 没列的报条数 |
| 列作用域 | `store.listScopes()` → 列根目录 → 读各目录的 `.scope` 拿原串 → 各自 `list()` 数条数、取最近更新 → 没有记忆的不列 → 最近更新的在前 |

## 依赖什么

- 上游包：`@velaros-ai/core`（类型守卫、`AppError`、errno 读取）。
- 只在验收里用：`@velaros-ai/script`，跑端到端的程序、给代码模版做类型检查。
- 用到的 Node 内置模块：`fs/promises`、`path`、`crypto`（目录名的哈希、临时文件名）。只在根入口的引用链上；`./memory/contracts` 不碰。
- 不读环境变量，不发网络请求，不开数据库。

## 状态归谁

- **持久状态**全在宿主给的根目录里：一个作用域一个目录，一条记忆一个文件，外加记着作用域原串的 `.scope`。没有索引文件，也没有任何派生副本。
- **进程内状态**没有：记忆库与作用域对象只记着根目录、作用域字符串与目录路径，每次调用都从磁盘现读。

## 生命周期

`createMemoryStore({ root })` 造一次，整个进程共用；每个会话 `store.scope(作用域)` 取一份，会话开始时 `renderIndex()` 一次、整场不变。
没有需要启动或释放的东西，目录在第一次写入时才建。

## 失败语义

- 入参不合法、作用域是空的、根目录不是绝对路径：`VALIDATION`，message 写清楚怎么改，一个文件都不写、不删。
- 取消信号已经触发：三个操作抛出取消原因，不碰磁盘。
- 删一条本来就没有的：不是失败，`removed` 为假。
- 磁盘本身的错（权限、磁盘满）原样抛出；「不存在」按正常结果交回（空列表、`removed` 为假）。
- 代码面只把 `code` 与 `message` 交给程序，所以模型要知道的都写在 message 里；按 `code` 分支，不要拿中文 message 判断。

## 不变量

共 13 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排；ADR 0010 重写本单元时旧编号整体作废、从 1 重新起。
按检验方式：测试 12 条、门禁 1 条。未验证 0 条。

## 非目标

- 不检索：没有向量、没有全文索引、没有打分，也没有每轮自动召回；相关不相关由模型读索引判断。
- 不认识产品：不知道工作区、项目、站点、空间，也不定义作用域之间的关系；一次只有一个作用域。
- 不自动采集：记什么由模型在对话里决定，不从聊天、工作区或执行事件里自动抓。
- 不做知识库：工作区资料用各空间自己的搜索与读文件。
- 不加密、不脱敏、不承诺能从备份或磁盘上彻底抹掉；删就是删文件。
- 不归档、不留历史版本：整条覆盖就是改，删就是删。

## 结构

```text
memory/
  contract/      对外合同：provides.ts 登记类上方的接口，requires.ts 是作用域端口、调用上下文与记忆库的选项，
                 constants.ts 是四个类别与公开上限；surface.ts 是生成的模型面
  types/         只放类型：memory.ts 可移植（模型面的入参与回执、作用域概况）
  impl/          实现：一个类一个文件，文件名即类名
    MemoryOperations.ts    velaros:memory 的三个操作
    MemoryStore.ts         记忆库：根目录下按作用域分目录，列出有记忆的作用域
    MemoryScope.ts         一个作用域：读写目录里的条目，排开场索引
  utils/         纯工具函数：input.ts（入参核对与规整）、entry-file.ts（记忆文件的格式与宽容解析）、index-text.ts（开场索引的排法）、
                 scope-directory.ts（作用域的目录名与排序）、fs.ts（原子写与「不存在」按正常结果交回的几个磁盘动作）、tuning.ts（索引的上限）
  index.ts       `./memory` 入口，只转发
  contracts.ts   `./memory/contracts` 入口，只转发
  template.js    代码模版：日常用法的示例程序，随模型面发布、按需读，不嵌进声明
  spec/          不变量登记、验收测试、共用的临时目录与会话
  test/          每个源文件单独加载、构建产物的入口
```

**分层**（登记在 `scripts/ownership/governed-modules.mjs`，上层可以引下层与同层，下层不许引上层）：
`MemoryOperations.ts` → `MemoryStore.ts` → `MemoryScope.ts`；utils 在所有层下面。
