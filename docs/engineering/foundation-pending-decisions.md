# 等你拍板的项（地基重构）

这一页把各包方案里「需要你定」的项汇总到一处，按包分组。每条写清：**要定什么、我的建议、定了之后谁要改**。
详细论证在 `refactor-plans/<包>.md` 的第 7 节（或对应小节），流水账在 `foundation-refactor-log.md`。

**共同背景**：所有包的「入口收口」都是破坏性变更（删入口、删零消费的导出），各自附逐符号迁移表；按发版手册，它们应当同一班车发出，产品只迁一次。在你定之前，各包的改造只做包内那几步（不改入口名、不删对外导出），产品零改动。

## 一、agent

| # | 事项 | 我的建议 | 影响 |
| --- | --- | --- | --- |
| A1 | 对外入口 23 → 4（`.`、`./contracts`、`./chat`、`./tool-contract`），删 1,659 个零消费导出，升 **1.0.0** | 做。现在 2,951 个导出里真被用的只有 604 个 | Desktop 416 / Workbench 51 / Termel 17 / Extension 3 个文件跟着迁一次 |
| A2 | 工具契约（`./tool-contract` 与工具相关协议类型）**独立成包** `@velaros-ai/tool-contract` | 倾向拆。六个空间包现在只为「写工具」就把整个 agent 运行时列为依赖 | 六个空间包的依赖与 import；拆了之后工具定义辅助、内核模块样板、失败回执构造器三件公共件才好落 |
| A3 | 工具面删改：删 `context:distill`、合并 `goal:get`/`plan:get`、删 `tooling:map` 的 `op=read`、`job:cancel` 与 `interrupt` 二选一、`directive:list` 去留、`context:handoff` 接线 | 逐条定；判据是「别的工具替代得了、只剩仪式感才删」 | 模型面；提示词审核指纹重算 |
| A4 | 空间知识搬家（源码视图整条链、验证账本搬进 project）放到结构改造之后单独一轮 | 做，但单独一轮 | 会改发请求的字节，影响重放基线与前缀缓存，要 agent 与 project 同车发版 |
| A5 | 提示词修正（工具面评审第 3 节：冲突、冗余、失实、中英混用、约 44 处英文） | 照做 | 模型面；指纹重算 |

## 二、browser

| # | 事项 | 我的建议 | 影响 |
| --- | --- | --- | --- |
| B1 | 工具面 40 → 32：删 `export_page`（PDF 挪进 `files action=save_pdf`）、`get_element_bounds`、`space_manifest`；诊断四合一；`capture_region` 并入 `capture_screenshot`；`site_context` 并入 `get_page_state` | 做。常驻 6 个工具每轮约 1.7 万字符，`browser:act` 一个就 1.1 万 | 模型面；schema 基线重绑 |
| B2 | `CdpBrowserRuntime`（432 行，零消费、无测试、`enter_site` 在它上面必失败） | 删；真要支持无 Electron 宿主时按需重写 | 无（零消费） |
| B3 | `browser:enter_site` 放进常驻集 | 放。不放的话未进站点时六个常驻工具全隐身，模型得先换入 | 每轮多约 500 字符 |
| B4 | 提示词改写（方案 4.4 节 P1–P17，其中 6 处与实现相反） | 照做 | 模型面 |
| B5 | 「浏览器工具客居 project 空间」从 mod 清单里拿掉，改由宿主传 | 改由宿主传 | `createBrowserBundledModDefinition` 签名；Desktop 空间配方 |
| B6 | `ElectronBrowserRuntime` 加 `bindToolApi(...)`，产品面从 56 个成员收到约 20 个 | 做。两个宿主现在各写 800–1,200 行适配层，Desktop 还另存一份 431 行镜像 | Desktop、Workbench 的适配层大幅缩减 |
| B7 | 用户脚本的高风险操作（启用、切 main world、扩大 match）走审批端口，而不是只靠提示词 | 走审批端口 | `BrowserToolContext` 加 `approval` |
| B8 | 页面内容边界 `contentBoundary`（只有一个工具带、没人读） | 删；提示注入防护应在 agent 的上下文层统一做 | 模型面少一个字段 |
| B9 | 性能引擎 2.5 MB 懒加载：门禁禁止动态 `import()` | 门禁加登记字段只放行登记过的目标（改标准） | `module-ownership.md` 与 ADR |
| B10 | 入口 4 个还是 5 个（React 是否单开 `./react`）、宿主端口改名、版本 0.3.0 | 4 个 | Desktop、Workbench |

## 三、memory

| # | 事项 | 我的建议 | 影响 |
| --- | --- | --- | --- |
| M1 | **知识库拆成独立包 `@velaros-ai/knowledge`** | 拆。宪章本来就说记忆与知识永不合并，两边零共享代码 | 导出名不变，只换包名；Desktop 的 import |
| M2 | 入口 8 → 2（knowledge 另 2 个），导出 517 → 约 120，升 0.5.0 | 做 | Desktop 71 个符号按迁移表改 |
| M3 | 树 v2（25 个文件 10,414 行，全仓零消费）不出包 | 不出包，接线时按宿主真要的面再开 | 根入口 268 个名字里 191 个属于它 |
| M4 | 工具面删改：删 `archive` 的 `reason`、删 `save`/`search` 的 `workspaceRoot`、删 `search.mode`、`kind` 旧别名不进 schema、`save` 按「作用域+类别+标题+正文」算稳定去重键 | 照做 | 模型面 |
| M5 | `memory:save` 的 `privacyClass`（只落库、没有行为读它） | 先从模型面拿掉，披露闸门接线时再开 | 模型面 |
| M6 | 宿主要按作用域给可写根（否则一次运行之外采集的项目证据会被拒收） | 做，属产品层接线 | Desktop |

## 四、kernel

| # | 事项 | 我的建议 | 影响 |
| --- | --- | --- | --- |
| K1 | 入口 12 → 5、类不出包（`new Kernel()` → `createKernel()`）、升 0.3.0 | 做。777 个导出里真被用 59 个 | 65 个消费文件，真要动代码的只有四类 |
| K2 | 删 HostBridge / sidecar 整条链（约 600 行 + 两个环境变量） | 删。本轮只把权限闸补上了 | ABI 里的 `'sidecar'` 取值去留 |
| K3 | 身份注册 RPC 整块（152 行 + 8 个 RPC 方法）去留 | 删，全仓与三个产品零调用 | 协议面 |
| K4 | `mods.*` 三个 RPC 方法去留 | 留（mod 主干设计依赖 `mods/list`） | 协议面 |
| K5 | 进程内调用补「调用方归属」 | 加。现在宿主判不出是谁在调 | Desktop 可以删掉自己复刻的调用路径 |
| K6 | 事件订阅者失败隔离（现在一个订阅者抛错，后面的收不到、发布方也失败） | 隔离 + 记日志 | 行为变化 |
| K7 | 更新器强制 HTTPS 并默认验签；远程节点 `ws://` 明文传输 | 都加固 | 部署与配置 |
| K8 | `velaros-kernel-daemon` 的权限策略注入口（现在没有，缺省全拒） | 加 | 独立守护进程可用性 |
| **排期** | `./contracts/abi` 是全仓被引用最多的入口（八个能力包的内核模块都靠它） | **kernel 的入口收口要排在 model、office、computer 之前**，否则它们要为同一件事改两遍 | 全局顺序 |

## 五、model / office / computer

| # | 事项 | 我的建议 | 影响 |
| --- | --- | --- | --- |
| C1 | 三包入口收口与版本：model 9→3（0.7.0）、office 6→3（2.0.0）、computer 3→2（0.3.0）；类不出包改工厂 | 做，与 agent、kernel 同车 | 各附逐符号迁移表 |
| C2 | office：删 10 个工具的 `cwd`（本轮只把越界堵上了） | 删。路径一律相对工作区 | 模型面 |
| C3 | office：缺转换器时的安装建议卡、「用浏览器线上处理」的替代方案搬回宿主（ADR 0004 在 system 那边已经这么定了） | 搬回宿主 | 宿主端口 |
| C4 | office：生成文档默认作者与公司写「VelarOS」；`autoRefresh` 缺省 | 作者留空、`autoRefresh` 缺省 false | 产物内容 |
| C5 | computer：删 `computer:screen_size`、`move` 绑定截图、`leftClick` 改名 `click` | 照做 | 模型面 |
| C6 | computer：「启用即授权」的口径（提示词现在说了 4 处，与卡片、README 互相矛盾） | 从工具说明里拿掉，改由卡片与宿主表达 | 模型面与产品文案 |
| C7 | model：`ModelErrorCodes` 错误码表（Desktop 现在按报错文字判断「缺 key」） | 做 | Desktop 判据 |
| C8 | model：`ModelAdapter` 基类换成注入点、删零调用的 `fetchTavily`、`reasoningLevel: ultra` 抬预算（会改请求字节） | 前两条做；抬预算单独一轮 | 扩展点与请求字节 |

## 六、七个小包

| # | 事项 | 我的建议 | 影响 |
| --- | --- | --- | --- |
| S1 | core：门禁加「原语包」档（`publicUtils` + `publicClasses: ['AppError']`，只给 core） | 加。否则 core 要把 1,455 个消费方在用的函数全包成类 | 标准与门禁 |
| S2 | core 三处改名：`Result` 值改 `results`（约 190 处）、`TimerScope` 改 `timerScopes.*`（约 120 处）、`logRuntime` 统一成 `Log`（约 180 处） | 都改，一次 codemod，与全仓同车 | Platform 约 300 个文件 |
| S3 | cli：`velaros agent` 命名空间读的目录已无人写；帮助与报错整体改中文 | 删该命名空间、改中文 | 命令行用户 |
| S4 | document-renderer：包内 `bin` 与 `./cli` 去留（真正的可执行文件在产品里） | 删 | 无消费方 |
| S5 | html-artifacts：允许机械改 ui 的 5 个文件（约 20 行）；删空转的 `check:dist` | 都做 | ui 编译 |
| S6 | agent-lab：Velar Hooks 驱动与客户端迁回 Desktop；预算口径改成「整程按整程、段按本段」；允许依赖 core | 都做 | 多段旅程的判定与策略摘要会变 |
| S7 | development：`referenceCount` 停扫时标「至少」；外部语言服务的诊断带上「是否完整」 | 都做 | 模型看得到的字段语义；Termel 跟改 |
| S8 | 标准补两条：可执行入口放包根 `bin/`；环境变量表目前只认 `VELAROS_*` 前缀 | 都补 | `module-ownership.md` |

## 七、跨包公共件（等 A2 定了才好落）

| # | 事项 | 我的建议 |
| --- | --- | --- |
| P1 | 工具定义辅助（四个包各一份 `defineXTool`）、内核模块样板（三份逐行同构）、工具失败回执构造器（`not-applied`/`skipped`/`failed` 三种写法） | 都进 agent 的工具契约；A2 若拆包就进新包 |
| P2 | 可选资源包定位（office、computer、Desktop 三份同算法） | 进 `@velaros-ai/platform/shared-resources` |
| P3 | 命令结果形状（system、project、office 三份同形） | 公共核心进 `@velaros-ai/shell-command/contracts`，三包各自 `extends` |

## 八、产品层接线（本仓不改，列给你排期）

- Desktop：project 端口新增的两个方法（已自动满足）、memory 按作用域给可写根、browser 适配层（B6）、office 安装建议卡（C3）、model 按错误码判「缺 key」（C7）、各包入口收口后的 import 迁移。
- Workbench：project 的 `runInDirectory` 删除后按 `options.cwd` 接线、browser 适配层、命令执行策略。
- Termel：agent、kernel、surface-protocol、development 的入口迁移。
