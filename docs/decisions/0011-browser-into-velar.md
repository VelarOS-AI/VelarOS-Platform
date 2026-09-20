# 0011: 浏览器整包并进 velaros：32 个工具换成 velaros:browser 与 velaros:devtools

- Status: accepted
- Date: 2026-09-18
- Owners: `@velaros-ai/velaros`（browser 单元）

## Context

`@velaros-ai/browser` 是最后一个带工具的包：32 个 `browser:*` 工具，背后是 CDP 驱动、交互 / 页面数据 / 截图 / 性能引擎、
Electron 会话运行时、站点工作区、登录墙、用户脚本、recipe。按「有工具的包整包进 velaros，原包删掉」的规则，它要并进
`packages/velaros/browser`，工具换成代码面的操作。

工具时代给它配了一整套装配机器，代码面之后都没有了用处：

| 工具时代的东西 | 为什么在 | 代码面之后 |
| --- | --- | --- |
| 七个职责类别、常驻集、`isAvailable` 隐身 | 每轮只能带一部分工具的 schema，按类换入 | 模块按需 import，声明第一次 import 时才读 |
| 随包 mod 清单（浏览器空间、客居空间、`BrowserModId`、`BrowserSpaceId`） | 工具要登记进 mod，mod 声明空间 | 空间由产品按装配表挂模块，能力不认识空间 |
| guided 入参面、`action` 分派的大入参 | 少一个工具就少一份 schema | 一个动作一个函数 |
| `check:capabilities-schemas` 的浏览器基线 | 工具 schema 改了要重绑 | 声明从源码生成，验收核对 |

另有几件功能与代码面本身重复：

- **recipe**（生成骨架、读、干跑、跑、按运行记录重跑）：沉淀可复跑的自动化。代码面的脚本时间线（f36f8abc）正是这件事——
  程序存进脚本库、按版本取、带参数重放，比 recipe 的步骤表更灵活。
- **`read_page_data` 的预设**：`evaluate` 一行就能写出来；预设存在的理由是「不向模型开放 JavaScript」，ADR 0009 之后不成立。
- **`list_page_resources`**：链接在 `inspect` 里，媒体有 `media`，iframe 一句 `evaluate`。
- **`observe_actions`**：候选就是 `inspect` 结果里的 `actions` 与 `formFields` 过滤排序，程序自己筛。
- **`browser:files` 与站点产物**（读写工作区文件、标准产物目录、清单 manifest、页面快照）：站点工作区里的文件该走 `velaros:files`，
  一件能力一份实现；产物清单只为模型列产物而存在。

## Decision

### 一个单元，两件能力

`packages/velaros/browser` 整包收下实现（CDP、引擎、Electron 运行时、站点工作区、登录墙、用户脚本、动作策略、页面脚本、
随包的 DevTools 性能引擎），对模型出两件能力，与 `project/` 出 `velaros:project` 和 `velaros:code` 同一个写法：

- **`velaros:browser`**：驱动与读页面——进站与标签页、看页面、按元素或坐标动手、等、挂起事件、取内容、下载与导出。
- **`velaros:devtools`**：页面内部与定制——控制台与网络诊断、请求详情、存储、视口与缩放、网络条件与环境仿真、性能 trace 与堆快照、
  录屏、用户脚本。排障、调页面时才 import，驱动页面的声明因此保持小。

两件共用一个空间端口 `BrowserSpacePort`（原 `ToolBrowserApi`，已经绑好会话与站点）与调用上下文
`BrowserOperationContext`（取消信号、端口、交图通道）。

### 操作

`velaros:browser`：

| 类 | 操作 |
| --- | --- |
| 站点与标签页 | `open`、`leave`、`state`、`show`、`tabs`、`switchTab` |
| 看 | `inspect`、`query`、`screenshot`（图经交图通道交给模型，返回值里只有几何、坐标换算与标注说明）、`evaluate`、`media` |
| 按元素动手 | `click`、`fill`、`select`、`check`、`hover`、`focus`、`clear`、`selectText`、`scrollIntoView` |
| 导航与输入 | `goto`、`back`、`forward`、`reload`、`scroll`、`type`、`press`、`mouseMove`、`clickAt`、`drag`、`upload` |
| 等 | `waitForSelector`、`waitForText`、`waitForUrl`、`waitForFunction`、`waitForLoad`、`wait` |
| 挂起事件 | `events`、`waitForEvent`、`handleDialog`、`handleDownload`、`handlePermission` |
| 取内容 | `table`、`list`、`paginate`、`content`、`download`、`savePdf` |

`velaros:devtools`：

| 类 | 操作 |
| --- | --- |
| 诊断与网络 | `diagnostics`、`request`、`storage` |
| 页面条件 | `setViewport`、`zoom`、`network`、`emulate` |
| 性能与录屏 | `startTrace`、`stopTrace`、`insight`、`heapSnapshot`、`startRecording`、`stopRecording` |
| 用户脚本 | `userScripts`、`readUserScript`、`createUserScript`、`updateUserScript`、`enableUserScript`、`enableUserScripts`、`moveUserScript`、`deleteUserScript`、`runUserScript` |

元素目标统一写法：字符串以 `@e` 开头是 `inspect`、标注截图给的 ref，其余字符串当 CSS selector；也可以把结果里的 `target` 原样传回。

不设折叠（代码面的规矩）：不给上限时一律取到只为守住内存的那个上限，要多少由程序自己切；声明里的数就是常量表里的数，验收核对。

### 删掉的

- 32 个工具、七个类别、常驻集、guided 面、随包 mod 清单与 `BrowserModId`、`BrowserSpaceId`、`BrowserResidentToolNames`，
  `check:capabilities-schemas` 里的浏览器基线与 schema bundle 脚本。浏览器空间由产品按装配表挂 `velaros:browser`、`velaros:devtools`
  与站点工作区上的 `velaros:files`。
- recipe 全套（骨架生成、干跑、执行、运行记录、`browserRecipes`、`types/recipes.ts`），由脚本库接替。
- `read_page_data` 预设、`list_page_resources`、`observe_actions`、页面快照。
- `browser:files` 与站点产物管理（`createBrowserWorkspaceArtifacts`、清单 manifest、产物目录表）。站点工作区的文件访问
  （`createBrowserWorkspaceFileAccess`、`createBrowserSiteWorkspaceFileAccess`，写只写当前根、读可回退到历史根）留着，宿主拿它给浏览器空间做 `velaros:files` 的端口。
- 端口上只剩操作真会调的方法；宿主每回合的上下文快照 `getTurnContextSnapshot` 只有产品用，改由产品直接向运行时要。

### 留着的

宿主那一侧的整套东西照旧：Electron 运行时与内核模块（`./browser/electron`）、地址栏 / 偏好 / 截图策略 / React 合成（`./browser/renderer`）、
页面驱动与外部浏览器启动器的扩展点、登录墙门控（`createBrowserLoginGate(port).wrap(api)`，每个站点每会话最多问一次）、
用户脚本存储、动作策略。

未进站点时调用任何要页面的操作，抛 `BROWSER_SITE_NOT_OPEN`，message 让模型先 `open`，端口一次都不调。

## Alternatives

- **一个模块装下全部 60 个操作**：驱动页面最常用的那几个就得背着网络、性能、用户脚本的整份声明。否决。
- **保留 recipe，只把工具改成函数**：同一件事两套机制，步骤表还比程序弱。否决。
- **`act({ action, target })` 保持分派写法**：代码里写 `click({ target })` 是模型最熟的样子，分派只为省 schema 而存在。否决。
