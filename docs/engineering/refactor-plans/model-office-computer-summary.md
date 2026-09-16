# model / office / computer 改造方案汇总

> 三份方案：`plan-mid/model.md`、`plan-mid/office.md`、`plan-mid/computer.md`。分析基于 Platform HEAD `7c39d5c9`，三个包工作区都干净，全程只读（探针只 import 源码，临时文件建在草稿区并已删除）。消费方扫描覆盖 Platform 与 Desktop、Workbench、Termel、Extension、Cloud。
> 基线：model 67 / office 22 / computer 15 条测试全过。

## 总览

| | model | office | computer |
| --- | --- | --- | --- |
| 规模 | 45 个文件 7,959 行，27 个类 | 26 个文件 7,339 行（+ PptxGenJS vendor），161 个顶层函数、3 个类 | 15 个文件 1,918 行 + Python helper 1,064 行 |
| 模型面工具 | 无（内核 wire 操作 1 个） | 10 个，9 个 execute 超 4 条 | 6 个 |
| 入口 | 9 → 3（`.`、`./contracts`、`./catalog`） | 6 → 3（`.`、`./contracts`、`./renderer`） | 3 → 2（`.`、`./contracts`） |
| 导出 / 被用 | 474 个名字（去重 198），被用 76 | 68（去重 39），被用 10 | 52，被用 16 |
| 实测缺陷 | 3 个（+4 个走读） | 5 个（+3 个走读） | 4 个（+3 个走读） |
| 版本 | 0.6.4 → 0.7.0 | 1.1.11 → 2.0.0 | 0.2.16 → 0.3.0 |

## model：结论先行

1. **规模**：27 个类只有 8 个实现接口、22 个直接出包；9 个入口导出 474 个名字，产品只用 61 个（仓内 consumer 测试与发布 fixtures 另用 15 个），`./provider-scripts/node`、`./ProviderScriptContextWindow` 零消费。
2. **主要问题**：
   - 产品各自 `new ModelRequestClient()`（11 处）、`new ProviderModelCatalogService`（2 处，与组合对象里那份不共享缓存和归属）。
   - 死代码与重复：353 行模型能力画像、agent 各有一份的原始流解析与缓存写标记、4 个转发函数、4 个 Profile 端口、零调用的 `fetchTavily`。
   - 错误全是 `VALIDATION`，Desktop 渲染层按「API Key 未配置」文字判断。
   - 20 处用户可见英文。
3. **实测缺陷**：
   - `reasoningLevel: 'off'` 对 Anthropic/OpenAI/Google/OpenRouter 不生效（仍发推理参数）。
   - `registerSource` 内存注册的 provider script 在 `configureHost` 后丢失。
   - Velar embedding 绕过宿主注入的带账户认证 fetch。
4. **目标**：
   - impl 28 个类文件分 `composition/ requests/ adapters/ providers/` 四个子目录、3 层；utils 19 个文件。
   - `./catalog` 留给渲染进程（Desktop 两道渲染边界检查本来就只放行 `/catalog` 与 `/contracts`）。
   - 目录服务只从组合对象取。
5. **拍板**：入口收口与 0.7.0；类不出包改工厂；`reasoningLevel` 语义修正（改请求字节）；`ModelErrorCodes`；`ModelAdapter` 基类换成注入点 `ModelProviderAdapter`；删 `fetchTavily`；与 agent 的缓存标记协议用仓库级一致性测试守。

## office：结论先行

1. **规模**：10 个工具定义散在 6 个 `*.tool.ts`，实现是 5 个近千行的函数模块；产品只用 4 个导出名，另 6 个给 `packages/document-renderer`，根入口与 `./composition` 零消费。
2. **主要问题**：
   - 工具文件不是「只放定义」（execute 最多 53 条）。
   - 宿主端口带着产品壳概念：安装建议卡、「用浏览器线上处理」中英双语草稿、项目自动批准通知。端口还嵌套两层，门禁只能核到 `project`、`system` 两个名字。
   - 10 个工具的 `cwd`、`overwrite` 没有说明。
   - 两个模块级单例与 Desktop 的插件登记表是两套。
3. **实测缺陷**：
   - 项目内符号链接能把产物写到根外。
   - 只读工具经 `cwd` 把「根」换成任意目录、不过授权就读根外文件（Desktop 的 `runWithRootOverride` 不校验）。
   - `convert_document_to_markdown` 长文档返回结尾，却标 `truncated: false`。
   - Word 追加模式的项目符号引用不存在的编号定义。
   - pptx 预览的页数统计被 `maxItems` 截断。
4. **目标**：
   - `impl/OfficeTools.ts` 放全部定义，execute 各一行交给 `operations/` 六个执行类。
   - utils 按 word / presentation / spreadsheet / pdf / preview 分子目录。
   - 端口扁平一层，只放工具真调的 5 个方法（新增 `locateMarkItDown` 取代单例）。
   - `./renderer` 保留给不装 agent 的 Document Renderer。
5. **拍板**：删 `cwd`；安装建议与替代方案搬回宿主；读取范围；MarkItDown 改走临时文件；生成文档默认写「VelarOS」作者与公司；追加模式怎么修；`autoRefresh` 缺省；内核模块去留；产物英文；2.0.0。

## computer：结论先行

1. **规模**：3 个类 1 个实现接口；刻意没有根入口；Desktop 用 5 个导出名、Termel 用 13 个。
2. **主要问题**：
   - 同一个操作两套入参契约（工具 schema 与内核手写解析，上限都不一样），靠 `ComputerToolOperations` 硬映射。
   - 工具说明、README 与注释在「逐次确认」上互相矛盾；`ComputerToolContext.execution` 无人使用。
   - helper 与 sidecar 的报错全是英文，模型点击失败时读的就是它们。
3. **实测缺陷**：
   - `computer:move` 经内核调用（Termel 的做法）必失败，且坐标语义不同。
   - helper 关掉 stdin 或途中退出时，`EPIPE` 成为宿主进程未捕获异常（Node 与 Bun 都复现）。
   - helper 半行崩溃后下一次握手被残留缓冲吞掉，启动又没有超时，请求永远挂起。
   - Desktop 的共享资源安装根与停用集到不了本包单例。按代码推断，插件市场装的 Computer Use 在 Desktop 里找不到，需真机确认。
4. **目标**：impl 4 个文件 4 层；内核改按工具名、用工具 schema（与 system、office 同一个 `createToolCallableOperations`）；资源来源改注入；`./runtime` 与 `./tools` 合成 `.`。
5. **拍板**：入口合并；内核按工具名；删内核服务上的运行时直调面（含 `dispose`）；删 `computer:screen_size`、move 绑定截图；「启用即授权」从工具说明挪到卡片与宿主；`leftClick` 改名 `click`；helper 报错由 sidecar 按码翻中文。

## 可以抽成公共逻辑的重复

| # | 重复 | 证据 | 去处 |
| --- | --- | --- | --- |
| S1 | **工具定义辅助** | `defineSystemTool`（system `utils/tool.ts`，查表填类别 + 可选 `withToolInputReuse`）、`defineProjectTool`（project `utils/tool.ts`）、`defineOfficeTool`（`officeShared.ts:121`）、`defineComputerTool`（`tools/Types.ts:66`）四份同构；每个包再各写一遍 `VelaTool<T>` 与 `XToolCollection`；office、computer 各自再包一层 `structureToolDescriptionsForCategory` | `@velaros-ai/agent/tool-contract`（agent 第 6 步若拆出 `@velaros-ai/tool-contract` 就进那里）提供 `createToolDefiner({ categoryOf, inputReuse?, contractVersion? })` 与泛型集合类型；各包保留一行 `const defineXTool = createToolDefiner(…)`，门禁的 `toolDefiner` 照旧只在工具文件里被调用 |
| S2 | **内核模块样板** | system（`SystemTools.ts` 末尾）、project（`ProjectTools.ts:707-720`）、office（`kernel-module.ts`）三份逐行同构：`defineKernelModule` + `createKernelCallableCapability(createToolCallableOperations(...))` + `registerService({ ...callable, tools })`，外加各自的能力令牌与 `XCapabilityService { tools }`；computer 按 D2 改完是第四份 | 同上，`createToolKernelModule({ id, version, permissions, token, tools, resolveContext, label, mapError })` 与 `ToolCapabilityService<TTools>`，放在 `createToolCallableOperations` 旁边 |
| S3 | **内核 wire 入参严格解析** | agent `parseToolWireInput` 只对顶层 `.strict()`；computer 14 个手写 `parse*`；model 的 `parseProviderInput` | computer 随 S2 改用工具 schema；office、computer 的 schema 与 system 一样全程 `z.strictObject`；model 只有一个操作且不能依赖 agent，保留自己的解析、改中文 |
| S4 | **可选资源包定位** | office `MarkItDownBinaryResolver` + `OfficeResourceRuntimeRegistry`、computer `ComputerHelperResolver` + `ComputerResourceRuntimeRegistry` 与 Desktop 自己的 resolver 是同一套算法（环境变量根 → 宿主额外根 → Electron `resourcesPath` → `out/resources`，找 `<根>/<工具目录>/<名>-<平台>-<架构>`，读版本、查停用）；两个登记表类逐行相同；Desktop 只登记了自己那份，所以 office、computer 看不到共享资源安装根 | `@velaros-ai/platform/shared-resources`（ADR 0005 已让它回答共享资源目录在哪）加 `locateResourcePackage(...)`，缺省根里带共享资源根；`./contracts` 出端口类型 `ResourcePluginPort`；删两个登记表与两个单例 |
| S5 | **路径包含与真实路径** | office `getRelativePathInsideOfficeRoot` 是第五份「在不在根里」，按字面路径算 | 已落地的 platform `relativePathTextInside`（c9564d45）+ core `resolveRealPath`（7c39d5c9）；office 修符号链接缺陷时直接用上 |
| S6 | **命令端口与命令结果形状** | office 的 `runCommand(... nativeCommand)` 与 `OfficeSystemCommandResult` 是 system、project 命令结果的子集镜像；三方都有原生 argv 规格；Desktop 用同一个服务实现三个端口 | `@velaros-ai/shell-command/contracts` 增 `NativeCommandSpec` 与公共核心 `ShellCommandRunResult`，三包的结果都 `extends` 它（同 rehearsal-sandbox 的做法）；office 读正文改走临时文件，不必把输出窗口方向做成参数 |
| S7 | **修改授权决定的形状** | office 与 project 的授权决定字段逐一相同（连 Desktop 的 `projectAutoApprovalNotice` 都在） | 不抽包：office 按真读字段收窄成 `{ approved, rootPath, message, rejectionMessage }`，结构兼容 |
| S8 | **失败与跳过的回执** | office 三个构造器与 MarkItDown 缺失结果；project 结构化拒绝；system `not-applied`；computer 不可用时抛 `PERMISSION` | 流水账第 ③ 步待做的「工具失败构造器」放 `@velaros-ai/agent/tool-contract`，统一 `skipped / not-applied / failed` 信封；各包只出错误码表 |
| S9 | **模块级兼容单例** | `velarCloudModelRuntime`、`officeResourceRuntime`、`markItDownBinaryResolver`、`officePlatformCompatibility`、`computerResourceRuntime`、`computerHelperResolver` | 全删，改工厂 + 注入面 |
| S10 | **model 与 agent 的镜像** | 缓存断点标记协议（三个键，agent 写、model 翻译）、原始流文本解析（已分叉 7 处）、`applyModelRequestPolicy`、`reasoningLevel → thinkingDepth` 映射 | 删 model 里零消费的写标记函数与 `ProviderRawStreamText`；线协议用仓库级一致性测试守（`tests/model/prompt-cache-wire.test.ts`）；出现第三个消费方再抽 `@velaros-ai/model-wire` |
| S11 | **三张表的写法** | 三包都缺错误码表、环境变量表、上限表、tuning 表；office、computer 的上限在工具 schema 与内核各写一份 | 按 system 的 `constants.ts` / `tuning.ts` 模板各写一份，门禁已能核对 |
| S12 | **工具说明提到别的空间** | computer「网页内容用 browser 工具」、office 替代方案里的 `Browser Use` | ADR 0004 的「工具描述里不提别的空间」推广到全部能力包（拍板） |

## 建议的执行顺序

1. 三包各自先修实测缺陷，互不相干，可并行；每个缺陷一个提交带回归测试。computer 的 C2、C3 与 office 的 O2、O3 是安全与稳定性问题，优先。
2. S4（platform 资源定位）与 S6（shell-command 命令结果核心）两个公共件先落，office、computer 直接用上。
3. 三包的整文件搬家与达标（包内，入口名不变）可并行。
4. S1、S2、S8 等 agent 第 6 步定 `tool-contract` 去留后再做。
5. 三包入口收口是破坏性变更，各出迁移表，建议与 agent 1.0.0 同一列火车发，产品只迁一次。

共享文件要串行改：
- `scripts/ownership/governed-modules.mjs`
- 根 `tsconfig.json`（另一实例正在改）
- `scripts/capabilities/capability-owners.mjs`（office、computer 都改）
- `scripts/release/fixtures/host-contract-consumer/*`（model、computer、agent 都改）
- `docs/generated/package-catalog.json`
- `bun.lock`

## 需要用户拍板的项（汇总）

- **对外契约**：
  - 入口：model 9→3（0.7.0）、office 6→3（2.0.0）、computer 3→2（0.3.0），逐符号迁移表见各方案 3.4。
  - 三包的类都不再出包，改工厂。
  - office 宿主端口扁平化。
  - computer 内核按工具名调用，删服务上的运行时直调面。
  - 新增三张错误码表，Desktop 改按码判断「缺 key」。
- **工具面**：office 删 10 个工具的 `cwd`；computer 删 `computer:screen_size`、`computer:move` 绑定截图。
- **提示词**：
  - office：surfaces 不再提 `direct/expert`、补参数说明、改 LaTeX 流程与 MarkItDown 说明。
  - computer：删 4 处「启用即授权」、合并 snapshotId 规则、不提 browser 空间。
- **行为变化**：
  - model：`reasoningLevel: 'off'` 真关推理（改请求字节）；Velar embedding 走认证 fetch。
  - office：读取范围；MarkItDown 改走临时文件；Word 追加模式合并编号或拒绝；`autoRefresh` 缺省 false；默认作者与公司不再写「VelarOS」；缺转换器的安装卡搬回宿主。
  - computer：启动超时；「启用即授权」定为产品口径。
- **扩展点**：model 删 provider script 的 `fetchTavily`、`ModelAdapter` 基类换成注入接口；office 内核模块去留。
- **公共件**：S4 进 platform/shared-resources；S6 进 shell-command/contracts；S1/S2/S8 进 agent tool-contract（或独立的 tool-contract 包）。