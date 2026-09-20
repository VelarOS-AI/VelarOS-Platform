# @velaros-ai/velaros/files 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 模型面是 `baselines/script/files.d.ts`（由 `@AgentView` 从 `FileOperationsApi` 与它引用的类型生成），那是模型看到的全部。
> 先看 `impl/FileOperations.ts` 类上方的接口（`contract/provides.ts` 登记它），本机实现看 `impl/LocalFilePort.ts` 与 `impl/LocalFileSearch.ts`；utils 里每个函数上方有一句说明。
> 门禁：`bun run check:module-ownership`、`bun run check:script`。

## 这是什么

本机文件的读写能力：代码面 `velaros:files` 的 `read`、`edit`、`undo`，系统空间挂它。

**本机文件与项目文件是两件能力。** 项目里的文件有项目那一套（fileRef、校验器、事务与撤销账本），
在 `@velaros-ai/velaros/project` 的 `velaros:project`；本机上的文件没有这些，要的是：路径哪儿都能到、
写是原子的、改错了能整次撤回。两边硬合成一套，只会让一边为另一边的规则买单，所以各是一件能力、各有一份实现。
看图对两边是同一件事，拆在 `@velaros-ai/velaros/images`。

**能力靠端口注入**：挂 `velaros:files` 的空间给一个 `FileSpacePort`——路径怎么解析、越界算不算、怎么落盘都在端口里。
有界地读、认编码、按行拆合、核版本、留原文与撤回、一批的成败在这里只做一份。

**本机实现也在这里**（`./local` 入口，只给 Node）：本机文件端口 `createLocalFilePort`——路径怎么解析由宿主给的 `resolvePath` 定（系统空间：`~` 展开到家目录、
相对路径相对工作目录），读写解开符号链接之后的那个文件，写是逐个原子替换、撤回一次新建是核对后删掉；还有给宿主界面的全局搜索 `createLocalFileSearch`
（按路径名或内容搜一棵目录树，模型碰不到——模型列目录、搜文本用命令）。装空间是产品的事（ADR 0013）。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `fileOperations` | `FileOperationsApi` | 代码面 `files` 命名空间的三个操作：带行号地读、按行号改或整份写、整次撤回 |
| `FileLimits` | 契约常量 | 公开上限：批量条数、单文件字节、读的字符预算、一个文件改几处、留原文的上限、留几次改动 |
| `FileErrorCodes` | 契约常量 | 三个专属错误码：`FILES_EDIT_UNRESOLVED`、`FILES_EDIT_DENIED`、`FILES_UNDO_CONFLICT`，模型的程序接住异常时 `error.code` 就是它 |
| `createLocalFilePort` | `FileSpacePort`（requires；`./local` 入口） | 本机文件端口：任意位置、解开符号链接、逐个原子替换、撤回新建时核对后删掉，做到一半出错在 `context.applied` 里点名 |
| `createLocalFileSearch` | `LocalFileSearchApi`（`./local` 入口） | 给宿主界面的全局搜索：按路径名（包含、精确、模糊）或按内容（字面、正则）搜一棵目录树，跳过隐藏项、依赖目录、gitignore 忽略项与受保护目录 |
| `VelarFilesModule` | 生成的合同（`contract/surface.ts`） | `velaros:files` 随包发布的模型面：模块名、放出去的方法、生成的完整声明（与 `baselines/script/files.d.ts` 同一份）；空间挂这件能力时交给代码面的门 |

**数据面**是 `types/`：`types/files.ts` 是可移植数据（读的入参、写与撤回的入参和结果、空间定位出来的路径 `FileLocation`，全局搜索的入参与结果），
`types/text.ts` 是读的结果（带文本编码，从根入口导出）与读的工作类型，`types/space.ts` 是空间端口上流动的数据
（`FileWrite`，带 `Buffer`，从根入口导出），`types/edit.ts` 是写与撤回的工作类型（计划、印记、问题、留着的改动），`types/search.ts` 是全局搜索的工作类型，不出包。

三个入口对应包清单 `exports` 里的 `./files`、`./files/contracts` 与 `./files/local`，源文件是单元目录上的 `index.ts`、`contracts.ts` 与 `local.ts`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `./files` | Node 宿主 | 三个操作、空间端口，本机实现的接口与配置，它们用到的数据 |
| `./files/contracts` | 任何进程，含浏览器 | 常量表与可移植数据 |
| `./files/local` | Node 宿主 | 本机实现的两个工厂：`createLocalFilePort`、`createLocalFileSearch` |

**注入面**在 `contract/requires.ts`：

| 接口 | 谁给、什么时候给 |
| --- | --- |
| `FileSpacePort` | 每个挂 `velaros:files` 的空间一份：`locate`（作用域：给模型看的路径、真正读写的目标、是不是经过链接）、`commit`（落盘：按顺序写或删、核对 expected、点名已做的） |
| `FileOperationContext` | 宿主每次分发 `files` 命名空间的调用时装好：取消信号、上面那个端口 |
| `LocalFilePortOptions` | 建本机文件端口时必须：`resolvePath`（把模型给的路径解析成绝对路径；本机 shell 宿主的 `resolvePath` 就是一个） |
| `LocalFileSearchOptions` | 建全局搜索时给，全可缺省：平台、家目录（判定受保护的目录用） |

## 骨干链路

| 能力 | 链路 |
| --- | --- |
| 读 `read` | `fileOperations.read`：核对取消信号 → `batchItems` 核对形状与条数 → 每个文件：`ctx.files.locate` → 核对 range → `readBoundedFile`（20 MB 上限）→ 认出图片与 PDF 就拒 → `decodeText` 严格解码 → `splitLines` 按 `wc -l` 的数法拆行 → `numberedLines` 取出那几行（超出这次剩下的字符预算就单独失败）→ 某一项失败只标记它，全部失败才整个抛 |
| 写 `edit` | `fileOperations.edit`：第一段每个文件定位（越界算被拒）→ 按真实路径判重 → `planFileEdit`（排除目录、特殊文件、多硬链接、超大文件、坏上级；已有的整份读进来：二进制拒改、核对 version；edits 经 `applyLineEdits` 按读到的那一版改，newText 经 `toFileNewlines` 换成原文件的换行；按原编码编好，GB18030 没改的片段沿用原字节；写出去超过 20 MB 的不写）→ 有问题整批抛 `FILES_EDIT_UNRESOLVED` / `FILES_EDIT_DENIED` → 再 stat 一次，印记证明不了没变的重读核版本 → 第二段 `ctx.files.commit`（每项带 expected）→ `FileChanges.record` 记成一次改动，交回改动号；落盘途中出错时点名已写的，并把已写的那几个记成一次改动、给出撤回的号 |
| 本机文件端口 | `locate`：`resolvePath` → 解开符号链接得到真实目标；`commit`：按顺序写或删——写是补建上级目录后原子替换（同目录临时文件写完 fsync 再改名，权限位原样保留，核对 expected），删（撤回一次新建）是核对 expected 之后删掉；出错时在 context.applied 里点名已做的 |
| 全局搜索 | `LocalFileSearch.search(根, 选项)`：根不存在报 `NOT_FOUND` → 按名字排序、不跟随符号链接地遍历 → 路径模式按相对路径匹配、可按扩展名与条目类型筛；内容模式逐行搜（跳过大文件、读不出文本的、命名管道），每个文件有条数上限 → 找够就停并标 truncated |
| 撤回 `undo` | `fileOperations.undo`：`FileChanges.recall` 取回改动（没有就 `NOT_FOUND`，撤过的如实回执，原文没留的拒）→ 每个文件核对：还是那次改完的版本的要撤，已经是改之前的样子的（上一次撤回做了一半）跳过，别的就整个抛 `FILES_UNDO_CONFLICT` → `ctx.files.commit`（写回原文、删掉新建的，都带 expected）→ 标记已撤回；做到一半出错时点名已退回的，再撤一次接着撤剩下的 |

## 依赖什么

- 上游包：`@velaros-ai/core`（类型守卫、`AppError`、日志、真实路径、errno 码）、`@velaros-ai/core/platform`（规整用户输入的路径、平台名）、`@velaros-ai/core/text-files`（编码识别、严格解码、按原编码编回、有界读、原子替换写入）、
  `@velaros-ai/core/path-rules`（全局搜索的忽略策略）。
- 只在验收里用：`@velaros-ai/script`（dev 依赖），跑端到端的程序、给代码模版做类型检查。
- 用到的 Node 内置模块：`fs/promises`（stat、读写文件、删除）、`crypto`（版本号、改动号）、`path`、`os`（家目录）。只在根入口与 `./local` 的引用链上；`./contracts` 不碰。
- 不读环境变量。

## 状态归谁

`fileOperations` 持有一份 `FileChanges`：留着能撤回的改动，只在内存里——每次改动每个文件改之前的原文（不超过 `FileLimits.undoBytes` 的才留，新建的记为不存在）与改完的版本；
最多留最近 `FileLimits.undoChanges` 次、原文总量有上限，超了从最早的丢起。随进程消失；持久化的历史是宿主的事。

## 生命周期

没有需要释放的东西；留着的改动随进程存在。

## 失败语义

- 一批里的读：某一项失败只标记它（`{ path, error: { code, message } }`），全部失败才整个抛第一个失败。
- 写：整批要么全写要么一个不写。写不下去抛 `FILES_EDIT_UNRESOLVED`，被拒（用户没点头、越出空间范围、空间不许写）抛 `FILES_EDIT_DENIED`，message 逐条写明；落盘途中出错时 message 点名已经写进去的文件，并给出撤回它们的改动号。
- 撤回：整次要么全撤要么一个不撤；之后又被改过抛 `FILES_UNDO_CONFLICT`，点名是哪几个。
- 形状不对、条数不对、文件太大、不是文本、行号越界、版本对不上：`VALIDATION`。找不到文件、改动号找不到：`NOT_FOUND`。没有权限、越出范围：`PERMISSION`。
- 代码面只把 `code` 与 `message` 交给程序，所以模型要知道的都写在 message 里。

## 不变量

共 15 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。INV-14～INV-16 是本机文件端口的承诺，随实现从 `@velaros-ai/system` 搬来（原 INV-19、INV-20、INV-36，ADR 0013）。
按检验方式：测试 14 条、门禁 1 条。未验证 0 条。

## 非目标

- 不决定作用域：路径相对谁、越界算不算，全由空间注入的 `FileSpacePort` 说了算；本机文件端口本身不设范围。
- 不装空间：哪个空间挂 `velaros:files`，是产品的事（ADR 0013）。
- 读写前不问人：凭证文件、系统敏感路径照常读写（shell 本来就能读写它们，这里拦了也拦不住）。
- 不管项目文件：fileRef、事务、校验器是 `velaros:project` 的事。
- 模型面不列目录、不搜文本、不看图、不读 PDF 与其他文档：列和搜用命令（`velaros:shell`，`rg -n` 带行号），看图用 `velaros:images`，文档另有能力。全局搜索只给宿主界面。
- 不分页：行落在程序的变量里，模型看不到它；模型自己在程序里切片、筛选，只交出要看的那几行。

## 结构

```text
files/
  contract/     对外合同：provides.ts 登记操作与全局搜索的 API，requires.ts 是空间端口、调用上下文与本机实现的配置，constants.ts 是错误码与公开上限；surface.ts 是生成的模型面（随包发布的声明）
  types/        只放类型：files.ts 是可移植数据，text.ts 是读的结果与读的工作类型，space.ts 是空间端口上的数据，edit.ts 是写与撤回的工作类型，search.ts 是全局搜索的工作类型
  impl/         一类一文件：FileOperations（velaros:files）、FileChanges（留着能撤回的改动）、LocalFilePort（本机文件端口）、LocalFileSearch（全局搜索）
  utils/        batch.ts（一批的核对与失败）、plan.ts（一个文件的写入规划）、lines.ts（拆行、按行号改、拼回、换行风格）、text-file.ts（有界读、解码、版本、印记、媒体类型）、
                paths.ts（判重的身份键）、fs.ts（系统错误码、原子写入、核对后删除）、search.ts（全局搜索的跳过与匹配）、tuning.ts（可调参数）；全是函数与常量，每个函数上方一句说明
  index.ts      `./files` 入口，只转发
  contracts.ts  `./files/contracts` 入口，只转发
  local.ts      `./files/local` 入口，只转发
  template.js   代码模版：日常用法的示例程序，随模型面发布、按需读，不嵌进声明
  spec/         不变量登记、验收测试、共用的真磁盘空间端口
  test/         实现细节测试
```

**分层。** 上层是 `FileOperations.ts`（代码面的三个操作）与 `LocalFilePort.ts`、`LocalFileSearch.ts`（本机实现，三者互不依赖），下层是 `FileChanges.ts`（留着的改动）；上层持有下层。

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出；公开的在 `contract/provides.ts` 登记。整个进程只需要一份的，文件末尾给出那一份，按公开接口标注类型。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `FileOperations.ts` | `FileOperationsApi`（同文件，provides 登记） | 代码面 `files` 命名空间的三个操作 |
| `FileChanges.ts` | `FileChangesApi`（同文件，包内） | 留着能撤回的改动：记、取、标记撤回、按预算淘汰 |
| `LocalFilePort.ts` | `FileSpacePort`（requires） | 本机文件端口：定位与落盘 |
| `LocalFileSearch.ts` | `LocalFileSearchApi`（同文件，provides 登记） | 给宿主界面的全局搜索 |
