# 0014: Platform 按职责归包：底层能力并进 core，契约回到 agent，没人用的直接删

- Status: accepted
- Date: 2026-09-18
- Owners: `@velaros-ai/core`、`@velaros-ai/agent`、`@velaros-ai/ui`

## Context

工具并进 velar（ADR 0011）、空间包移出（ADR 0013）之后，`packages/` 下还平铺着一排小包：跨平台约定 `platform`（0.8k 行）、
磁盘文本 `text-files`（0.9k）、路径规则 `path-rules`（0.6k）、工具契约 `tool-contract`（2.6k）、外部 Agent 桥的线格式 `surface-protocol`（0.5k），
和只被 ui 用的 `html-artifacts`。产品仓除了 `surface-protocol` 一个都不直接引它们。`core` 自己的 `src/` 也是平铺的。

用户：「contract、text files、protocol、path rules 这些契约又是一些底层能力的，平铺着不好，能不能一起整理一下」「html-artifacts 现在也不需要单独了，可以并进 ui」
「没用的可以直接删除了，因为现在底层重构之后感觉某些协议其实也需要重写了」。

## Decision

按层归，不按「契约 / 能力」的名义归；一个包一份职责，只有要独立演进、或者合进去会成环时才单独成包。

### 底层能力并进 core，做单元

`platform`、`text-files`、`path-rules` 并进 `@velaros-ai/core`，布局与 velar 的能力单元一样（`core/<单元>/` 下 contract、types、impl、utils、
入口、卡片、不变量），入口换成 `@velaros-ai/core/platform`、`/platform/contracts`、`/platform/shared-resources`、`/text-files`、
`/text-files/contracts`、`/path-rules`、`/path-rules/contracts`，名字与行为不变，原包删掉。

- 为什么是 core，而不是另起一个基础包：三者都不带领域运行时，都在 kernel 之下。kernel 现在手写了一套平台判断（应用目录、凭据路径、
  `process.platform` 分支），并进 core 之后它能直接用；放到 kernel 之上的包里就永远用不了。
- core 的基础原语（断言、错误、结果、类型守卫、日志、工具函数）原样留在 `src/`，根入口与子路径一个不变——Desktop 646 个文件、Workbench 165 个文件在引。
- core 的领域词门禁（`check:core-semantic-vocabulary`）一起扫三个单元；两处同名不同义（WMI 的内存属性名、代码面生成器的 `@AgentView` 标记）逐条写了豁免理由。
- core 多了三个小的外部依赖（`diff`、`iconv-lite`、`picomatch`）；基础原语的根入口不引它们，渲染进程的打包不受影响。

### 工具契约回到 agent

`tool-contract` 并进 `@velaros-ai/agent` 现有的 `./tool-contract` 入口。它依赖 kernel（把工具挂成内核模块），进 core 会成环；
agent 本来就握着审批那一半，agent 里还有一排按原名转发它的垫片，两边的工具协议类型是靠测试盯着的同形副本——并进来只留一份。
code-surface 原来依赖 tool-contract，现在对 agent 用同版本线的 peer 依赖（agent 不做任何包的运行时依赖，velar 也是这么接的）。

### 没人用的删掉

`surface-protocol`：仓里没有任何包用它，只有产品与浏览器扩展用已发布的旧版本；外部 Agent 的线格式要按代码面重写，现在搬是白搬。删掉。
以后每一步归包都先查清每个导出还有谁在用，没人用的直接删，不迁。

### html-artifacts 并进 ui

`html-artifacts` 只被 ui 与 Desktop 用，并进 `@velaros-ai/ui`，做法与 core 的单元一样：ui 自己的组件留在 `src/`，
HTML 工件放在单元目录 `ui/html-artifacts/`，入口换成 `@velaros-ai/ui/html-artifacts` 与 `/contracts`。

### core 的基础原语不改布局

原计划把 core 的基础原语也改成单元布局、纳入所有权门禁。动手前核过，不做：那套门禁是给能力单元定的——入口不许导出 utils 函数，
也不许导出类（错误类也一样），类上不放公开静态成员；core 的基础原语对外恰恰就是根入口转出的一组工具函数，加上 `AppError` 这个类和它的
`from` / `fromJSON` 静态工厂，
Desktop 646 个文件、Workbench 165 个文件在引。套上门禁等于为一条给能力单元写的规则改遍全部调用方，职责上却什么也没理清。
基础原语照旧留在 `src/`，由 core 的领域词门禁看着。

### 顺序

每一步单独提交、单独跑全套 check：空间包移出（0013）之后 → 删 surface-protocol、三个底层包并进 core → tool-contract 并进 agent →
html-artifacts 并进 ui。产品仓升级时再改引用，这一轮只动 Platform。

## Alternatives

- **另起 `@velaros-ai/foundation` 装下全部小包**：tool-contract 依赖 kernel，放进去整个包就在 kernel 之上，kernel 用不到里面的底层能力；而且要么改 core 的名字、要么多一个跟 core 分不清的包。否决。
- **surface-protocol 并进 core**：它是领域线格式，放进无领域语义的 core 要开豁免；它也要重写。否决，删掉。
- **tool-contract 保持独立**：同一件事两个包、一排转发垫片、一对同形副本。否决。
