# 七个包按仓库标准改造：总览

> 范围：`agent-lab`、`development`、`html-artifacts`、`core`、`cli`、`document-renderer`、`surface-protocol`。每包一份方案在同目录（`<包名>.md`），本文件只放结论、顺序与执行编组。
> 依据：数据采于 HEAD `7c39d5c9`（已含 core `utils/RealPath` 与 platform `isPathTextInside`），已在 HEAD `606fba59` 复核：这 38 个提交里只有 `0ac2b5f1` 碰过本范围（core `RealPath.ts` 的判空写法），全部结论不变；七个包工作区仍然干净；agent 的整文件搬家与 text-files 正在进行（core 的 Platform 侧 import 计数会随它小幅浮动，不影响结论）。消费方数字来自 AST 扫描（Platform 全仓 + Desktop、Workbench、Termel、Extension、Cloud、Website）。标注「已复现」的缺陷都在草稿区 `plan-small/probe-*` 里跑过，只动草稿区文件。

## 一、各包结论

| 包 | 规模 | 消费方 | 主要问题 | 目标 | 版本 |
| --- | --- | --- | --- | --- | --- |
| surface-protocol | 2 文件 150 行，1 入口 22 个导出 | Termel 8 个文件、Desktop 2 个；10 个 schema 只有 1 个有人用 | 类型全是 `z.infer`；schema 直接出包；版本号是裸数字；上限写死在 schema | 手写可移植类型 + 常量表 + 一个 `providerSurfaceWire`（五个 `check*` 返回 `{path, code}` 问题列表、`createBinding`）；入口 `.`、`./contracts` | 0.2.0 |
| document-renderer | 6 文件 400 行，private 能力包 | 零 import；产品启动器按源码路径加载 | 自定义错误类当控制流；版本双写；环境变量未登记；用了 core 却没声明依赖；报错英文 | `DocumentRenderer` / `RendererPaths` / `OfficeRenderer` 三个类，`AppError` + 四个错误码，删 `./cli` | 0.2.0 |
| cli | 8 文件 592 行 | 库面零消费方，只用 `velaros` 可执行文件 | 类无接口且出包；文字全英文；`VELAROS_TERMEL_COMMAND` 未登记；`bin.ts` 带副作用 | 路由器类 + 工厂 + 默认实例，两个命名空间类；可执行文件移到包根 `bin/`；入口 `.`、`./contracts` | 0.3.0 |
| html-artifacts | 11 文件 2,358 行，5 入口 104 个导出 | 真用 19 个：Desktop 2 个文件、ui 5 个文件；根入口、`./browser`、`./runtime` 零消费方 | 三个类出包、一个文件两个类；缺省值散落且注入脚本里另抄一份；7 处英文；`check:dist` 空转 | 三件能力 `htmlArtifactProtocol`、`htmlArtifactDocuments`、`mountHtmlArtifact`；注入面一个；入口 `.`、`./contracts`；保持零依赖 | 0.2.0 |
| development | 10 文件 3,765 行 | Desktop、Workbench、Termel 各 1–2 个文件 + 发布门夹具 | TS 语言服务池是模块级状态且无淘汰；import 时注册（副作用）；两类同文件；上限散落 | 8 个类（查询、只读语言查询、注册表、两种语言服务、TS 池、外部语言服务与客户端）；池出 `release()`；入口 `.`、`./contracts` | 2.0.0 |
| agent-lab | 44 文件 6,856 行，10 入口 219 个导出 | 只有 Desktop 开发工具（30 个文件，用 65 个符号） | 目录即入口；类型与 schema 靠强转对齐；4 个类无接口；CLI 副作用 + 动态 import；44 处英文与英文探测器摘要；包内三处重复实现；核心里写着 VelarOS 工具名与 Desktop 专用驱动 | 9 件整件能力 + 注入面（驱动、验证器、探测器、运行时加载器）；一个可移植数据文件；入口 `.`、`./contracts`；`bin/` 里做动态 import | 0.2.0 |
| core | 24 文件 2,428 行，6 入口（含 `./utils/*` 通配） | 1,455 个文件：Platform 656、Desktop 628、Workbench 161、Termel 10 | 产品就是函数，与「utils 函数不出包」「类不出包」冲突；`Result` 同名值与类型；通配子路径；`logRuntime`/`Log` 双名；死代码一批 | 门禁加只给 core 的「原语包」档（`publicUtils`、`publicClasses: ['AppError']`）；日志、计时作用域做成类加接口；入口 `.`、`./contracts`、`./node`；新增 `readErrnoCode`、代理对安全截取、`stableStringify`、错误码 `UNAVAILABLE`；错误信封不进 core | 0.4.x 补丁 + 0.5.0 |

## 二、顺带发现的真 bug（按严重度）

| 包 | 缺陷 | 状态 |
| --- | --- | --- |
| cli | `velaros agent status` 的越界判定只看字面路径，仓库里放一个符号链接就能让 `--full` 打印工作区外的 JSON（代码注释声明要挡的正是这个） | 已复现 |
| document-renderer | 先 `mkdir` 后判越界：经项目内符号链接能在 projectRoot 外建目录，然后才回 PATH_DENIED | 已复现 |
| agent-lab | Hooks 客户端缺省读 `os.tmpdir()` 下的凭据文件；Desktop 早为防符号链接攻击挪到了 userData，多用户 Linux 上可被别人放的文件把命令导走 | 代码核对 |
| agent-lab | 段预算与整程账本口径冲突，第二段按整程时间被误判超预算 | 已复现 |
| agent-lab | `runJob` 一个试验失败就返回，其余试验在后台继续开会话、发提示词 | 已复现 |
| agent-lab | Hooks 客户端对 4xx 也重试（缺省约 30 秒），非幂等 POST 会被重发 | 4xx 已复现 |
| agent-lab | 所有归档的 harness 版本都写成 `0.1.0` | 已复现 |
| development | `find_symbols`/`list_exports` 每个未导出符号整文件重解析（900 行文件约 290 ms）；每条诊断再解析一次 | 实测 |
| development | `referenceCount` 最多 limit+1，却以总数名义交给模型；外部语言服务把「8 秒没等到」当成「没有问题」；语言服务池只增不减 | 代码核对 |
| core | `truncate` 与 `AppError.getMessage` 会切开代理对（`truncate` 用在 35 处交给模型的文字里） | 已复现 |
| document-renderer | 非法 JSON 输入没有 JSON 回执；INVALID_REQUEST 塞的是 zod 原始 issue JSON | 已复现 |
| cli | 选项写在子命令前会被当成子命令；Windows 上 `velaros terminal` 起不来 npm 装的 `termel.cmd` | 前者已复现，后者待实机 |
| development、document-renderer | 项目里名叫 `..xxx` 的目录被判成越界（与 project 已修的是同一个错） | 已复现 |
| html-artifacts | `check:dist` 永远通过（dist 被 .gitignore 忽略）；`isFunction` 用 `instanceof`，跨 realm 回调被静默丢掉 | 已核对 |
| surface-protocol | `createProviderSurfaceBinding('')` 造出的绑定过不了自己的 schema | 已复现 |

## 三、推荐顺序与执行编组

**原则**：七个包里只有 core 有全仓级涟漪（Platform 656 个文件 import 它，agent 占 231 个），而 agent 正在整文件搬家；其余六个包彼此不引用，Platform 里也几乎没有 import 方（html-artifacts 只被 ui 用、development 只被发布门夹具用），可以和大包的改造并行。core 拆两段：只增不删的一段先做，破坏性的一段最后做。

| 顺序 | 编组（一个执行代理） | 内容 | 前置 | 规模 |
| --- | --- | --- | --- | --- |
| 1 | **E1：core 第一段** | 修代理对截断；新增 `readErrnoCode`、`clampToCodePointBoundary`、`takeTail`、`stableStringify`、错误码 `UNAVAILABLE`；两处英文改中文；补测试；删孤儿脚本。不改任何入口与名字，0.4.3 | 无 | 小 |
| 2 | **E2：三个小包** | surface-protocol → document-renderer → cli，按顺序一个代理做完，每包单独提交 | 拍板 §四-3、4、5 | 小，合计约 1,150 行 |
| 2 | **E3：html-artifacts** | 可与 E2 并行，也可由 E2 做完三个小包后接着做 | 拍板 §四-6 | 中 |
| 2 | **E4：development** | 先修三处性能与越界缺陷，再搬家 | E1 的 `UNAVAILABLE`（不是硬前置） | 中 |
| 2 | **E5：agent-lab** | 先修 5 个行为缺陷，再搬家；Desktop 迁移表 | 拍板 §四-7 | 大 |
| 3 | **E6：core 第二段** | 门禁加原语包档；搬家、删死码、`Log`/`results`/`timerScopes` 改名；一次性 codemod 改写 Platform 约 300 个文件；0.5.0 与全仓同一班车 | agent、browser、memory、kernel 的搬家都已落地；拍板 §四-1、2 | 大（机械） |

**执行时的共同约定**

- 各包先在登记表里登 `status: 'migrating'`，用 `bun scripts/ownership/check-module-ownership.mjs --only <目录>` 看燃尽，做完再去掉。
- 共享文件（`scripts/ownership/governed-modules.mjs`、根 `tsconfig.json`、`docs/generated/package-catalog.json`、`bun.lock`、`scripts/capabilities/capability-owners.mjs`）会被几路同时改：按既有做法用临时索引提交、只暂存自己的行；全仓 typecheck 被别人弄红时，用隔离 worktree 跑门禁。
- 在 E6 之前改造的包，import core 时直接用根入口已有的 `AppError`、`Log`（不要再写 `@velaros-ai/core/error`、`logRuntime`），能少改一轮。
- 可执行入口统一放包根 `bin/`（cli、agent-lab；document-renderer 视拍板），`src` 下不留有副作用的文件、不留动态 `import()`。
- 每包收尾：`MODULE.md` 十节、`spec/invariants.md` 与验收、README 中文、`package.json` exports 指 `dist/exports/*`、重新生成包目录、手改 `bun.lock` 的工作区版本。

## 四、需要你拍板的项

1. **core：门禁加「原语包」档**（`publicUtils` + `publicClasses: ['AppError']`，只给 core），还是把函数包成「无状态类 + 实例 + 逐名别名」。推荐前者；后者声明量约三倍，而且别名写法任何包都能拿来绕过「utils 函数不出包」。
2. **core：三处改名**——`Result` 的值改 `results`（约 190 处，类型不变）；`new TimerScope` / `TimerScope.sleep` 改 `timerScopes.create` / `.sleep`（约 120 处）；`logRuntime` 统一成 `Log`（约 180 处，门禁本来就只认 `Log.tag`）。推荐都改；另可选：core 的原子写要不要升到 text-files 的耐久语义（推荐暂不）。
3. **surface-protocol**：附件上限（单个 32 MiB base64 × 4）要不要收紧。可不动。
4. **document-renderer**：包内 `bin` 与 `./cli` 删不删（包是 private，真正的可执行文件由 `products/document-renderer` 构建）。推荐删。
5. **cli**：`velaros agent` 命名空间读的 `.velaros/agent-runs` 已无任何组件在写——删掉还是补上生产者（推荐删）；`velaros` 的帮助与报错整体改中文（推荐改）；保留 `createVelarosCliRouter` 扩展点（推荐留）。
6. **html-artifacts**：允许机械改 ui 的 5 个文件（ui 本轮不改造，但函数改实例方法后 ui 编译不过；只改 import 与调用写法，约 20 行）；继续保持零运行时依赖（推荐）；删空转的 `check:dist` 与独立仓时代的发版脚本（推荐）。
7. **agent-lab**：Velar Hooks 驱动与客户端迁回 Desktop（推荐）；预算口径改成「整程按整程累计、段按本段计」（会改变多段旅程的判定与策略摘要）；允许依赖 `@velaros-ai/core`（推荐，只许 core）；探测器摘要与 CLI 改中文（推荐）。
8. **development**：`referenceCount` 停扫时标「至少」（模型看得到的字段语义）；外部语言服务的诊断结果带上「是否完整」（Termel 跟着改）。两项都推荐。
9. **标准本身的两处补充**（随 E2/E6 落进 `module-ownership.md`）：可执行入口放包根 `bin/`；环境变量表目前只认 `VELAROS_*` 前缀，agent-lab 的 `VELAR_HOOKS_*` 登记不进去——若 Hooks 驱动迁回 Desktop 则不必改门禁。
