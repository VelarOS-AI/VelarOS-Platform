# Project 工具协议重构执行记录

日期：2026-09-13。目标与完整操作处置见 [协议方案](./project-tool-surface-redesign-proposal.md)。

## 当前执行范围

- 读取、搜索、当前视图和编辑回执共用结构化源码窗口；可编辑引用在最终模型预算处理后绑定实际可见内容。
- 文件动作、局部编辑、混合事务分别提供 file/edit/change，共用 Project 事务提交与恢复底座；file 另提供 recode 批量转换磁盘编码，正文不变、可整组撤销。
- 含源码窗口的工具结果超过内核页出阈值时按整行分页收进预算，不再头尾裁剪成不完整 JSON；当前文件视图中显式读取的文件先于搜索顺带观察的窗口，预算不足时先省略后者。
- 默认六个工具；code/change 按需加载，高级代码图分析保留独立能力发现。
- 精确匹配失败提供一次性候选，模型确认定位后差量复用正文。
- 保留版本 1 模型合同与 SDK 的显式兼容入口。

## 验收范围

- 新合同的全部操作、选择组合、失败恢复；原 53 项操作有机械核验的处置映射。
- 行、字符、Unicode、CRLF、EOF、长行分页及最终截断边界。
- 同批固定坐标、大批量变更、跨文件回滚和外部并发冲突。
- 当前视图、历史召回、分支隔离与候选详情生命周期。
- Project、Agent、Agent Lab、UI 的类型、lint、架构、测试和构建。
- Workbench/Desktop 候选包与工具发现、呈现、历史兼容。
- 大项目 worktree 的真实执行栈回归与外部模型自然任务实验。
- 同口径 schema token、错误恢复和最终任务正确性。未取得可靠账单 token 统计。

## 基线

本轮开始时主 checkout 分支均为 main，与已有 upstream 引用无差异；保留前序上下文维护和参数复用的未提交实现。旧八工具完整 schema 与说明合计 20,949 个 JSON 字符，基线文件保存于本次独占临时目录，后续报告使用同一口径比较。该字符数不等同于 token。

## 实现结构

| Project src 目录 | 职责 |
| --- | --- |
| agent/contracts | 模型合同、range 简写、输入组合 |
| agent/tools | 能力授权、调用编排、统一回执 |
| agent/presentation | 结构化源码行与长行片段 |
| editing/selectors | 可见覆盖、行与字符坐标、精确选择、候选生成 |
| editing/planner | 固定输入坐标、重叠检测、编译内容补丁 |
| editing/recovery | 版本变化后的有界定位建议 |
| file-operations | 创建、整文件覆盖、移动、删除的计划构造 |
| context | 路径、版本和实际可见范围绑定的 fileRef |
| compatibility | 旧模型合同和已证实未落盘的历史输入迁移 |
| transactions | 准备、校验、锁内内容检查、提交、持久恢复、撤销 |

`Project.tool.ts` 负责组合；选择算法、文件动作和事务各有边界。旧 SDK 能力通过显式兼容层保持既有含义。

## 调用与恢复的生命周期

1. 读取结果使用 `[行号, 原始行文本]`，长行片段另带列范围。行号和显示标签不进入源码文本。模型最终请求完成预算裁剪后，才根据实际呈现内容签发可编辑 `fileRef`。
2. 编辑用 `range` 限定区域，`match` 在区域内精确选择文本。`range` 接受数字、单元素数组、首尾行数组。没有 `range` 时也只搜索引用的可见部分。
3. 同文件批量编辑全部按输入版本的固定坐标解析，再统一检查重叠并编译补丁。创建、移动和编辑组合成 `change` 时，按步骤维护内存中的未来文件视图。
4. 提交检查版本与原始内容，全量验证通过后按事务提交；单文件采用原子替换，失败时依据恢复计划恢复。回执包含变更引用、准确的净变更状态、有界差异和新源码窗口；旧引用保持旧版本语义，当前视图升级。
5. 可验证且预算内的定位问题返回当前版本绑定的候选；过期目标无法安全定位时要求重读。对于已保存且确认未落盘的失败，模型可补范围、精确原文或新的 `fileRef`，用 `reuse + changes` 复用未改变的正文。
6. 完整候选只投影到紧接着的模型决策。下一次 assistant/user 决策边界之后，Provider 历史只保留短归档回执。同一决策重复发送时结果稳定，原始历史与审计记录完整保留。
7. 主动召回历史文件、失败回执或原始参数，按普通资料和召回预算处理。历史引用保持历史语义，不能隐式变成当前写权限。

写入前的候选语法校验失败明确返回 `not-applied`，模型可用 `reuse + changes` 修正范围或正文。错误附近的有界窗口属于尚未写入的候选内容，行号只用于诊断；编辑 `range` 仍使用输入 `fileRef` 对应的原文坐标。候选窗口不取得 `fileRef`，不替换当前文件视图，并随恢复详情在下一次决策后归档。写入后无法确定结果的异常保持 `unknown`，不会仅凭校验错误名称开放复用。

模型正文统一为一次 JSON 解码后的 Unicode 字面源码，跨行使用 LF，反斜杠保持原义。新建文件默认 UTF-8、无 BOM、LF；现有文件的编码、BOM 和换行由底层维护。历史文件召回在模型呈现边界使用相同的 Unicode/LF 格式，完整档案保留原文。召回分页的 `nextOffset` 指向归档原始 UTF-16 坐标，模型原样续传即可。

无 BOM 的 UTF-16 编辑后若无法可靠识别，底层自动补同字节序 BOM；撤销恢复原始无 BOM 字节。字节计划在有界差异计算内复用可定位的原始片段，极端差异可能重编码中部，但 Unicode 正文保持一致；撤销独立使用完整原字节。SDK 的 `maxBytes` 按逻辑 UTF-8 字节计算，CRLF 计一个换行。读取续传保留内部原文坐标，模型原样使用返回的续读引用。

提示词、schema 描述、注册示例和文档纳入[模型指导同步检查](project-model-guidance-audit.md)。发布测试同时验证当前示例可解析、实际内置段组装覆盖，以及协议或说明变化已完成显式审核。

失败路径覆盖实际 `TurnHistory` 的 `error-text`、兼容 `error-json` 载体及 `ContextRef.excerpt` 包装。一次性投影只识别 Project 失败载体，不扫描任意源码 JSON。候选引用只授权实际可见的窄窗口；无法解析的截断摘录不能取得写权限，合法 fragments 按实际显示字符授权。

历史参数省略采用独立元数据：源码字段从历史视图中缺省，`__historyInputOmissions` 记录 path/jsonPath、chars 或 items、ref，`__historyInputRef` 指向原参数；压缩标注不再占据源码字段。原始参数完整归档，差量重试仍在原始输入上执行。带省略信封的历史视图不能作为可执行输入。

## 实验发现与修复

| 问题 | 处理 |
| --- | --- |
| 复杂 Zod schema 在参数恢复入口调用 partial 失败 | 宽松复用信封恢复完整参数，再执行原合同校验；保留权限、作用域及未落盘证明 |
| 旧候选藏在引用摘录中继续占据历史，或新候选没有可用引用 | 修复失败载体、包装摘录和最终引用签发组合路径 |
| 模型抄入历史压缩生成的伪正文 | 原防护在写前阻断；改用独立省略元数据，消除这次可避免失败的来源 |
| Workbench 工具发现 schema 形状不符合 Agent 约定 | 返回完整 profileId/description/schema 信封 |
| 依赖查询方向限制藏在运行时校验中，模型看不到 | incoming/outgoing 各自公开严格字段分支，显式表达目标选择要求；错误字段不静默丢弃 |
| 模型不知道实际命令 shell | 每次运行提供与执行器一致的 shell/platform |
| CLI 实验暴露 renderer 工具并超时 | 宿主报告 renderer 是否附着，按实际可用性发现工具 |
| 进度计划误触发 Plan 确认 | plan:update 只维护进度；显式 Plan 模式保留原约束 |
| 浏览器入口经工具合同引入 Node crypto | 使用浏览器可用路径，并扩大 browser surface 门禁 |
| Desktop 增量保存回收私有引用关联记录 | 持久层保留 fileRef、分页、回执及原始参数关联记录 |
| /var 与 /private/var 路径别名误报越界 | 使用规范路径，保留符号链接逃逸检查 |
| Workbench 主入口超构建预算 | 安装器在确有可安装版本时加载，覆盖并发、重试和释放 |
| glob 编译缓存长期无界增长 | 自然模型产出有界 LRU 与模块拆分，独立审查后合入，补充异常及压力测试 |

## 压力与真实任务

- 单个 50,000 行文件一次编译 1,000 项修改，固定坐标形成一个文件补丁。
- 20,000 行持久事务检查计划元数据及序列化体积，跨重启提交和撤销。
- Workbench 真实执行栈在大型独占 worktree 完成 120 次受控调用，覆盖 8 个核心工具、6 种代码查询及文件/编辑/变更动作。50 个真实源码文件批量修改后撤销，字节和权限与起点一致，受控 worktree 最终干净。
- Workbench/Desktop 候选 worktree 安装实际打包的 Agent 0.6.28、Project 2.1.0、UI 0.2.53，验证工具发现、注册、恢复、当前视图和历史读取。
- 共享源码窗口组件通过 Electron 截图与复制行为检查：独立行号、原文复制、Unicode、片段标注及宽度。此项是共享组件视觉验收。

真实模型采用 Workbench 已配置的 `velar-dev/gpt-5.6-sol`，使用实际宿主执行栈与独立上下文存储。任务描述目标，不指定工具名。

| 自然任务 | 请求 / 工具调用 | 实际结果 |
| --- | --- | --- |
| glob 缓存修复 | 22 / 52 | 产出修复与测试；暴露发现信封、headless UI 可用性及一次无效引用问题 |
| 缓存模块拆分初跑 | 4 / 14 | 任务未完成：进度计划误触发 Plan 确认，不能以循环 completed 状态认定通过 |
| 修复后模块拆分复跑 | 18 / 42 | 完成拆分、验证、撤销和重新应用；一次伪正文被写前拦截，召回原参数后完成 |
| 语义影响审查与草稿撤销 | 14 / 40 | 自行发现 code/change，6 种语义查询齐全；草稿 apply→inspect→undo→inspect，原 WIP 完整保留；2 次依赖方向选项不适用，修正后完成 |
| 方向合同修复后的依赖复查 | 4 / 5 | 最终 Agent/Project 候选包；3 次 dependencies 查询全部首次成功，无参数错误；扫描 2,008 个文件找到两个直接使用者，前后 patch/status 相同 |

最后一项经独立核对：同一 changeRef 只修改草稿；前后 patch 与 status 逐字相等，草稿不存在。三个目标文件诊断均为 0；包级诊断为 26 error + 84 info，模型正确保留了这个区别。关系后端不可用、名称引用候选也被明确说明。

自然任务产出的 matcher-cache.ts、glob.ts 及测试经独立审查合入 Platform 主目录。实验 worktree 保留原产出。自然任务合计使用全部 8 个核心工具；具体操作和边界覆盖由受控实验补齐。

## 工具描述体积

比较 Project 工具 `{name,description,inputSchema}` JSON，同用 gpt-tokenizer 3.4.0：

| 集合 | 字符 | Token |
| --- | ---: | ---: |
| 原默认 8 个 | 20,949 | 6,666 |
| 新版全部 8 个 | 22,804 | 7,424 |
| 新版默认 6 个 | 10,479 | 3,731 |

默认工具描述减少约 44% token。全部加载时比原八工具多约 11%，统计包含引用、失败恢复、编码与依赖方向的显式说明。这是 schema 体积比较，不能等同整个 Provider 请求或真实账单的下降比例。

## 证据与交付边界

主要证据目录：`/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/velaros-project-surface-acceptance-098wziar`，包含 schema 对照、原始模型请求和工具结果、候选包、测试日志、组件截图。受控报告：`/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/project-surface-acceptance-3J2k1K/report.json`。临时证据位于本机，长期结论以本记录及仓库测试为准。

宿主候选 worktree 使用独占临时 tgz；正式主目录 manifest/lock 的依赖切换需与包发布衔接，不能合入机器临时路径。本轮没有发布包或替换用户已安装应用。

后续复跑入口位于 Workbench：`scripts/test/verifyProjectTools.ts` 接受一个干净的独占大型 worktree 路径和可选报告路径；`scripts/test/projectSurfaceNaturalAcceptance.ts` 接受 `--worktree`、`--task-file`、`--output-parent`，并可用 `--max-model-requests`、`--timeout-ms` 设置实验边界。前者执行确定性的工具矩阵，后者按原样发送任务并保存真实模型请求及执行结果。自然任务是否完成应检查实际产物、回执和工作区，不能只判断循环状态。

事务检查保护参与本系统锁和版本协议的写入；不受控外部进程仍可能在预检与替换之间写入，普通文件系统不提供跨任意进程的绝对 CAS。测试结果代表已覆盖场景，不能宣称无缺陷。

## 检查汇总

| 范围 | 结果 |
| --- | --- |
| Project | 完整 check 通过：489 tests、5,821 assertions、43 files，含类型、lint、架构、合同和构建 |
| Agent | 804 tests、2,403 assertions、115 files；构建、浏览器入口、架构、公共 API、lint 通过 |
| UI | 313 tests；类型、构建与所改文件 lint 通过 |
| Agent Lab | 44 tests；类型、构建与架构通过 |
| Workbench | 654 应用测试 + 15 发布流程测试；类型、产品边界、所改文件 lint 通过；最终包再跑 16 项相关测试通过，最终 build 全预算通过 |
| Desktop | 最终候选 30 tests / 9 files，含 renderer 历史参数引用持久化；21 个受影响类型分区全部通过，最终增量构建全预算通过；前轮另完成 48 项针对测试 |

最终 Agent 候选来自证据目录 `verified/velaros-ai-agent-0.6.28.tgz`，Project 来自 `release-candidate/velaros-ai-project-2.1.0.tgz`。Workbench 最终体积：mainEntry 3.67/3.75 MB，mainJavaScript 6.46/6.50 MB，rendererStartup 4.54/4.75 MB，其余预算均通过。

Desktop 最终体积：mainEntry 14.70/15.50 MB，mainJavaScript 17.46/18.50 MB，rendererStartup 4.20/4.75 MB，rendererJavaScript 21.64/24 MB，其余预算均通过。最终日志为 `/tmp/velaros-desktop-verified-{install,tests,typecheck,build}-20260913.log`。Desktop 验收覆盖真实 kernel/registry/storage/reuse 链与 renderer 持久化；自然模型会话实验在 Workbench 执行栈完成。
