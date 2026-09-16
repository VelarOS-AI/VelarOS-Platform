# `@velaros-ai/html-artifacts` 按仓库标准改造方案

> 对象：`packages/html-artifacts`（0.1.6，零运行时依赖的浏览器库），HEAD `606fba59`（数据采于 `7c39d5c9`；其后本范围内只有 core `utils/RealPath.ts` 的写法微调 `0ac2b5f1`，结论不变），本包工作区干净。
> 标准同其它方案。本包自己的门 `check:html-artifacts-package`（`check:package-contract` + `check:dist`）挂在 `check:gates`；kernel、agent 两个架构门钉了 README 里的两句发布说明（`personal access token`、`进程环境或凭据管理器注入`）。
> 基线：`node --test tests/*.test.mjs` 23 pass / 0 fail（测试跑 `dist/`，本次没有重新构建）。

## 0. 结论先行

- **规模**：`src/` 11 个源文件 2,358 行（协议解析器 1,064、iframe 外壳 528、浏览器宿主 464）；5 个入口（`.`、`./protocol`、`./sandbox`、`./browser`、`./runtime`）共导出 104 个符号（去重 44 个）。
- **真被用到的 19 个，全在两个入口上**：`./protocol` 9 个（Desktop 聊天流状态 1 个文件、ui 2 个文件只用一个类型），`./sandbox` 10 个（ui 5 个文件、Desktop 1 个文件）。**根入口、`./browser`、`./runtime` 零消费方**——README 头条的 `mountHtmlArtifact()` / `HtmlArtifactRuntime` 与面向对象的 `HtmlArtifactProtocolParser` 在 VelarOS 自己的产品里都没人用（ui 与 Desktop 各自托管 iframe），只有 demo 与测试在用。
- **主要问题**：三个类出包、其中两个在同一个文件；函数全部直接出包；上限与缺省值是模块级数字常量（11 处），iframe 注入脚本里还把 `1200`、`3` 抄了一遍；用户看得到的 7 处英文（宿主报错、缺省标题 `HTML Live Preview`）；包内一份 core 守卫的迷你副本（`internal-runtime.ts`，零依赖所致）；`check:dist` 是空转的门。
- **目标**：三件整件能力——增量协议 `htmlArtifactProtocol`、沙箱文档 `htmlArtifactDocuments`、浏览器宿主工厂 `mountHtmlArtifact`；注入面一个（`HtmlArtifactBrowserEnvironment`）；上限与缺省进常量表；入口收成 `.`、`./contracts`，都能在渲染进程加载。
- **要拍板**：ui 包里 5 个文件要跟着改调用（ui 本轮不动）；是否继续保持零运行时依赖；`check:dist` 与独立发版脚本删不删（§7）。

## 1. 现状

### 1.1 入口与消费方

| 入口 | 被用的符号 | 消费方 |
| --- | --- | --- |
| `./protocol` | `createHtmlArtifactProtocolStreamState`、`applyHtmlArtifactProtocolChunk`、`finalizeHtmlArtifactProtocol`、`DEFAULT_HTML_ARTIFACT_HEIGHT`、4 个类型；`HtmlArtifactRenderPatch` | Desktop `chatHtmlArtifactProtocolState.ts`（聊天流里持久化解析状态）；ui `HtmlPreviewFrame.tsx`、`htmlPreviewDocument.ts` |
| `./sandbox` | `buildHtmlArtifactDocument`、`buildHtmlArtifactShellDocument`、`inferHtmlArtifactContentKind`、`normalizeHtmlArtifactSource`、`normalizeHtmlArtifactExternalUrl`、`resolveHtmlArtifactFrameFit`、`HTML_ARTIFACT_WHEEL_MESSAGE_TYPE`、3 个类型 | ui 5 个文件（HTML 预览、Widget、外链导航）；Desktop `chatSessionWidgetArtifacts.ts` |
| `.`、`./browser`、`./runtime` | 无 | 只有 `demo/main.js` 与测试 |

### 1.2 其余现状

| 文件 | 内容 | 按标准要处理的点 |
| --- | --- | --- |
| `protocol.ts` | 状态机解析器（函数式 API）+ `HtmlArtifactProtocolParser` 类 + 12 个类型 | 类无接口；9 个模块级数字常量；`clipText`/`clipTail` 按 UTF-16 单元截，会切开代理对；缺省标题英文 |
| `shell.ts` | 两种 iframe 文档构造、源码归一化、内联桥接/尺寸/补丁脚本 | 3 个缺省常量；桥接消息名表是规则数据 |
| `size-controller.ts` | 注入 iframe 的尺寸控制器源码字符串 | 字符串里写死 `1200`、`3`，与 `shell.ts` 的缺省各持一份 |
| `browser.ts` | `DomHtmlArtifactEnvironment`、`HtmlArtifactRuntime` 两个类 + `mountHtmlArtifact` | 一个文件两个类；6 处英文报错与宿主错误信息 |
| `frame-fit.ts`、`security.ts`、`positive-number.ts` | 宿主侧缩放计算、外链规范化、正数守卫 | 纯函数，进 utils |
| `internal-runtime.ts` | `isString`、`isFunction`（`instanceof Function`）等守卫与一个 `Log` | core 的迷你副本；`isFunction` 跨 realm 失效 |
| `index.ts`、`runtime.ts`、`sandbox.ts` | 通配转发；`runtime` 是 `sandbox` 的兼容别名 | 删除 |

测试 4 个文件（`node --test`，跑 dist）；demo 用 vite `^7.3.2`（根是 `^8.2.1`）。

## 2. 目标布局

```text
src/
  contract/   provides.ts、requires.ts（HtmlArtifactBrowserEnvironment）、constants.ts
  types/      html-artifacts.ts（可移植：描述、快照、补丁、协议事件、流状态、上限、诊断、尺寸拟合、文档选项、桥接消息名）
              browser.ts（带回调的挂载选项、宿主错误）
  impl/       HtmlArtifactProtocol.ts、HtmlArtifactProtocolParser.ts、HtmlArtifactDocuments.ts、HtmlArtifactRuntime.ts、DomHtmlArtifactEnvironment.ts
  utils/      protocol-stream.ts（解析状态机本体）、shell-document.ts、size-controller.ts、frame-fit.ts、external-url.ts、runtime-guards.ts、tuning.ts
  exports/    index.ts、contracts.ts
```

| 现有 | 去处 |
| --- | --- |
| `protocol.ts` 的状态机函数 | `utils/protocol-stream.ts`（纯函数，改动的是传进来的状态对象）；类型进 `types/html-artifacts.ts`；常量进常量表 |
| `protocol.ts` 的函数式 API | `impl/HtmlArtifactProtocol.ts`：`createState` / `applyChunk` / `finalize` / `createParser` 四个方法，实例 `htmlArtifactProtocol` |
| `HtmlArtifactProtocolParser` 类 | `impl/HtmlArtifactProtocolParser.ts`，类上方 `HtmlArtifactProtocolParserApi`，经 `htmlArtifactProtocol.createParser()` 取得 |
| `shell.ts` + `frame-fit.ts` + `security.ts` | 实现进 utils；对外经 `impl/HtmlArtifactDocuments.ts`（实例 `htmlArtifactDocuments`：`buildDocument`、`buildShellDocument`、`normalizeSource`、`inferContentKind`、`resolveFrameFit`、`normalizeExternalUrl`） |
| `size-controller.ts` | `utils/size-controller.ts`；注入脚本里的缺省值改由生成脚本的函数从常量表插进去，不再各写一份 |
| `browser.ts` | 拆成 `impl/HtmlArtifactRuntime.ts`（类上方 `HtmlArtifactController`）与 `impl/DomHtmlArtifactEnvironment.ts`（实现注入面接口）；`mountHtmlArtifact` 留作工厂 |
| `internal-runtime.ts`、`positive-number.ts` | `utils/runtime-guards.ts`（`isFunction` 改 `typeof`）；`Log` 迷你实现保留在这里（零依赖） |
| `index.ts`、`runtime.ts`、`sandbox.ts` | 删除 |

登记表：`portable: 'html-artifacts.ts'`，`tuning: 'tuning.ts'`，`browserSafeEntries: ['index.ts', 'contracts.ts']`，`layers: [['HtmlArtifactRuntime.ts'], ['HtmlArtifactProtocol.ts', 'HtmlArtifactDocuments.ts', 'DomHtmlArtifactEnvironment.ts'], ['HtmlArtifactProtocolParser.ts']]`。

## 3. 合同草案

**provides**

| 接口 | 出包的值 | 成员 |
| --- | --- | --- |
| `HtmlArtifactProtocolApi` | 实例 `htmlArtifactProtocol` | `createState(options?)`、`applyChunk(state, chunk)`、`finalize(state)`（宿主自己持久化状态时用，Desktop 正是这样）、`createParser(options?)` |
| `HtmlArtifactProtocolParserApi` | 经 `createParser` 取得 | `state`、`write`、`finish`、`getSnapshot`、`reset` |
| `HtmlArtifactDocumentsApi` | 实例 `htmlArtifactDocuments` | 上表六个方法 |
| `HtmlArtifactController` | 工厂 `mountHtmlArtifact(target, options): HtmlArtifactController` | `iframe`、`ready`、`write`、`finish`、`consume`、`getSnapshot`、`reset`、`dispose` |

**requires**：`HtmlArtifactBrowserEnvironment`——宿主可替换的浏览器边界（建桥 id、造 iframe、订阅消息、滚动），webview 与测试用；缺省用 DOM 实现。

**constants**

| 表 | 内容 |
| --- | --- |
| `HtmlArtifactProtocol` | `version: '1'`、补丁类型、协议模式 |
| `HtmlArtifactDefaults` | 初始高度 360、最大上报高度 1200、宽度倍数上限 3、宿主缩放倍数上限 4、`<artifact height>` 取值范围 160–1200、缺省标题（改中文） |
| `HtmlArtifactProtocolLimitDefaults` | 缓冲 16,384、HTML 256,000、协议原文 256,000、动作载荷 256,000、标题与 id 各 80、补丁元数据 160（公开：宿主据此设 `protocolLimits`） |
| `HtmlArtifactBridgeMessageTypes` | 七个缺省桥接消息名与滚轮消息名 `velaros:html-artifact-wheel` |
| `HtmlArtifactExternalUrlProtocols` | 缺省放行 `http:`、`https:` |

**要删的导出与替代**（破坏性，升 0.2.0）

| 现在 | 以后 |
| --- | --- |
| `createHtmlArtifactProtocolStreamState(o)` / `applyHtmlArtifactProtocolChunk(s, c)` / `finalizeHtmlArtifactProtocol(s)` | `htmlArtifactProtocol.createState(o)` / `.applyChunk(s, c)` / `.finalize(s)` |
| `new HtmlArtifactProtocolParser(o)` | `htmlArtifactProtocol.createParser(o)` |
| `buildHtmlArtifactDocument` / `buildHtmlArtifactShellDocument` / `normalizeHtmlArtifactSource` / `inferHtmlArtifactContentKind` / `resolveHtmlArtifactFrameFit` / `normalizeHtmlArtifactExternalUrl` | `htmlArtifactDocuments.buildDocument` / `.buildShellDocument` / `.normalizeSource` / `.inferContentKind` / `.resolveFrameFit` / `.normalizeExternalUrl` |
| `DEFAULT_HTML_ARTIFACT_HEIGHT`、`DEFAULT_HTML_ARTIFACT_MAX_REPORTED_HEIGHT`、`DEFAULT_HTML_ARTIFACT_MAX_WIDTH_RATIO`、`HTML_ARTIFACT_PROTOCOL_VERSION`、`HTML_ARTIFACT_WHEEL_MESSAGE_TYPE` | 常量表对应项 |
| `new HtmlArtifactRuntime(t, o)`、`new DomHtmlArtifactEnvironment()` | `mountHtmlArtifact(t, o)`；环境经 `options.environment` 注入 |
| `./protocol`、`./sandbox`、`./browser`、`./runtime` | `@velaros-ai/html-artifacts`（全部浏览器安全）与 `/contracts` |

跟着改的地方：ui 5 个文件（import 与约 20 处调用）、Desktop 2 个文件（另有 `ModSandboxFrame.tsx` 只在注释里提到函数名），`demo/main.js`、4 个测试文件。

## 4. 用户面文字

- 宿主错误（交给 `onError`，产品可能直接显示）：`Blocked an invalid artifact URL`、`Artifact runtime error`、`HTML artifact iframe is not available`、`${callback} callback failed`；程序错误：`HtmlArtifactRuntime target must be an HTMLElement`、`… already consuming a stream`、`… has been disposed`。改中文，`phase` 不变（外面按 `phase` 判断）。
- 缺省标题 `HTML Live Preview` 会出现在 iframe 的 title 上，改中文（进常量表）。
- 注入 iframe 的脚本里 `'Artifact error'`、`'Unhandled artifact promise rejection'` 会经桥回到宿主，一起改。
- 类型与接口上的英文 JSDoc 按合同文件的规矩改中文（门禁要求每个接口与成员有中文说明）。

## 5. 实现层缺陷

1. **`check:dist` 是空转的门**：它跑 `git diff --exit-code -- dist` 与「dist 下未跟踪文件」，但仓根 `.gitignore` 忽略了 `dist/`（`git check-ignore` 确认），两条永远为空。这是本包独立成仓时提交 dist 的遗留。建议删掉，产物一致性由 `check:package-contract` 的打包安装验证覆盖。
2. **`prepare-release.mjs` 与 `release:dry-run` 是独立仓时代的发版流程**（要求 `v<version>` 标签），Platform 统一走 `release:local`；无人调用，建议删除。
3. **截断会切开代理对**：`clipText`/`clipTail` 按 UTF-16 单元截，超长 HTML 与协议原文被截时可能留下孤立代理项。改用 core 将提供的代理对安全截取需要破零依赖；在本包 utils 里就地写一个（算法数字就地写）。
4. **`isFunction` 用 `instanceof Function`**：宿主在另一个 realm（另一个 iframe、webview 桥）里创建的回调会被当成「不是函数」而静默不调用。改 `typeof value === 'function'`。
5. **同一个缺省值两处写**：`size-controller.ts` 注入脚本里的 `1200`、`3` 与 `shell.ts` 的缺省常量各写一份，改缺省只改一处就会漂。
6. demo 的 vite 版本（`^7.3.2`）落后根依赖（`^8.2.1`）；测试用 `node --test` 而仓库其余包用 `bun test`——工具统一可以随本次顺手做，不影响行为。

## 6. 步骤、检查与共享文件

1. 常量、类型、utils（状态机原样搬家，不改算法）、五个类、两个入口；删旧入口与 `check:dist`、`prepare-release.mjs`。
2. `spec/invariants.md`（建议：INV-1 流可以在任意字符处切开，只有完整安全的协议边界才送进 iframe；INV-2 iframe 固定 `sandbox="allow-scripts"`，外链只放行 http/https，非法链接永远到不了 `onLink`；INV-3 上报高度是去重后的绝对值，宿主与 iframe 两侧都按 `maxHeight` 封顶；INV-4 协议资源上限对超长或恶意流生效；INV-5 根入口与 `./contracts` 不碰 Node（门禁））与验收；`MODULE.md`；README（保留两句被架构门钉住的发布说明）。
3. `package.json`：exports 指 `dist/exports/*`；`test` 脚本改成先 build 再跑验收（若继续 `node --test`，登记表的 `acceptance` 写 `.mjs` 路径）；`check:package-contract` 里「逐个入口打包安装再 import」的逻辑不用改，它按 `package.json` 的 exports 走。
4. ui 的调用改写（需拍板）；Desktop 2 个文件列进产品迁移表；升 0.2.0。

检查：`bun scripts/ownership/check-module-ownership.mjs --only html-artifacts`、`bun run check:html-artifacts-package`、`bun run --cwd packages/html-artifacts test`、`bun run test:ui`（ui 的调用改完后）、`bun run check:kernel-arch`、`bun run check:agent-arch`（README 标记句）、`bun run check:code-style`（`frontendRoots` 包含本包 src）、`bun run check:package-catalog`。

共享文件：`scripts/ownership/governed-modules.mjs`、`arch-guard.config.mjs`（若文件改名命中 skip/allow 名单则同步，当前无本包条目）、`packages/ui/src/conversation/**` 5 个文件、`docs/generated/package-catalog.json`、`bun.lock`。

## 7. 需要拍板

1. **ui 的 5 个文件要跟着改调用**（`artifacts/HtmlArtifactBlock.tsx`、`html-preview/HtmlPreviewFrame.tsx`、`html-preview/htmlPreviewDocument.ts`、`internal/externalNavigation.ts`、`tool-render/widget/WidgetToolRender.tsx`）。ui 本轮不改造，但 html-artifacts 的函数改成实例方法后它编译不过。两个办法：允许机械改这 5 个文件（只改 import 与调用写法，约 20 行）；或者 html-artifacts 这一轮在登记表里标 `status: 'migrating'`，只收入口、保留函数直接出包（门禁照报这几条、不计失败），等 ui 纳入治理时再改完。建议前者。
2. **继续零运行时依赖吗**：保持零依赖就要在包里留一份守卫与日志的迷你副本（arch-guard 已为此给了豁免注释）；改依赖 `@velaros-ai/core` 能删掉副本并用上代理对安全截取，但本包对外承诺「零运行时依赖的浏览器库」。建议保持零依赖。
3. **删 `check:dist`、`prepare-release.mjs`、`release:dry-run`**（空转与遗留）。建议删。
