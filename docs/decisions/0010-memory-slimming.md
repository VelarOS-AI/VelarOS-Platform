# 0010: 记忆瘦身：删掉知识库、放弃记忆树，记忆只认产品层给的一个作用域

- Status: accepted
- Date: 2026-09-18
- Owners: `@velaros-ai/velar`（memory、knowledge 两个单元）

## Context

用户原话：「知识库整个删掉，记忆系统放弃树，重构，作用域也需要进行重构，这是一次瘦身过程，做成简洁方便使用就好，不用承诺有多强……
它不应该知道外部的工作区，本质上只需要一个作用域而已，这个作用域应该是产品层传入的，按照作用域进行隔离即可。」

整包并进 velar 之后（`43573017`），两个单元的现状：

| 单元 | 行数 | 里面有什么 | 实际在用的 |
| --- | --- | --- | --- |
| `velar/memory` | 30,771 | 树 v1（SQLite + Dream）、树 v2（加密外置、擦除编排、TreeDiff）、文件档、向量档、叠加体、后端令牌族、证据采集桥、回合召回、四个模型面操作 | 文件档是 Desktop 出厂的权威层；向量档要配了嵌入才挂上；树 v1 在 Desktop 里当兜底；树 v2 有 16,633 行，除了探针没有任何引用 |
| `velar/knowledge` | 8,669 | 工作区摄入、分块、SQLite 全文加 LanceDB 向量、嵌入 profile 隔离 | 有了代码面，项目空间有 `velar:project` 的搜索和 `velar:code` 的符号，系统空间有 shell |

记忆难用，根子不在检索方式，在存了什么。采集桥把每条用户消息原样写成 `conversation` 条目，还有工作区、执行、桌面控制三路观察。
库里大半是原始记录，才需要向量去捞。文件档的代码注释里记着：聊天采集开着时，最近 24 条全是会话条目，画像召回一度稳定返回 0 条。

另一个根子是作用域。记忆自己拥有 `project:`、`site:`、`system`、`global` 四种前缀和一张可见性真值表：它要认识项目根和站点源，
还要把 global 并进每个空间。这些都是产品的概念。

参照物是 Claude Code 的自动记忆，VelarOS 的开发会话一直在用它。每个项目一个目录；`MEMORY.md` 一行一条，会话开场整份读进上下文；
一条记忆一个 Markdown 文件，模型用文件工具自己读写。到现在攒了 152 条、25KB，一次检索都没用过。

## Decision

### 知识库整个删掉

`velar:knowledge` 连同知识库引擎一起删，不留替代品。找资料用空间自己的能力：项目空间用 `velar:project` 的搜索和 `velar:code` 的符号，
系统空间用 `velar:shell`。LanceDB、Arrow、嵌入 profile 跟着一起走。

### 记忆是一个作用域一个目录的 Markdown

记忆不认识工作区、项目、站点和空间。宿主造记忆库时给一个根目录，之后每次再给一个作用域字符串。记忆不解释这个字符串，
只保证不同的作用域互相看不见。

```text
<根目录>/                          宿主给的，比如 Desktop 的 userData/memory
  <可读前缀>-<作用域哈希>/          一个作用域一个目录，第一次写入时才建
    .scope                         原样记着作用域字符串，列作用域时用
    reply-style.md                 一条记忆一个文件，文件名就是 id
    release-runbook.md
```

- 目录名的算法：把作用域字符串转成小写，非字母数字的字符换成 `-`，截到 48 个字符，后面接上 SHA-256 的前 16 位十六进制。
  前缀只是给人看的，身份靠哈希。整个名字都是小写，所以在大小写不敏感的文件系统上，两个作用域也不会落进同一个目录。
- 作用域按字符串逐字区分。规范化（比如路径解开符号链接、统一大小写）是产品层的事。

一条记忆长这样：

```markdown
---
title: 汇报用中文
description: 写给用户的文字都用中文，先给结论
type: feedback
tags: 汇报, 语言
updated: 2026-09-18T11:20:00.000Z
---

写给用户的文字一律用中文；命令、路径、报错原文不翻。
为什么：用户明确要求过。
怎么用：总结、说明、提问都用中文，代码和命令保持原样。
```

- id 就是文件名，只能用小写字母、数字和连字符，最多 64 个字符，也不许用 Windows 的保留名（con、nul、aux、prn、com1–9、lpt1–9）。
  id 由模型自己起，跟 Claude Code 里的 `name` 一样。
- 头部有五个字段：`title`、`description`、`type`、`tags`、`updated`（写入时由记忆库填）。写入是整条覆盖，头部里的其他字段不保留。
  只有 `tags` 例外：改一条时不给就沿用原来的标签，给 `[]` 才清空。模型看着开场索引改一条时拿得到 id、标题、描述和类别，
  拿不到每条的标签，整条覆盖会把标签悄悄清掉；其余字段都是必填，写什么就是什么，不存在漏写。
- `description` 是进索引的那一句，也是召回的钩子：模型只凭这一句判断什么时候该想起这条，所以要写成一眼看得出什么时候用得上的话，
  比如「发版时照做：Platform → 产品 → Cloud」，而不是「发版相关」。
- `tags` 是主题标签，给程序精确筛选用。它记的是「这条讲的是什么」，正文里不一定有这几个字：比如一条讲 `bun.lock` 版本号要手改的记忆，
  打上「发版」，按「发版」筛就不会漏掉它。每条 0 到 8 个，每个最多 32 个字符，不含逗号和换行；记忆库会去掉首尾空白、英文转小写、去重。
  同一个主题只用一种写法，先用已有的（索引末尾列着现有标签）。
- 类别有四种，照 Claude Code 来：
  - `user`：用户是谁、偏好与习惯。
  - `feedback`：对做事方式的纠正或肯定，写明原因和怎么用。
  - `work`：进行中的事、目标、约束与决定，限于从文件和记录里推不出来的。
  - `reference`：外部资源在哪。

  Claude Code 里第三类叫 `project`。这里改叫 `work`，因为记忆不认识项目，也免得和项目空间撞名。
- 正文是 Markdown，不拆成字段。写法按类别在声明和代码模版里教，不做校验：第一行写事实或规则；`feedback` 和 `work` 再写
  「为什么：」「怎么用：」两行；`reference` 写在哪、什么时候去看。
- 人手改过的文件照样认：没有头部时，标题取 id，描述取正文第一行，类别当作 `work`，标签为空，更新时间取文件的修改时间；认不出的类别也当作 `work`。

头部字段只收同时满足两个条件的：程序会按它筛，模型写的时候不费劲就能填对。`type`、`tags`、`updated` 满足；
置信度、过期时间、主语与谓词这类不满足，所以不加。按头部筛靠字段，按正文筛是程序里正则的事。

没有索引文件。Claude Code 里的 `MEMORY.md` 由模型手工维护，时间长了会和条目对不上；这里的索引每次都从各条的头部现算。

### 召回：开场一段索引，其余交给模型

`renderIndex()` 把这个作用域的条目排成一段 Markdown：

```markdown
## 记忆（共 32 条，括号里是 id）
### 用户
- [回复风格](reply-style) — 用户要所有汇报用中文，先给结论
### 反馈
- [提交前先看暂存区](check-staged-first) — 并行会话的改动会被一起卷进提交
### 工作
- …
### 参考
- …
现有标签：发版 5 · 提交 3 · 浏览器 2 · 汇报 1
另有 12 条没列出，用 list() 看全部。条目太多了，合适的时候合并重复的、删掉过时的。
```

宿主在会话开始时算一次，放进系统提示词，整场会话不变：

- 它放在代码面的 Tier0 之后，单独成一段。Tier0 按空间恒定，跨会话共用缓存；索引按作用域变，并进 Tier0 会让 Tier0 失去跨会话的缓存。
- 因为整场不变，前缀缓存不受影响，上下文治理也逐不掉它。会话里模型自己写了什么、删了什么，它自己知道；
  别的会话写的，下一个会话开场才看得到，要最新的就调 `list()`。
- 上限是 200 条、2 万字符（`utils/tuning.ts`）。先放 `user` 和 `feedback`，这两类总是适用；剩下的名额按更新时间给 `work` 和 `reference`。
  放不下的只报条数，就是上面示例里最后那句。
- 条目后面跟一行现有标签和各自的条数，按条数排，最多 30 个。它按全部条目算，不只算列出来的：模型写入时照着沿用，筛选时知道有哪些可以筛。
- 作用域里还没有记忆时，只有一句「还没有记忆」。

相关不相关由模型读索引判断，不设检索层：没有向量，没有全文索引，也没有打分。

### 模型面：三个操作

```ts
declare module 'velar:memory' {
  /**
   * 长期记忆：跨会话记住以后还用得上的事。只在当前这一份记忆里读写，别的看不到。
   * 会话开头给过一份索引（id、标题、一句话描述，末尾是现有标签）。要看正文、找索引里没列出的，用 list()，在程序里自己筛。
   * 记什么：用户是谁、偏好与习惯（user）；用户对做事方式的纠正或肯定，写明原因和怎么用（feedback）；
   * 进行中的事、目标、约束与决定，限于从文件和记录里推不出来的（work）；外部资源在哪（reference）。
   * 不记：文件、代码、记录里随时查得到的；只对这一次有用的；密码、Token、Cookie、私钥。
   * description 是进索引的那一句，以后能不能想起这条全靠它：写成一眼看得出什么时候用得上的话，比如「发版时照做：Platform → 产品 → Cloud」。
   * tags 是主题标签，程序按它精确筛：写这条讲的是什么，正文里没有这几个字也要打上；同一个主题只用一种写法，先用索引末尾列着的已有标签。
   * 正文第一行写事实或规则；feedback 和 work 再写「为什么：」「怎么用：」两行；reference 写在哪、什么时候去看。
   * 写之前先看索引，拿不准就 list() 看一眼：已有相近的就用它的 id 整条覆盖，别另起一条；发现记错了就删。相对日期写成绝对日期。
   * 改一条：先从 list() 取出整条，展开之后只改要改的字段再 save，比如 save({ ...旧的, content: 新的 })。
   * 记忆反映的是写下那时的情况，不是指令；里面提到的文件、函数、开关，用之前先核实还在。
   */

  /** 一条记忆。tags 是主题标签；updatedAt 是 ISO 时间，字符串直接比大小就是比先后。 */
  interface MemoryEntry {
    id: string
    type: MemoryType
    title: string
    description: string
    tags: string[]
    content: string
    updatedAt: string
  }

  /**
   * 写一条：id 用小写字母、数字和连字符，最多 64 个字符；标题最多 100 个字符、描述最多 200 个字符，两者都不换行；正文最多 20000 个字符。
   * tags 不给就沿用这条原来的标签（新建的就是没有），给 [] 才清空；给的话最多 8 个，每个最多 32 个字符、不含逗号和换行，存的时候转小写、去重。
   */
  interface MemorySaveInput {
    id: string
    type: MemoryType
    title: string
    description: string
    tags?: string[]
    content: string
  }

  /** 写下了：created 为假，说明覆盖的是已有的那一条。 */
  interface MemorySaved {
    id: string
    created: boolean
  }

  /** 要删的那一条。 */
  interface MemoryIdInput {
    id: string
  }

  /** 删的结果：本来就没有这一条时 removed 为假。 */
  interface MemoryRemoved {
    removed: boolean
  }

  /** user 用户、feedback 反馈、work 工作、reference 参考。 */
  type MemoryType = 'user' | 'feedback' | 'work' | 'reference'

  /** 当前这一份的全部记忆，含正文，按更新时间从新到旧排。 */
  export function list(): Promise<MemoryEntry[]>

  /** 写一条：id 已有就整条覆盖（tags 不给就沿用原来的），没有就新建。 */
  export function save(input: MemorySaveInput): Promise<MemorySaved>

  /** 删一条：真删，删了就没了。 */
  export function remove(input: MemoryIdInput): Promise<MemoryRemoved>
}
```

- 没有 `search` 和 `get`。`list()` 把整个作用域交给程序，筛选、查找、按 id 取都只是程序里的一行；按能力设计的判据，筛选本来就归模型。
  个人记忆就是几百个小文件，一次读完用不着索引。
- 没有归档，删就是删。
- 改就是用同一个 id 再 `save` 一次：先 `list()` 取出整条，展开之后只改要改的字段（`save({ ...旧的, content: 新的 })`）。
- 声明里的上限数字与常量表一致，由验收钉住。
- 入参不合法时一步都不做，回 `VALIDATION`，message 里写清楚怎么改，比如「id 只能用小写字母、数字和连字符，比如 reply-style」。
- 代码模版写四段日常用法：记一条偏好、改一条已有的、按标签找（再用正文关键词兜底）、删掉一条。

### 宿主面

```ts
createMemoryStore(options: { root: string }): MemoryStoreApi

interface MemoryStoreApi {
  /** 取一个作用域：之后的读写只落在它的目录里。 */
  scope(scope: string): MemoryScopeApi
  /** 列出有记忆的作用域，给管理页用。 */
  listScopes(): Promise<MemoryScopeSummary[]>   // { scope, count, updatedAt }
}

interface MemoryScopeApi extends MemoryScopePort {
  /** 会话开场放进系统提示词的那段索引。 */
  renderIndex(): Promise<string>
}

/** 三个操作经 ctx.memory 调它。 */
interface MemoryScopePort {
  list(): Promise<MemoryEntry[]>
  save(input: MemorySaveInput): Promise<MemorySaved>
  remove(input: MemoryIdInput): Promise<MemoryRemoved>
}

interface MemoryOperationContext {
  abortSignal: AbortSignal
  memory: MemoryScopePort
}
```

- 宿主每次分发 `memory` 命名空间的调用时，用 `store.scope(这个会话的作用域)` 装好 `ctx.memory`。模型碰不到作用域字符串，也就碰不到别的作用域。
- 写入先写临时文件再改名。同一个 id 两处同时写，后写的那次生效。
- 单元自己用 `node:fs/promises` 读写，不再注入文件端口。记忆存的就是它自己的目录，没有空间边界要守。

单元的结构按 ADR 0007：`contract/`（provides、requires、constants、生成的 surface）、`types/memory.ts`（可移植）、
`impl/MemoryOperations.ts`、`impl/MemoryStore.ts`、`impl/MemoryScope.ts`（分层从上到下），`utils/` 下是 `input.ts`（入参核对与规整）、
`entry-file.ts`（记忆文件的格式与宽容解析）、`index-text.ts`（排索引）、`scope-directory.ts`（作用域的目录名与排序）、
`fs.ts`（原子写与「不存在」按正常结果交回的几个磁盘动作）、`tuning.ts`，外加 `template.js` 与 `spec/`、`test/`。
实现（不含测试）718 行，模版 38 行，验收与测试 566 行。入参核对只在作用域那一层做一次：操作只查取消信号，宿主直接调作用域时同样过这一道。

### 删掉的

| 在哪 | 删什么 |
| --- | --- |
| `velar/memory` | 树 v1、树 v2、向量档、叠加体、后端令牌族与优先序、证据与信任级、采集桥、回合召回、Dream 调度、治理门面、写入前脱敏、作用域前缀与可见性真值表、归档 |
| `velar/knowledge` | 整个单元 |
| `velar` 包清单 | `./knowledge`、`./knowledge/contracts` 两个入口；依赖 `better-sqlite3`、`@types/better-sqlite3`、`@lancedb/lancedb`、`apache-arrow`；对 `@velaros-ai/agent` 的 peer 依赖保留（shell、sandbox 两个单元在用） |
| 仓库 | `scripts/memory/` 整个目录：边界门、十个探针、知识库 profile 检查，外加一个没人调用的本地软链脚本；`check:memory-boundaries`、`check:memory-knowledge-profile`、`probe:memory`，以及 `check:gates` 里引用它们的三处；根上的 `better-sqlite3`、`@electron/rebuild` 与只为重编 better-sqlite3 的 `postinstall`（核实过只有记忆与知识库在用）；`docs/engineering/refactor-plans/` 里记忆与知识库的三份旧迁移方案；`docs/memory/` 下的九份文档；`baselines/code-surface/knowledge.d.ts`；代码面登记表和模块所有权登记里的知识库条目；发版夹具里的知识库与旧记忆用法 |

## Alternatives

- **只删向量，留下文件档与作用域真值表**：噪音还在，采集照样写原始记录；作用域规则还是记忆在替产品想。否决。
- **用 SQLite 全文索引顶替向量**：又多出一份派生副本，个人记忆的量用不着。否决。
- **正文也拆成字段（键值，或者主语、谓词、取值）**：读记忆的是模型，带着上下文的散文它用得最好。结构化的取值要么太泛、帮不上忙，
  要么按类别长出一套又一套 schema，也就是这次删掉的树里的 concept、predicate、value。筛选要的结构由头部的 `type`、`tags`、`updated` 给。否决。
- **保留回合召回，改成字面匹配**：索引已经常驻，每轮再拿用户消息检索一遍是重复劳动；向量用得最多的也正是它。否决。
- **一次给多个作用域（当前加全局）**：那样记忆就得定义作用域之间的关系，又回到替产品想。需要跨场景的偏好，产品可以把几个场景映射成同一个作用域，
  或者写进产品自己的用户说明。否决。
- **让模型直接用文件工具读写记忆目录（Claude Code 的做法）**：记忆目录不在项目根下，项目空间出不去，浏览器空间也没有文件工具。
  三个操作正好是「模型自己做不到的那部分」。否决。
- **后台整理任务（顶替 Dream）**：先不做。索引超过上限时，开场那段会提醒模型合并和删除；真不够用再加。

## Security and privacy

- 记忆明文存放在宿主给的根目录下，不加密，也不脱敏。删就是删文件，没有派生副本残留，但也不承诺能从备份或磁盘上彻底抹掉。
- 作用域之间的隔离靠目录。操作只拿得到这个作用域的端口；id 只许小写字母、数字和连字符，出不了自己的目录。
- 被提示注入的模型可能写下假记忆。挡法是让它可见：产品在对话里显示每次写入与删除，用户随时能在管理页查看、修改、删除。不再有信任级。

## Compatibility and migration

这是破坏性改动，没有过渡期。`velar:memory` 的操作从 save、search、get、archive 变成 list、save、remove；宿主面整个换掉，
`mountMemoryAdapter`、`createMemoryRuntime`、各后端工厂和令牌族全部删除。

产品层（Desktop，在另一个仓，本 ADR 不动它）要做的：

1. 造一次 `createMemoryStore({ root: userData/memory })`。
2. 定下每个会话的作用域字符串。怎么定记忆不管。一种自然的定法：项目空间用项目根（解开符号链接后的路径），浏览器空间用站点源，系统空间用一个固定名字。
   想让偏好跨场景生效，就把这些场景映射到同一个作用域。
3. 会话开始时调 `renderIndex()`，结果放进系统提示词（Tier0 之后单独一段），存在会话上，整场不变。
4. 挂了 `velar:memory` 的空间把它设成常驻：该记什么、不该记什么的规矩写在声明里，模型得一直看得到。
5. 删掉这些：采集开关与采集桥的接线、`memory.recall` 回合上下文源、向量与嵌入设置、LanceDB 插件、知识库运行时、文件档的作用域根（`<项目>/.velaros/memory`）。
6. 旧数据：旧文件档里的条目可以一次性导入新布局，`conversation` 条目不导。树的 SQLite 和旧目录原样留着，不读也不删；删用户数据要用户明确签字。

## Validation

- 不变量重写成 13 条（测试 12 条、门禁 1 条），旧的 23 条随旧实现作废、编号从 1 重新起：作用域隔离（只差大小写也是两个作用域）；
  目录名与 `.scope`、`listScopes`；id 校验挡住路径穿越；整条覆盖与规整、原子写；真删；入参错误或已取消时不碰磁盘；
  人手改过的文件照样认；索引从条目现算（排序、条数与字数上限、标签行、空作用域）；代码面一条真路；声明与常量表一致；代码模版；分工门禁；改一条时标签的沿用。
- 代码模版的四段在真实的临时目录里逐个跑通。
- `check:module-ownership`、`check:code-surface`、全量 `bun run check`。

## Consequences

- 记忆与知识库两个单元删掉 196 个文件、40,331 行；新的记忆单元实现 718 行。velar 不再依赖任何原生模块或向量库，`bun.lock` 少了 125 行。
- 记忆能做的事很窄：召回全靠开场那段索引加上模型自己读；条目多到放不下时，要靠合并和删除来收拾。
- 模型包里的嵌入接口失去最后一个消费者，核实没有别的用处后，另开一步删掉。
- 「把记忆库做成独立产品（AI 应用的数据库）」这个设想到此为止。
