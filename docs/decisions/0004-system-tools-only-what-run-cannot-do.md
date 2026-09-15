# 0004: 系统空间只保留 `system:run` 替代不了的工具

- Status: accepted
- Date: 2026-09-15
- Owners: `@velaros-ai/system` 工具面

## Context

系统空间原有十个模型面工具。其中列目录、搜文本、看进程和端口、终止进程四个，做的事情用 `system:run` 跑一条系统命令就能完成；它们只是把 `ls`、`grep`、`ps`、`kill` 包了一层结构化的壳。模型面每多一个工具，就多一份提示词、一份 schema、一份审批语义要人负责，模型也多一次「该用哪个」的选择。

## Decision

判据只有一条：`system:run` 能替代的，不单独开工具。按这条判据：

| 工具 | 去留 | 理由 |
| --- | --- | --- |
| `system:run` | 留 | 底座 |
| `system:read` | 留，改成通用型 | 和 `edit` 配对：按字符取一段并返回它的 range 供精确匹配，识别 UTF-16 与 BOM；一次一批文件；`run` 的输出窗口保留末尾，读文件要的是开头 |
| `system:view` | 新增 | 图片整张、PDF 按页（一次几页）作为模型可见的内容块交给模型，效果和用户上传一样，一次一批文件；文本工具不该背图片的规则，二进制单独一个工具 |
| `system:edit` | 留，改成通用型 | 任意内容和精确替换文本走结构化参数，不经过 shell 引号；三种 Windows shell 引号规则各不相同，heredoc 也会被内容撞坏。写敏感路径前过用户确认，`run` 的危险判定管不到 |
| `system:write` | 删 | 整个文件的写入并进 `system:edit`：只给 newText 就是整个写入 |
| `system:list-tasks` | 留 | 后台任务表只在本包，命令看不到 |
| `system:refresh-environment` | 留 | 改的是宿主进程的环境变量，子进程做不到 |
| `system:list` | 删 | `ls` / `find` / `dir` / `Get-ChildItem` |
| `system:search` | 删 | `grep` / `rg` / `findstr` / `Select-String` |
| `system:processes` | 删 | `ps` / `lsof` / `netstat` / `tasklist`；它的后台任务部分本来就是 `system:list-tasks` |
| `system:terminate-task` | 删 | `system:run` 的后台结果和 `system:list-tasks` 的条目里已经给出 `terminateCommand`，`run` 直接执行它；`kill <pid>` 不在危险名单里，不会多弹确认 |

工具类别从三个收成两个：文件（读、看、写）、执行（跑、刷新环境、后台任务）。常驻工具从六个收成四个：读、看、写、跑。

工具描述里不提别的空间：系统空间和项目空间互不知道对方，什么时候用哪个是宿主的责任和提示词约束。宿主发现用户在系统空间里做项目就提示切换；项目空间要用系统能力就派系统空间的子 agent。数据契约里的「命令来自哪个空间」和「缺失工具的安装建议」两块随之删除，那是宿主自己的概念。

宿主端口跟着收：`globalSearch`、`listProcesses`、`listOpenPorts`、`terminateBackgroundTask` 不再有工具调用，从注入面 `SystemToolSystemApi` 移到产品面 `LocalSystemKernelApi`，留给宿主自己的界面（文件搜索框、进程面板、停止按钮）用。门禁从此核对端口里的每个方法都有工具在调，没人调的不许留。

### 读和写的形状

系统空间的文件不是项目工作区，没有行的数据，位置一律按字符算：

- `system:read { files: [{ path, offset?, maxChars?, version? }] }`：只读文本，files 每项一个文件，一个文件就一项、一批最多 20 项，各自带各自的选项；每个文件返回 `content` 和它的 `range { offset, end }`，`maxChars` 默认就是上限 20 万，尽量一次读完，`hasMore` 时把 `range.end` 当下一次的 `offset`；一次调用总共最多 20 万字符，按顺序分给各文件，分完的文件只带位置不带内容。结果的 `files` 一一对应，某个文件读不了只把它那一项换成 `{ path, error: { code, message } }`，全部失败才整个报错。工具入参在协议上必须是一个对象，列表只能挂在一个键下，单个和一批用同一种形状，不另设顶层字段。
- `system:view { files: [{ path, pages? }] }`：files 每项一个文件，一个文件就一项、一批最多 10 项。图片（PNG、JPEG、GIF、WebP）整张作为模型可见的内容块交给模型，没有字符上限，只有 5 MB 的字节上限；PDF 用各自的 `pages` 指定看哪几页（从 1 起，默认第 1 页，一次最多 20 页），用 pdf-lib 把这几页抽成一份文档交给模型，结果里给出实际的 `pages` 和 `pageCount`。内容块放在结果的 `modelContent` 里按 files 的顺序排，每块前面一行文字说明是哪个文件；某个文件看不了同样只标记它那一项。
- `system:edit { files: [{ path, newText?, edits?, restore? }] }`：files 每项一个文件，一个文件就一项、一批最多 20 项，每项三种改法只用一种：只给 `newText` 整个写入（不存在就新建）；给 `edits` 在文件里改几处（一次最多 50 处），每处 `{ range, oldText?, newText }` 在自己的 `range` 里改，给 `oldText` 就只换这段里唯一的那一处，不给就把整段换成 `newText`，空段就是插入；同一个文件的几处一起改，全成或全不成，各处不能重叠，任何一处的 `oldText` 多处匹配就整个文件不动，返回是第几处和每处的锚点；只给 `restore` 回滚到那个版本。改了几处的结果返回盖住所有改动那段的新内容和新位置，超过 20 万字符截到上限。结果的 `files` 一一对应，某个文件失败只标记它那一项。

**版本、召回、回滚。** 都按文件走，一批就各自带各自的 `version` 或 `restore`。每次 read 和 edit 的结果都带内容的版本号（字节哈希前 12 位）；edit 改动前把原内容留成一个版本，结果里给出 `previousVersion`。旧状态可以召回：`read { path, version }` 读回那份内容；可以回滚：`edit { path, restore: version }` 一步写回，回滚前的内容也留成版本，回滚本身能再回滚。历史只在内存里，每个文件留最近 10 份，单份不超过 2 MB，总量不超过 64 MB。

「二选一」不再出现在参数面上：可选字段不给就是默认做法。

### 改完自动载入、旧的读结果失效

已做：`edit` 的结果就是改动那一段的新内容，等于自动重读；结果里的版本号让上下文层能分辨哪份内容是最新的。

未做，需要 agent 包配合：让上下文台账把同一文件的旧 `read` 结果标成失效；`read` 和 `view` 改成 `files` 一批后，台账按顶层 `path` 取去重目标的办法不再适用，要改成从 `files[].path` 取，一批对应多个目标。台账现有的去重键是「工具名::目标」，同键的新记录准入时旧记录被标 pending-EVICT，但 `system:read` 与 `system:edit` 工具名不同，撞不上同一个键。建议的最小改法：`resolveDedupeKey` 允许注入方给出带命名空间的完整键（例如 `file::<绝对路径>`），读和写的结果按同一规则出键，版本号不同的旧记录被新记录顶掉，被顶掉的记录仍可经 `context:recall` 召回；然后由系统能力提供一个 `ContextRecordClassifier`，让运行时接线。这一步动的是 agent 包的上下文核心，等拍板再做。

### 描述的形状

工具描述只留摘要和适用场景两节必填，禁止、强制流程、用法、示例、注意按需写，没参数的工具不用硬凑用法和示例；参数描述直接写一句话，不套结构化模板。这要放宽 agent 包工具契约的类型和描述语法：`ToolContractDescriptionSpec` 的这四节改成可选，渲染时只渲染写了的分节，解析时只把「适合」当必需分节。这是 agent 公开 API 的向后兼容修改（写的一方不受影响，读这四个字段的一方要处理缺席），agent 升到 0.6.30，公开 API 基线按 additive 重绑。

### 新增依赖

`pdf-lib`（MIT）用来抽 PDF 的单页，工作区里 office 包已经在用同一版本，没有新装包。

## Alternatives

- 保留搜索和列目录，理由是它们跳过 node_modules 和 macOS 受保护目录、遵守 gitignore：`rg` 默认遵守 gitignore，环境检查会报告 `rg` 在不在；受保护目录由系统权限兜底。收益不够抵一份工具的成本。
- 保留终止任务，理由是它核对会话归属和 pid 复用：模型经 `run` 本来就能 `kill` 任何进程，这层核对不是安全边界。

## Security and privacy

删掉的四个工具都是只读或已有更宽的等价路径，没有放宽任何权限。写敏感路径的用户确认仍在 `write`、`edit` 里；危险命令的确认仍在 `run` 的执行前分类里。

## Compatibility and migration

破坏性改动，与 0003 一起随下一版 Platform 发出。产品壳迁移：

| 收口前 | 收口后 |
| --- | --- |
| 工具目录、空间策略、上下文投影里的 `system:list`、`system:search`、`system:processes`、`system:terminate-task`、`system:write`、`system-processes` 类别 | 删除；旧会话里这些工具的卡片渲染建议保留 |
| `system:read` 的 `startLine`、`endLine` 与行号结果；`system:write` | 改成 `offset`、`maxChars` 与 `range`；写文件改调 `system:edit`；图片和 PDF 改调 `system:view` |
| agent-lab 里针对这四个工具的评测任务 | 改成经 `system:run` 跑对应命令 |
| 宿主端口实现里的 `globalSearch`、`listProcesses`、`listOpenPorts`、`terminateBackgroundTask` | 从端口实现里去掉；宿主界面继续用自己的服务，或迁到本地内核后用它的接口 |

## Validation

验收测试的三张表（副作用种类、职责类别、内核模块注册的工具）与常驻集改成六个工具、两个类别；包测试、跨包一致性测试、schema 冻结门、结构门全部通过；门禁新增「端口方法必须有工具在调」并实测能拦。

## Consequences

系统空间的模型面只剩六个工具，模型选工具的空间变小，跨平台的命令语法由 `run` 的提示词和环境报告承担。以后再加工具，先回答「`run` 为什么做不到」。
