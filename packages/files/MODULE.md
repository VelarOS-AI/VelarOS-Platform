# @velaros-ai/files 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 模型面是 `baselines/code-surface/files.d.ts`（由 `@AgentView` 从 `FileOperationsApi` 与它引用的类型生成），那是模型看到的全部。
> 先看 `src/impl/FileOperations.ts` 类上方的接口（`contract/provides.ts` 登记它），utils 里每个函数上方有一句说明。
> 门禁：`bun run check:module-ownership`、`bun run check:code-surface`。

## 这是什么

所有空间共用的文件能力：代码面 `velar:files` 的 `read`、`view`、`edit`。

**能力不绑空间**：只有这一份实现，每个空间注入自己的 `FileSpacePort`——路径怎么解析、越界算不算、哪些要先问用户、
怎么落盘（系统空间逐个原子替换，项目空间可以合成一个事务），都在端口里。所有空间都一样的事在这里只做一份：
有界地读、认编码、核版本、留版本、判重、压图、一批的成败。模型那边因此只有一套说明，两个空间看到的是同一份声明与代码模版。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `fileOperations` | `FileOperationsApi` | 代码面 `files` 命名空间的三个操作：读文本、看图片、整批写 |
| `FileLimits` | 契约常量 | 公开上限：批量条数、单文件字节、读的字符预算、留版本的上限、交给模型的图的长边与 base64 字节 |
| `FileErrorCodes` | 契约常量 | 两个专属错误码：`FILES_EDIT_UNRESOLVED`、`FILES_EDIT_DENIED`，模型的程序接住异常时 `error.code` 就是它 |

**数据面**是 `types/`：`types/files.ts` 是可移植数据（三个操作的入参与看、写的结果，空间定位出来的路径 `FileLocation`），
`types/text.ts` 是读的结果（带文本编码，从根入口导出）与读和看的工作类型，`types/space.ts` 是空间端口上流动的数据
（`FileConfirmation`、`FileWrite`、裁图缩图的请求与结果、交给模型看的一张图，带 `Buffer`，从根入口导出），
`types/edit.ts` 是写的工作类型（计划、印记、版本、问题），不出包。

两个入口对应 `package.json` 的 `exports`，源文件是 `src` 根上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主 | 三个操作、空间端口、它们用到的数据 |
| `./contracts` | 任何进程，含浏览器 | 常量表与可移植数据 |

**注入面**在 `contract/requires.ts`：

| 接口 | 谁给、什么时候给 |
| --- | --- |
| `FileSpacePort` | 每个挂 `velar:files` 的空间一份：`locate`（作用域：给模型看的路径、真正读写的目标、是不是经过链接）、`reviewRead` / `reviewWrite`（策略：不许就抛，要问就交回确认请求）、`commit`（落盘：按顺序写、核对 expected、点名已写的）、可选的 `resizeImage`（宿主的图像处理） |
| `FileOperationContext` | 宿主每次分发 `files` 命名空间的调用时装好：取消信号、上面那个端口、审批端口、可选的交图通道 |

## 骨干链路

| 能力 | 链路 |
| --- | --- |
| 读 `read` | `fileOperations.read`：核对取消信号 → `batchItems` 核对形状与条数 → 每个文件：`ctx.files.locate` → `ctx.files.reviewRead`，要问的经 `ctx.approval` 问 → 给了 version 就从 `FileHistory` 取，否则 `readBoundedFile`（20 MB 上限）→ 认出图片与 PDF 就拒 → `readWholeText`（整份解码，超出这次剩下的字符预算就单独失败）→ 某一项失败只标记它，全部失败才整个抛 |
| 看 `view` | `fileOperations.view`：没有交图通道直接拒 → 每张图：定位、审查、有界读 → 只认 PNG、JPEG、GIF、WebP → 读头拿宽高、收拢 region → 在上限以内又没要裁的原样交出；否则 `shrinkImageToLimits` 请 `ctx.files.resizeImage` 裁、缩（base64 还超就收长边重试）→ `ctx.attachImage` 交出图与一行说明，结果里只有尺寸 |
| 写 `edit` | `fileOperations.edit`：第一段每个文件定位（越界算被拒）→ 按真实路径判重 → `ctx.files.reviewWrite` 与确认（第一次被拒就停）→ `planOne`（排除目录、特殊文件、多硬链接、超大文件、坏上级；restore 从历史取；newText 按原编码编好、二进制拒改；核对 version）→ 有问题整批抛 `FILES_EDIT_UNRESOLVED` / `FILES_EDIT_DENIED` → 再 stat 一次，印记证明不了没变的重读核版本 → 第二段改动前的内容留成版本 → `ctx.files.commit`（每项带 expected）→ 出错时换成模型认得的路径点名已写的 |

## 依赖什么

- 上游包：`@velaros-ai/core`（类型守卫、`AppError`、日志）、`@velaros-ai/platform`（规整用户输入的路径、平台名）、`@velaros-ai/text-files`（编码识别、严格解码、按原编码编回、有界读、读开头）；`@velaros-ai/agent` 的 `tool-contract`（审批端口）与 `contracts`（确认选项类型），peer 依赖。
- 只在验收里用：`@velaros-ai/code-surface`（dev 依赖），跑端到端的程序、给代码模版做类型检查。
- 用到的 Node 内置模块：`fs/promises`（stat、读文件）、`crypto`（版本号）、`path`。只在根入口的引用链上；`./contracts` 不碰。
- 不读环境变量。

## 状态归谁

`fileOperations` 持有一份 `FileHistory`：改动前留下的版本，只在内存里，按真实路径分文件存，每个文件最近几份、单份不超过 `FileLimits.versionedBytes`、总量有上限，超了从最早的删起。随进程消失；持久化的历史是宿主的事。

## 生命周期

没有需要释放的东西；版本历史随进程存在。

## 失败语义

- 一批里的读、看：某一项失败只标记它（`{ path, error: { code, message } }`），全部失败才整个抛第一个失败。
- 写：整批要么全写要么一个不写。写不下去抛 `FILES_EDIT_UNRESOLVED`，被拒（用户没点头、越出空间范围、空间不许写）抛 `FILES_EDIT_DENIED`，message 逐条写明；落盘途中出错时 message 点名已经写进去的文件。
- 形状不对、条数不对、文件太大、不是文本、版本对不上：`VALIDATION`。找不到文件或版本：`NOT_FOUND`。没有权限、越出范围：`PERMISSION`。宿主做不了（没有交图通道、压不了图）：`PLATFORM`。
- 代码面只把 `code` 与 `message` 交给程序，所以模型要知道的都写在 message 里。

## 不变量

共 11 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 10 条、门禁 1 条。未验证 0 条。

## 非目标

- 不决定作用域与策略：路径相对谁、越界算不算、哪些要问人，全由空间注入的 `FileSpacePort` 说了算。
- 不决定落盘语义：逐个原子替换还是合成事务、能不能整批回滚，是空间的事。
- 不列目录、不搜文本、不读 PDF 与其他文档：列和搜用命令（`velar:shell`），文档另有能力。
- 不分页：正文落在程序的变量里，模型看不到它；模型自己在程序里切片、筛选。

## 结构

```text
src/
  contract/     对外合同：provides.ts 登记三个操作的 API，requires.ts 是空间端口与调用上下文，constants.ts 是错误码与公开上限
  types/        只放类型：files.ts 是可移植数据，text.ts 是读的结果与读和看的工作类型，space.ts 是空间端口上的数据，edit.ts 是写的工作类型
  impl/         一类一文件：FileOperations（velar:files）、FileHistory（改动前留下的版本）
  utils/        batch.ts（一批的核对与失败）、text-file.ts（有界读、解码、版本、印记、媒体类型）、image.ts（图片头、区域、压进上限）、
                paths.ts（判重的身份键）、fs.ts（系统错误码）、tuning.ts（可调参数）；全是函数与常量，每个函数上方一句说明
  index.ts      `.` 入口，只转发
  contracts.ts  `./contracts` 入口，只转发
templates/      files.js：代码模版，嵌进生成声明的模块头
spec/           不变量登记、验收测试、共用的真磁盘空间端口
test/           实现细节测试
```

**分层。** 上层是 `FileOperations.ts`（代码面的三个操作），下层是 `FileHistory.ts`（版本历史）；上层持有下层。

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出；公开的在 `contract/provides.ts` 登记。整个进程只需要一份的，文件末尾给出那一份，按公开接口标注类型。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `FileOperations.ts` | `FileOperationsApi`（同文件，provides 登记） | 代码面 `files` 命名空间的三个操作 |
| `FileHistory.ts` | `FileHistoryApi`（同文件，包内） | 改动前留下的版本：留、取、按预算淘汰 |
