# 记忆树 v2 规范冻结（WS3-S0）

> 状态：**现行规范**。S1–S8 全部实施片以本文为准；本文与 [memory-tree-product-architecture.md](./memory-tree-product-architecture.md) 冲突时，以本文为准（本文只收窄、不推翻架构文档的产品裁决）。
> 日期：2026-07-24。冻结档：F5（密码学 / 序列化核心）。
> 参考实现：`packages/memory/src/memory-tree/v2/DiffChain.ts`。逐字节回归探针：`packages/memory/src/memory-tree/v2/treediff-v2-probe.ts`（附录 A fixture + **46 断言**），由 `bun run check` 链的 `check:memory-anchors`（`scripts/checks/memoryTreeDiffProbe.mjs`）机械复跑——**代码 = 规范 = 探针**，三者任一失配即判退。此门替补已退役的 `check:schemas` 在记忆树冻结面的锁位，专拦 D1 类排序/canonical 漂移悄改哈希。附录 A.2 的锚点全字段 fixture 可**纯从本文档复算**。
> 修改纪律：本文任何**冻结语义**（§1/§2 canonical 与哈希公式、§0 域字符串、§3–§5 构造配方）的变更 = 规范版本变更（`.v2` → `.v3` 域字符串整体推进 + 重灌级迁移），不存在"小改"。附录 A.2 锚点是这些语义的逐字节金标：改锚点值必须是语义变更的**结果**，不得反向为迁就代码漂移原地改常数。

## 冻结范围与编号映射

架构文档「实施前必须回答的问题」的五项（S0 委托令中的编号是速记，以下映射为准）：

| 本文章节 | 内容                                             | 架构文档编号                                           |
| -------- | ------------------------------------------------ | ------------------------------------------------------ |
| §1 / §2  | canonical 序列化、双哈希公式与 domain separation | #11（前半）                                            |
| §3       | contentRef 随机化承诺构造                        | #11（`content_commitment` 部分）                       |
| §4       | 盲索引 HMAC：归属 / 归一化 / 等值边界            | #17                                                    |
| §5       | stable_key 身份键规则                            | #4（顺带覆盖 #7 的初始 concept 稳定 key）              |
| §6       | ingest_sequence / frontier 语义                  | #15                                                    |
| §7       | 五物理根布局命名 + keyring 代际文件骨架          | #6（命名 / 创建 / 清理面；#16 的加密选型不在本文裁决） |

不在本文冻结的相邻项：#12（checkpoint 间隔与降采样执行策略——但基点哈希公式在 §2.4 预冻结）、#16 静态加密实现选型（SQLCipher vs 文件级，S2 裁决）、#9 Erasure Saga 完整状态机（S6）。

## §0 总则：编码与注册表

- **哈希原语**：SHA-256；**带密钥原语**：HMAC-SHA-256。理由：全库单一原语族，无跨原语组合分析负担，Node/浏览器/未来跨语言实现全有 boring 标准库。
- **文本编码**：一切哈希 / HMAC 输入均为 UTF-8 字节；输出一律**小写 hex**。理由：hex 无大小写歧义、可直接进 SQLite 文本列排序比较，base64 的 `+/=` 在路径与 URL 场景是隐患。
- **前缀注册表**（值的自描述版本标识，出现在列值本身）：

| 前缀       | 含义                                                                     | 长度（前缀后） |
| ---------- | ------------------------------------------------------------------------ | -------------- |
| （无前缀） | `tree_hash` / `event_hash`（v1 已裸存 hex，v2 沿用；版本区分靠域字符串） | 64 hex         |
| `k2:`      | 实体 stable_key（§5，HMAC 截断 128-bit）                                 | 32 hex         |
| `g2:`      | claim 分组键（§5.2）                                                     | 32 hex         |
| `c2:`      | 内容随机化承诺（§3）                                                     | 64 hex         |
| `m2:`      | 盲索引 match_key（§4）                                                   | 64 hex         |
| `f2:`      | Dream input_fingerprint（§6.4）                                          | 64 hex         |

- **域字符串注册表**（domain separation；全部以 `.v2` 结尾，规范升版整体推进）：
  - `velaros.memory.tree-state.v2`（§2.1）
  - `velaros.memory.tree-diff.v2`（§2.2）
  - `velaros.memory.tree-base.v2`（§2.4，S3 消费）
  - `velaros.memory.content-commitment.v2`（§3）
  - `velaros.memory.match-key.v2:<purpose>`（§4）
  - `velaros.memory.stable-key.v2`（§5）
  - `velaros.memory.dream-input.v2`（§6.4）

  理由：每个哈希用途一个不可混淆的域，同输入跨用途必然异哈希，防"承诺当哈希用 / 哈希当键用"级别的拼接事故。

## §1 canonical 序列化（#11 前半，终稿）

参考实现：`canonicalStringifyV2`。规范定义为对 ECMAScript `JSON.stringify` 语义的收窄，正文如下。

### §1.1 值域

只接受 **JSON 值域**：`null`、`boolean`、有限 `number`、`string`、数组、纯对象（原型为 `Object.prototype` 或 `null`）。以下一律抛 `VALIDATION` 拒绝：

- `NaN` / `±Infinity`（无 JSON 表示，静默变 `null` 是哈希毒药）；
- `bigint` / `symbol` / `function`（无确定性 JSON 语义）；
- 非纯对象（`Date`、`Map`、`Set`、类实例、TypedArray——v0 草案会把 `Date` 静默序列化成 `{}`，属实测抓到的类型混淆坑）；
- 数组元素中的 `undefined`（`JSON.stringify` 会静默变 `null`，v0 草案注释声称拒绝但实现漏了——本次冻结改为真拒绝）。

理由：canonical 层的职责是"同一逻辑值恒得同一字节串"，任何静默转换都是把类型错误延迟成哈希失配，必须在入口炸。

### §1.2 对象与键序

- 取对象**自有可枚举字符串键**；symbol 键忽略。
- 值为 `undefined` 的成员**视同缺席**（删除后再序列化）；`null` 是显著值，`null ≠ 缺席`。理由：TS 可选字段传播中 `{ x: undefined }` 与 `{}` 语义等价，若区分则同一逻辑对象两种哈希。
- 键按 **UTF-16 码元序**（ECMAScript 默认字符串比较）升序排列。**禁止 `localeCompare`**——排序结果随环境 locale/ICU 漂移，直接摧毁跨机器确定性。选码元序而非码点序：与 RFC 8785（JCS）一致，且是 JS 默认 `sort()` 行为，零实现成本。
- 递归应用于嵌套结构；数组**保序**（数组顺序是语义）。

### §1.3 数字与字符串

- 数字序列化 = ECMAScript `Number::toString`（ES6 最短往返表示）；`-0` 序列化为 `0`（`JSON.stringify` 语义，附录 A 有断言）。理由：与 JCS 相同的选择，唯一有多语言参考实现的浮点规范化。
- 评分类字段（`mainlineScore` / `confidence` / `activation`）在**进入结构事件前**由生产者调用 `quantizeTreeScoreV2`（`Number(value.toFixed(6))`）量化。理由：把浮点漂移消灭在生产侧，哈希层保持纯粹（只拒绝不修正——canonical 层做量化会让"存的值"与"哈希的值"分叉）。
- 字符串按 `JSON.stringify` 的最小转义规则输出（`"` `\` 与控制字符转义，其余字面输出；孤立代理项按 ES2019 well-formed 模式转义为 `\uXXXX`，确定性成立但生产者不应产出）。
- 哈希输入 = canonical JSON 文本的 UTF-8 字节。

### §1.4 与 v0 草案差异表（本次同批修正代码）

| #   | v0 草案行为                                                                 | 冻结终稿                                                | 动因                                                                  |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| D1  | 节点排序用 `localeCompare`（`hashTreeStateV2` / `toSortedNodes`）           | UTF-16 码元序（`compareCodeUnit`）                      | locale 漂移 = 跨机器异哈希，实测级隐患                                |
| D2  | 值域宽松：`Date`→`{}`、数组内 `undefined`→`null`、`bigint` 裸抛 `TypeError` | §1.1 值域收紧，一律 `VALIDATION` 拒绝                   | 静默转换是哈希毒药；错误要可分类                                      |
| D3  | 创世 `previousEventHash` 未定义（v1 用 `''`）                               | 64 个 `'0'` 哨兵 `TreeDiffGenesisEventHashV2`           | 定宽可加 NOT NULL+长度约束；空串是 falsy 脚枪                         |
| D4  | `event_hash` 只覆盖 `{prev, version, ops}`                                  | 纳入 `baseVersion` 与 `identityChange`（缺省恒 `null`） | 事件自证完整，不再依赖结构旁路校验；S3 落 identity payload 免二次冻结 |

## §2 双哈希（#11 前半，终稿）

架构文档中 `H(domain ‖ …)` 的拼接记法是**非规范示意**；规范形一律是"域字符串作为 canonical 文档的 `domain` 成员"——结构化域分离没有拼接歧义（长度前缀、分隔符注入等问题不存在）。

### §2.1 tree_hash（状态锚点）

```
tree_hash = SHA256( UTF8( canonical({
  domain: "velaros.memory.tree-state.v2",
  nodes:  [...节点按 stableKey UTF-16 码元序升序...]
}) ) )
```

- 节点 = `MemoryTreeNodeStructV2` 全字段（①结构 + ③引用与承诺；无明文正文可覆盖，这正是"擦除后只验证结构"成立的机械原因）。
- 用途：版本锚点校验、物化视图自检、正逆重放的会合点。

### §2.2 event_hash（链式审计哈希）

```
event_hash = SHA256( UTF8( canonical({
  domain:            "velaros.memory.tree-diff.v2",
  previousEventHash: <上一事件 event_hash | 创世哨兵 | base_event_hash>,
  version:           <提交后版本号>,
  baseVersion:       <基线版本号>,
  identityChange:    <身份阶段变化 payload | null>,
  ops:               [...结构事件，保持提交顺序...]
}) ) )
```

- `identityChange` **恒序列化**（无变化时为 `null`，不允许缺席）。理由：缺席 ≡ 成员删除（§1.2），若允许缺席则"没有身份变化"与"旧版本没有该字段"不可区分。
- `ops` 保持提交顺序（顺序是语义，见 §1.2 数组保序）。

### §2.3 创世与措辞纪律

- 链首事件（version 1，baseVersion 0）的 `previousEventHash` = `TreeDiffGenesisEventHashV2`（64 个 `'0'`）。
- **同库存放哈希承诺的是完整性自检（损坏检测），不是抗恶意改写的防篡改**（架构文档措辞纪律原文照抄进规范，任何对外文案不得越权声称）。

### §2.4 压缩再锚定（预冻结，S3 消费）

物化基点的链再锚定哈希：

```
base_event_hash = SHA256( UTF8( canonical({
  domain:                 "velaros.memory.tree-base.v2",
  baseVersion:            <基点版本>,
  treeHash:               <基点状态哈希（§2.1）>,
  priorSegmentEventHead:  <被合并区段末端 event_hash>,
  manifestHash:           <manifest 规范化哈希（manifest 内容规范属 #12，S3 冻结）>
}) ) )
```

被保留区段首个 diff 的 `previousEventHash` 指向 `base_event_hash`。理由：基点哈希绑定"旧链末端 + 新起点状态 + 引用清单"三者，压缩后可证明"基点未损坏、保留链连续"，与架构文档的诚实审计边界一致。

### §2.5 manifest、checkpoint 与压缩执行（S3 冻结）

- **manifest 规范形**：`{format:"velaros.memory.tree-base-manifest.v2", baseVersion, nodeStableKeys, blobRefs, redactedStableKeys, nodeCount, redactedCount}`。`nodeStableKeys` 按 UTF-16 码元序升序；`blobRefs` 取全部非空引用、去重后按同序排序；`redactedStableKeys` 取状态位或可见性为 redacted 的节点并排序；两个计数必须与数组逐字节一致。
- **manifest_hash** = `SHA256(UTF8(canonical({domain:"velaros.memory.tree-base-manifest.v2", manifest})))`。基点 state blob 的规范形为 `{format:"velaros.memory.tree-base-state.v2", baseVersion, nodes, manifest}`，节点按 `stableKey` 同序排列；state 整体经 `ContentKeyServiceV2` 加密，authority 只留 blob 引用、随机承诺与三个哈希锚点。
- **首版压缩只在当前 head 建基点**：先从现行 forward authority 链重建并验证当前状态，再封存 state；同一 SQLite 事务落 `memory_tree_bases` / `memory_tree_compactions`、删除 `≤ head` 的细粒度 diff、收窄旧 snapshot，并把 head snapshot 的事件锚点切到 `base_event_hash`。因为基点后没有既存 diff，绝不需要改写已提交后继事件；下一条新 diff 直接以 `base_event_hash` 为 `previousEventHash`。一年/月度降采样策略由后续调度决定，不自动触发本动词。
- **checkpoint cache 间隔 = 64 个 committed tree version**；当前投影始终随 authority head 更新。checkpoint 与当前投影只含结构 + blob 引用，统一进入 S2 的加密 index generation；它们是可丢弃派生缓存，损坏/缺失/落后时只从 authority forward 链重建。
- **INV-BR 机械化**：forward replay 结果持有进程内 WeakSet 来源证明；非空起点继续正向重放时必须提交上一个已证明 forward 结果。公开读副本、伪造 `direction:"forward"`、backward replay 与把 backward 节点经空 diff “洗白”的结果都不能进入投影/checkpoint/base 写路径；生产持久化模块同时由静态探针禁止调用 `replayTreeDiffsBackwardV2`。

**证明义务兑现（WS3-S3）**：`TreeStore.ts` 以单事务提交 meta CAS + snapshot + diff + frontier，open 时逐版本复算 `event_hash` / `tree_hash` / canonical JSON / 双锚点；`TreeManifest.ts` 与 `TreeProjectionIndex.ts` 落上述基点和加密 checkpoint。`tree-store-v2-probe.ts` 覆盖事务回滚、64 版 checkpoint、head 压缩、基点后再锚定、派生代损坏重建、manifest 篡改拒开与 INV-BR 正负控，由 `check:memory-storage` 编入根门禁。

## §3 随机化承诺构造（#11 之 content_commitment，终稿）

### §3.1 算法

```
nonce      = CSPRNG(32 字节)                    // 每条内容独立
commitment = "c2:" + hex( HMAC-SHA256(
               key = nonce,
               msg = UTF8("velaros.memory.content-commitment.v2") ‖ 0x00 ‖ content_bytes
             ) )
```

- **选 HMAC 而非 `H(salt‖content)`**：隐藏性直接落在 HMAC 的 PRF 性质上（密钥=nonce 不泄露则输出不可区分于随机），绑定性落在 SHA-256 抗碰撞上；裸拼接哈希要自己论证长度扩展与前缀歧义，HMAC 是零论证的 boring 答案。
- **盐长 32 字节**：256-bit 隐藏强度，与 HMAC-SHA256 密钥尺寸对齐；低熵内容（地点 / 偏好 / 短句）的字典枚举在 nonce 不可得时无从谈起。
- 域字符串后接 `0x00` 分隔符：域为固定 ASCII 无 NUL，消除 `msg` 拼接歧义。
- `content_bytes` = blob 信封内的**明文字节原文**：文本内容即 UTF-8 字节；结构化值（Claim value 等）先经 §1 canonical 序列化再取 UTF-8。理由：承诺对象必须与解密所得逐字节同一，不引入第二套"承诺前规范化"。

### §3.2 nonce 归宿与验证

- nonce **只存在于加密 blob 信封内部**（信封格式属 S1；本规范只约束：nonce 有且仅有一份，恢复它的唯一途径是解密 blob）。权威表不存 nonce 的任何投影。
- 验证 = 解密 blob → 取 nonce 与明文 → 重算 HMAC → **常数时间比较**（`crypto.timingSafeEqual`）。
- 密钥（DEK）销毁后：nonce 不可得 → commitment 退化为不可枚举的随机值。**系统在任何界面与 API 上不得声称能验证已删除的原文**。

### §3.3 redact 后的承诺保留语义

- redact 结构事件：`blobRef → null`、`redacted → true`、**`commitment` 逐字节保留**（`validateTreeDiffOpV2` 已强制，改写承诺 = 事件非法）。理由：结构历史 append-only，承诺是历史事件的一部分；保留它使"该位置曾有过一条内容"可审计，而销毁密钥保证它不再泄露任何可验证信息。
- **机械求逆裁决（先遣探针实锤，正式入规范）**：redact 事件求逆后在结构层"恢复"了悬空 `blobRef`，**不满足正向创作事件的语义不变量**（redacted=true 时 blobRef 必须为 null）。因此：
  - 语义校验（`validateTreeDiffOpV2`）**只约束已提交链上的原始事件**；
  - 逆向重建（`replayTreeDiffsBackwardV2`）走 `validateOps: false`，但 **strict 现场一致性核对全程保持**（逐节点逐字节 before 匹配）——重放自检不减档；
  - 逆放产物仅存在于内存重建，**永不落库**（升格为具名不变量，见附录 B.4）。
  - **渲染判据以擦除状态位 / deny-set 为权威，不以「blob 是否已销毁」为准（批 A minor④，收窄安全判据）**：原表述「blobRef 指向已销毁 blob → redacted 占位」把渲染判据挂在**物理销毁**（Erasure Saga 第二段）上，但擦除的权威生效点是**第一段**（权威库单事务提交 redact 结构版本 + 写 `erased` 墓碑 + 落 `memory_erasure_targets` deny-set）。在第一段提交到第二段销毁之间的窗口，blob 仍物理存在——若以「blob 已销毁」为渲染判据，则该窗口内旧内容仍会渲染（尤其重建/回看擦除前的历史树版本时），是隐私泄露。因此渲染层对任一节点是否呈现 redacted 占位，**以擦除状态位（`erased` 墓碑）/ 查询 deny-set（`memory_erasure_targets` + 单调 `deny_generation`，见架构「erased deny 不变量」及删除语义 Erasure Saga 第一段）为唯一权威；blob 物理销毁只是最终态，不是判据**。此条立为 **S6（Erasure Saga 完整状态机）的显式约束**：所有查询面（召回/搜索/聊天/历史回看/诊断/树重建渲染）自第一段提交起即按 deny-set 一致遮蔽，不得等待第二段。

## §4 盲索引 HMAC（#17，终稿）

### §4.1 密钥归属：全局单根，per-purpose 派生，隶属 keyring

```
K_match_root       = CSPRNG(32 字节)          // 安装期生成，keyring 常驻（§7）
K_match(<purpose>) = HMAC-SHA256(K_match_root, UTF8("velaros.memory.match-key.v2:" + purpose))
match_key          = "m2:" + hex( HMAC-SHA256(K_match(<purpose>), UTF8(normalized_input)) )
```

- **归属：全局（per-install），不做 per-scope 密钥**。理由：作用域解析本身依赖 `scope_match_key`（per-scope 密钥先有鸡还是先有蛋），且跨作用域身份归并是产品需求；密钥永不出 keyring，per-scope 切分不改变任何攻破面（攻破粒度是 keyring 整体）。
- **purpose 注册表（v2）**：`concept-name`、`concept-alias`、`scope`、`source-ref`。新增列族 = 新 purpose = 新域字符串，禁止复用。
- 输出**全宽 64 hex 不截断**。理由：等值索引列存储成本可忽略，免去任何截断碰撞论证。

### §4.2 输入归一化（三档 profile，冻结）

| profile           | 适用                             | 规则                                                                                                                                                                                                                                                                                 |
| ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **identity-text** | `concept-name` / `concept-alias` | `NFKC` → `toLowerCase()`（Unicode 默认折叠，**禁 `toLocaleLowerCase`**——土耳其 İ/i 级 locale 漂移）→ 连续非 `[\p{L}\p{N}+#.]` 字符折叠为单空格 U+0020 → `trim()`。与 §5.3 的 `normalizeIdentityTextV2` 同一函数（单源）。保留 `+` `#` `.` 是 P0 先例：剥掉会让 C++ / C# / C 同键错并 |
| **path**          | `scope`（workspace root）        | `NFC`（macOS 文件系统 NFD 与用户输入 NFC 必须会合）→ 去除单个尾随路径分隔符 → **不做大小写折叠**（大小写敏感文件系统上折叠 = 错误归并）→ **不做 NFKC**（兼容折叠会改写真实路径字符）                                                                                                 |
| **origin**        | `scope`（site origin）           | WHATWG `new URL(input).origin`（scheme/host 小写、默认端口省略、IDN punycode 由 URL 标准承担）；opaque origin（`"null"`）拒绝                                                                                                                                                        |

- `source-ref`（URL 等外部标识）：WHATWG URL 解析 → 去 fragment → 标准序列化；不做进一步折叠（query 语义保留）。
- **`scope` purpose 的 HMAC 输入 = `canonical(["<scope_type>", "<normalized_value>"])`**（§1 canonical 的字符串数组形）。理由：workspace 路径与 site origin 的等值类必须隔离，且 canonical 数组无分隔符注入歧义。其余 purpose 输入 = 归一化字符串本身。
- 归一化结果为空串是合法输入（等值类"空"自身一致）；生产者可按配方替换哨兵值（见 §5.3 claim topic）。
- **path 档「不折叠大小写」是密码学层平台无关的刻意选择，不是对 case-insensitive FS 的正确性主张（批 A minor①）**：归一化层保持平台无关（大小写敏感 FS 上折叠 = 错误归并），但默认部署面（macOS APFS / Windows NTFS）是 case-insensitive——同一实体的 `/Users/example` 与 `/Users/example` 若各自原样进归一化会派生出两个 `scope_match_key`（scope 劈裂）。因此对 **S4 采集层立显式约束条款**：**任何路径进入 §4.2 path 归一化前，必须先经采集层 canonical 化——取 FS 权威大小写形（`realpath` / 平台等价的规范化路径），把符号链接与大小写变体收敛到单一权威表示**。归一化层只对已 canonical 化的路径做 `NFC` + 尾分隔符处理；「同一实体双表示进入键派生」的可能在采集层被关死，而非在密码学层引入平台相关折叠。此约束是 S4 ingest 的机械前提，S4 不得把未 canonical 化的原始路径直接喂进 `scope` purpose。
- **identity-text 档 `NFKC` 的等值类实宽于「大小写/标点」，构成一条被 trust-tier 封顶的注入面（批 A minor②，威胁记述，不改算法）**：`NFKC` 是**兼容折叠**，其等值类涵盖远超大小写/标点的形变——`①`→`1`、`ﬁ`→`fi`、全角`Ａ`→半角`A`、上下标、罗马数字合字等大量 compatibility 映射。后果：外部来源（网页标题、第三方文件名、被抓取内容）的实体名可被**构造出 NFKC 碰撞**，令攻击者控制的名称归一化后落入受害实体的等值类（`concept-name` / `concept-alias` 盲索引命中同 `match_key`），实现跨实体的证据/别名注入。缓解**不在归一化层**（折叠是身份归并的刻意语义，改算法即破坏 C++/C#/全角等正当合并）：缓解落在**来源 trust-tier 封顶**——低信任来源产出的名称/别名其 `activation` 与晋升权重受 tier 上限压制，无法凭构造名单独把结论推上主线（与架构 `MemoryDisclosureGateway` / trust-tier 既定裁决同源）。此处只记述威胁边界，算法与域字符串不动。

### §4.3 等值查询语义边界

- **只支持等值**：SQL 对 ② 类列只允许 `=` 与 `IN`。**无前缀、无范围、无 LIKE、无子串**——HMAC 全值哈希在结构上使其不可能，规范在语义上同时禁止（防止实现者退化成"明文影子列"绕道）。S2 将此做成 check 链锁（② 类列的 SQL 使用面机械审计）。
- 等值 = **归一化后等值**：大小写 / 标点差异视为同一等值类是身份归并的刻意语义，不是精度损失。

**证明义务兑现（WS3-S2）**：`AuthoritySchema.ts` / `AuthorityDatabase.ts` 已落独立 `authority.sqlite3` 的 package-owned schema、身份校验和 append-only open/migrate；旧 Desktop 主库不逐行转换、不双写、不建兼容 view。`authority-v2-probe.ts` 机械验证禁止明文列、正文不进入 authority/WAL/blob 明文、盲索引只允许 `=` / `IN`、`stable_key` 无前缀语义、失败迁移零半表与未知/未来库 fail-closed；由 `check:memory-authority` 编入根 `bun run check`。

### §4.4 轮换与失效

- **v2 冻结为不支持在线轮换**。生命周期只有两个事件：安装期创建、全库擦除时销毁。理由：匹配密钥永不离开 keyring；轮换所防御的攻击（拿到 ② 列做离线字典）以持有密钥为前提，而 keyring 攻破意味着 DEK 全失——损失严格更大，轮换不改变结局；轮换成本却是"解密全部原文 + 全表重算"级。未来若需轮换 = 加 key-epoch 列 + 全量重导 = 规范升版。
- **全库擦除**：销毁 `K_match_root` → 全部 ② 类列瞬时整体失效（不可再构造查询哈希，存量值退化为噪声）。**单条擦除**：墓碑事务内清空该行 match_key 列（架构文档既有裁决，引用不重述）。
- 备份语义：② 类列随 authority 进备份（值不可逆，安全）；恢复后能否继续产生**新查询** 取决于 keyring 存活——keyring 永不入备份是既定裁决，本规范不为备份场景开任何密钥旁路。

## §5 stable_key 身份键规则（#4，终稿）

### §5.1 构造：keyed 派生，不是明文哈希也不是纯随机

```
K_identity  = CSPRNG(32 字节)   // 安装期生成，keyring 常驻，永不轮换（轮换 ≡ 全库身份变更 ≡ 禁止）
stable_key  = "k2:" + hex( HMAC-SHA256(
                K_identity,
                UTF8("velaros.memory.stable-key.v2") ‖ 0x00 ‖ UTF8(canonical(identity_segments))
              ) )[0:32]          // 截断 128-bit
```

- **为什么 keyed（HMAC）而不是 v1 的裸 `sha256(归一化文本)`**：stable_key 是 ① 类列，进权威库、进备份、进 diff 链 ops——裸哈希是**可字典验证的明文指纹**（"用户是否有名为 X 的概念"可离线验证），直接违反架构文档"`stable_key` 不可逆随机标识，不由名称派生明文"的意图。HMAC 输出在 `K_identity` 保密时与随机不可区分，同时保住确定性。
- **为什么不是纯随机 id**：写入链幂等（`ON CONFLICT(stable_key)` upsert）、`input_fingerprint` 重试收敛、S4 的"golden 证据集重放逐字节一致"验收全部依赖**同输入恒同键**；纯随机把幂等改写成"先查后插"竞态面 + 重放不可比对。
- **截断 128-bit（32 hex）**：单库实体量级 ≤ 10⁶，生日界 2⁶⁴ 远超需求；键会在 ops payload 中大量复写，减半存储可感。
- `identity_segments` 经 §1 canonical 的字符串数组序列化——无分隔符注入（v1 用 `:` 裸拼接，`scopeId` 含 `:` 即可构造歧义键，本次冻结关死）。

### §5.2 身份段配方（吸收 P0 教训，冻结）

| 实体    | identity_segments                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------- |
| concept | `["concept", conceptType, scopeType, scopeId, normalizeIdentityTextV2(discriminator)]`                    |
| episode | `["episode", scopeType, scopeId, conceptStableKey, episodeRoot, normalizeIdentityTextV2(phase)]`          |
| claim   | `["claim", conceptStableKey, predicate, topicSegment, sha256hex(UTF8(normalizeIdentityTextV2(content)))]` |

- **episode 段含 `conceptStableKey` 是 P0 修复的规范化**：一个 episode 永远只归属其主概念；缺它则同会话同 phase 不同概念的证据撞键 → 主概念被 upsert 顶掉 → 树投影悬空父节点 → Dream 永久卡死（真机复现过的 P0，此处升格为规范不变量）。
- `episodeRoot` = `sessionId ‖ executionId ‖ "<scopeId>:<UTC 日桶>"` 三级回退（沿 v1 语义）。
- claim 的 `topicSegment` = `normalizeIdentityTextV2(标题)`，空串回退哨兵 `"untitled"`（沿 v1）。
- claim 段内层的 `sha256hex(归一化内容)` 是**无密钥**哈希——合法：它只作为外层 HMAC 的输入，**永不落任何列**，不构成明文指纹面。
- **claim 分组键**（v1 靠 stable_key 前缀扫描找竞争 claim，v2 的 HMAC 键无前缀结构，S4 消费）：

```
claim_group_key = "g2:" + hex( HMAC-SHA256(K_identity,
                    UTF8("velaros.memory.stable-key.v2") ‖ 0x00 ‖
                    UTF8(canonical(["claim-group", conceptStableKey, predicate, topicSegment])) ) )[0:32]
```

竞争 claim 检索 = `claim_group_key` 等值查询。**stable_key 是不透明 token，禁止任何前缀 / 子串语义**（规范级禁令，S2 check 锁候选）。

### §5.3 normalizeIdentityTextV2（单源函数，冻结）

```
NFKC → toLowerCase()（Unicode 默认，禁 toLocaleLowerCase）
     → replace(/[^\p{L}\p{N}+#.]+/gu, ' ')（连续段折叠为单空格 U+0020）
     → trim()
```

与 v1 的唯一差异：`toLocaleLowerCase()` → `toLowerCase()`。理由：前者取宿主默认 locale，土耳其语环境 `I → ı`——同一名称跨机器异键，对"键规则 = 身份"的系统是隐性数据分叉。保留 `+ # .` 是 C++/C#/C 碰撞先例的既定裁决。

### §5.4 树节点 stableKey（diff 链层）

| 节点     | stableKey                                                      |
| -------- | -------------------------------------------------------------- |
| 根       | `"root"`                                                       |
| 主干     | `"trunk:" + <identityEpochId>`                                 |
| 实体节点 | `<subjectType> + ":" + <实体 stable_key>`（如 `concept:k2:…`） |

- 实体 stable_key 已是不透明 ASCII token，`:` 拼接无注入面（左侧是受控枚举字面量）。
- 节点身份跨 move / update / merge-源保持不变；uniqueness per tree 由提交期 validator 强制（`validateTreeDiffOpV2` 的事件内查重 + S3 提交校验）。

### §5.5 无兼容承诺（C 案配套，冻结）

> **「C 案」定义框（批 A minor⑦——原为跨 docs 悬空标签，此处补齐权威定义）**
>
> **C 案 = 旧库退役时从权威层 Evidence 重放重灌**，**不是** v1 schema 的逐行数据转换。与架构 clean-break（[memory-tree-product-architecture.md](./memory-tree-product-architecture.md) §「全新 schema 策略」/ 首章"不做 shadow read、双写、旧表数据转换或兼容 adapter"）的接缝写明：**clean break 禁的是 schema 级转换**（旧表结构映射到新表、只读兼容 view、逐行回填）；**C 案走的是重新采集语义**（把旧库权威层的 Evidence 当作事实来源，经新链**重放重灌**，全部 stable_key 从头计算）——二者不冲突，前者禁"搬旧表结构"，后者只"重放旧事实"。三档已拍板，照录：
>
> - **C1 = Evidence 重灌**：从权威层 Evidence 重放，经新键规则（§5.2/§5.3/`K_identity`）从头计算全部 stable_key；活证据重算键、erased 行墓碑原样转录、携带擦除 deny-set（详见下文三条）。
> - **C2 = 治理边车尽力重放 + 残余已知损耗**：治理态（deny-set、privacy generation、eligibility）best-effort 重放；不可无损重建的残余（如已 crypto-shred 内容的细粒度审计）以**已知损耗**记账，不制造虚假审计承诺（与架构远古降采样诚实边界同源）。
> - **C3 = 旧表只读归档无限期**：旧库转**只读归档、无限期保留**；真正 `drop` 旧表**押真机验收 + 用户明示签字**双闸门，未签字不删。
>
> 本框只补定义，不改任何键规则或字节语义。

**键规则变更即身份变更**。Evidence 重灌（迁移 C 案，已拍板）时全部 stable_key 经新链**从头计算**；v1 键与 v2 键之间**没有任何映射、翻译或兼容承诺**——v1 键是明文派生哈希，把它带进 v2 等于把明文指纹背进新库。本节配方 + §5.3 归一化 + `K_identity` 三者共同构成键身份；未来任何一处变更 = 重灌级迁移，不存在原位换键。

- **"从头计算"的定义域 = 存活（非 erased）行**。已 crypto-shred 的 erased 墓碑**不参与重算**：其明文内容已销毁，§5.2 claim 配方内层 `sha256hex(normalizeIdentityTextV2(content))` 物理上算不出键；erased 行以**墓碑原样转录**（保留结构位与 redacted 占位，不重派生键）。把 erased 纳入"全部从头计算"是自相矛盾的（对抗校验批 A 分支 B 实锤）。
- **重灌必须携带擦除 deny-set（crypto-shred 不变量的跨库延续）**。架构第 842 行"擦除 Claim 时默认不反向擦除仍支撑其他 Claim 的 Evidence"⇒ 被擦内容的来源证据可存活；若重灌对存活证据重跑 curation 而不设防，会以新键新内容**再生成已擦结论**，击穿"erased 永不再现"的立系不变量（批 A 分支 A）。因此：重灌把擦除闭包的 normalized identity targets 与单调 `deny_generation`（架构 §擦除 deny 不变量、第 1491 行）**一并迁入新库**，候选写回经该 deny-set 过滤（与 §6.3 I5 同一机制的跨库版）；命中 deny-set 的再生成候选被压制，不得落库。新库首个 `deny_generation` ≥ 迁入闭包的代号。
- 一句话：重灌重算的是**活证据的键**，携带的是**死内容的墓碑与 deny-set**；两者不混。此条是 S6（Erasure Saga 完整状态机）与 C 案重灌的接缝约束，S7 消费时不得另设第二套语义。

## §6 ingest_sequence / frontier 语义（#15，终稿）

### §6.1 ingest_sequence 单调性

- 每条 Evidence 在**采集事务内**获得 `ingest_sequence`：来自 authority 库 meta 计数器（键 `evidence_ingest_sequence`），同事务 `+1` 并写入行。起始 1，64-bit 整型。
- **严格单调、永不复用**：删除 / 擦除不回收序号（墓碑行保留其序号——① 类结构字段，擦除不清）。理由：MAX(seq)+1 在删行后会复用序号，重放语义与 frontier 前缀性即刻被毒化；meta 计数器是零聪明的正确解。
- `ingest_sequence` 是**到达序**，与 `occurred_at`（事件时间）无任何次序承诺；frontier 与增量整理**只认 ingest_sequence**。
- **前置不变量：数据根单写者**（kernel 边界判决既定）：采集与 Dream 序列化在同一写者上，读取时刻 `≤ frontier 上界`的序号段**无空洞**。多进程写者不在 v2 范围；若未来出现，本节整体重审。
- Evidence 重灌（C 案）：旧行按旧序**重新连续编号**，只承诺保序，不承诺保值；新库 frontier 从 0 起步。跨库序号无任何等同语义。

### §6.2 frontier：已消化前缀水位

- `dream_frontier`（meta 键，沿 v1 命名）= 单值水位 S：**seq ≤ S 的全部 Evidence 已被整理管线"考虑过"**。
- "考虑过" ≠ "产出过"：eligibility 不合格（`excluded` / `source_deleted` / `erased`）的行被跳过但**照常计入水位**。理由：否则一条不合格证据永久卡死 frontier（无空洞前缀性不允许跳号），frontier 再不推进。
- **但"跳过即无回补义务"只对终态成立，三态不可一刀切**（对抗校验批 A 序列层缺口整改）：
  - `erased` 是**内在终态**（彻底清除墓碑，无 reactivate），其被跳过后确无回补义务——原论证只覆盖此态。
  - `excluded`（用户排除，可撤销的产品开关）与 `source_deleted`（来源已删，来源恢复即可逆）**不是终态**。若其 `seq=N` 被跳过、frontier 越过 N 之后来源被重新纳入，naive 地"原地翻回 active"会因 §6.3 I2（只进不退）使 N 永在水位之下 = **永久漏整理（静默数据丢失）**。
- **复活即再采集（frontier 之下不原地复活）**：`excluded` / `source_deleted` 的撤销**不得**把水位之下的旧行原地翻回 active 供整理；撤销走**再采集**——为该证据分配**新的 `ingest_sequence`（严格高于当前 frontier，§6.1 永不复用序号）**，以新行重入未来批次。旧行保留其序号与不合格态（① 类审计位）。§5 的 keyed 确定性键 + I4 幂等使再采集经 `ON CONFLICT` 收敛到同一组实体，不产生重复。此条冻结为 §6.3 的 **I6**，是水位"跳过无回补"对可逆态成立的充要前提。
- 批次读取 = `seq ∈ (frontier, frontier + batchSize]` 按序号升序；缩批退避只缩 `batchSize`，不改变语义。空批（无新证据）不产生 run、不动水位。

### §6.3 推进规则与孤儿回收（与 S4 CAS 的关系，冻结为六条不变量）

- **I1 原子推进**：frontier 推进、树版本推进（diff + snapshot 落库）、run 状态翻转为 `committed`，**同一 SQLite 事务**。任何失败路径三者全不动。
- **I2 只进不退**：`frontier_after = max(frontier_before, 本批末序号)`；frontier 在任何恢复 / 回收 / 重算路径上不允许回退。
- **I3 孤儿回收零副作用**：启动扫描把 `running` / `validating` 孤儿 run 标 `failed`——**只翻 run 状态**，不动 frontier、不动树版本、不动链（由 I1，孤儿必然没提交过任何一项）。物化视图哈希自检失配时从 diff 链重放重建（架构既定）。
- **I4 幂等重试**：同一 frontier 区间 + 同证据集 + 同模型档 + 同管线版本 ⇒ 同 `input_fingerprint`（§6.4）；已存在 `committed` 同指纹 run ⇒ 直接 skip（沿 v1）；重算经 §5 的 keyed 确定性键收敛到同一组对象，不产生重复实体。
- **I5 与擦除的会合**：redact 是推进树版本的结构事件（架构既定）⇒ 进行中 run 的版本 CAS 必然失败 ⇒ 重算 / 受限 rebase 走 deny 过滤，被擦内容无法经候选写回。frontier 不参与该闭环（被擦证据已按 §6.2 计入水位且不再可整理）。
- **I6 复活即再采集（水位之下不原地复活）**：`excluded` / `source_deleted` 是可逆态；其撤销**不得**把 frontier 之下的旧行原地翻回 `active` 供整理，必须**再采集**——分配严格高于当前 frontier 的新 `ingest_sequence`，以新行重入未来批次（详见 §6.2）。旧行保留原序号与不合格态。此不变量是 §6.2"跳过无回补"对**非终态**（`erased` 之外）成立的充要前提；缺它则一条可逆态证据在水位之下被静默永久漏整理。`erased` 是内在终态，不适用本条。

### §6.4 input_fingerprint（公式冻结）

```
input_fingerprint = "f2:" + hex( SHA256( UTF8( canonical({
  domain:          "velaros.memory.dream-input.v2",
  frontierBefore:  <number>,
  evidenceIds:     [...本批证据 id，按 ingest_sequence 升序...],
  modelProfile:    { provider: <string|null>, model: <string|null> },
  pipelineVersion: <number>   // 整理管线语义版本，S4 起 1
}) ) ) )
```

无密钥合法：输入全部为内部随机 id 与枚举，无明文语义面。`pipelineVersion` 纳入指纹：管线语义变更后旧指纹自然失效，防"同输入不同管线"的假幂等。

**证明义务兑现（WS3-S4）**：`IdentityKeys.ts` 是 §4 / §5 / §6.4 的单源实现；`EvidenceIngest.ts` 在密文先落盘后以单 SQLite 事务分配连续 `ingest_sequence`、登记 blob 并写 Evidence，workspace 路径先经 `realpath` 收敛；`DreamRuns.ts` 与 `TreeStore.ts` 将 run `committed`、frontier 与树版本 CAS 放入同一事务，并为零候选批提供不伪造空 diff 的原子 no-op 提交。`ingest-dream-v2-probe.ts` 覆盖 I1–I6、可逆态再采集、fingerprint 重试、事务点 CAS 回滚、孤儿 run/blob 恢复与密文按需解封共 **65 条断言**，由 `check:memory-storage` 编入根门禁。

**证明义务兑现（WS3-S5）**：authority migration 2 追加 `memory_concept_evidence` / `memory_episode_evidence`，补齐 Concept、Episode、Claim、Relation 四类意义对象的 Evidence 谱系；`MeaningCuration.ts` 不接受模型提供的存储 id，而是重算稳定键、盲索引、信任上限、密文正文与树投影。仅由 `external_content` 支撑的用户画像候选机械拒绝，普通 Claim 封顶为 `inferred / 0.4`，敏感 Claim 必须有 `user_stated` 或 `system_observed` 支撑。意义对象、Identity Epoch、projection diff、frontier 与 run 状态通过 tree authority participant 同事务发布。`meaning-curation-v2-probe.ts` 以 **43 条断言**覆盖信任降级、谱系闭合、稳定键强化收敛、正文零落库、重开重放与 CAS 零半提交；authority 探针另覆盖 v1→v2 追加迁移。

**证明义务兑现（WS3-S6）**：`ErasureSaga.ts` 以 canonical closure digest 锁定确认范围。第一段把单调 `privacy_generation`、normalized deny targets、Evidence/意义对象墓碑、只含 redact（必要时附中性 Identity 替代）的新树版本放入同一事务；被删除内容支撑当前 Identity 时，同版本结束旧 epoch、清空其正文并建立不含用户内容的中性主线，避免 active mainline 悬空。第二段幂等销毁 closure 内全部 per-blob DEK 与物理密文，重建/验证加密 projection generation 后才把 saga 标为 `verified`；Candidate Ledger 通过结构化 `readSet` 同样进入闭包。`erasure-saga-v2-probe.ts` 以 **73 条断言**覆盖即时 deny、墓碑与版本同事务、Identity 替代、候选账本闭包、crypto-shred、targets 退役后的基表兜底、幂等恢复，以及 Evidence 尚未投影时的空树擦除。

**证明义务兑现（WS3-S7，切权仍锁定）**：`EvidenceReplayMigration.ts` 只以 SQLite
`readonly + query_only` 打开旧库，按旧 `ingest_sequence` 重灌存活 Evidence，并把 erased 行写为
无正文/无承诺墓碑；新库通过 migration 3 单独记录 replay ledger 与治理边车，旧表不改、不删。
forgotten / superseded / erased Claim 不继承旧 stable key，而是用 `K_identity` 派生不含标题的
`d2:` normalized governance target，单调推进 `privacy_generation`，并在
`MeaningCuration.ts` 候选写回前机械拒绝命中的结论；无法归一化的项以固定 reason code 进入
known-loss 账本，不写入旧明文。`evidence-replay-v2-probe.ts` 以 **59 条断言**覆盖逐条解密
parity、旧序保序/新序连续、治理 deny 防复活、幂等重跑、五根明文零落盘及旧库逐字节只读。
`mappingDigest + governanceDigest` 共同进入 `verificationDigest`；切权判定器只有在 parity 为零差异、
真机回执和用户签字都绑定同一摘要时才返回 ready。当前实现**没有切换 Desktop 权威指针，也没有
drop 旧表**；C3 的只读无限期归档与“双闸门前不删”继续生效。

**证明义务兑现（WS3-S8，查询能力已落地但未切权）**：`SystemRuntime.ts` 是 Memory v2
package-owned 组合根，宿主只注入 data root、OS wrapping root 与可选时钟；authority、keyring、
blob、Evidence、Dream、Meaning、Erasure、Replay 和 Query 的生命周期均由包内持有，公开面不含
Desktop 权威切换或旧表 drop 动词。`QueryFacade.ts` 的同步 `recall` 只读已提交树和显式后台刷新
出的进程内 index，零模型、零远程网络；index 缺失或按 `snapshot version + privacy_generation`
判断陈旧时，只确定性降级到当前主线路径。普通搜索不索引 sensitive 节点，只解密最终 top-K
路径；结构投影不解密正文，branch recall 也必须先过 normalized deny-set。
`query-runtime-v2-probe.ts` 以 **46 条断言**覆盖空库/重开组合根、显式刷新、主线降级、谱系、
敏感默认模糊/授权解密、擦除第一段即时 deny、双键缓存失效与启动续跑，由
`check:memory-storage` 编入根门禁。当前实现仍**没有切换 Desktop 权威指针，也没有 drop 旧表**。

## §7 五物理根布局命名 + keyring 代际文件骨架（#6，终稿）

### §7.1 目录与文件命名（冻结）

```text
<dataRoot>/memory/
  authority/
    authority.sqlite3            # 权威库（+ -wal / -shm 同名派生）
  blobs/
    <blob_id 前 2 hex>/<blob_id>.blob   # 密文信封；blob_id = 32 hex 随机（128-bit CSPRNG）
  keyring/
    generation-<n>.keyring.json  # 代际密钥环（§7.2）
    CURRENT                      # 生效代标记：内容为十进制 <n>；原子换代协议见下
  index/
    generation-<n>/              # 派生索引代际（FTS / 向量 / 树投影物化视图 / checkpoint cache）
    CURRENT                      # 同上
  backup/
    <UTC 时间戳 ISO8601 basic>/  # 只含 authority/ + blobs/ 的副本，物理上不可能含 keyring / index
```

- **`blob_id` 必须随机，禁止内容寻址**：content-addressed id 是明文派生指纹（同一内容跨行同 id 即泄露等值关系），与 §3 的随机化承诺原则同源。两级 hex 分片防单目录膨胀。
- `CURRENT` 标记文件 + rename 的原子换代协议（写新代 → fsync → 原子改写 CURRENT → 删旧代；任一步崩溃可由 CURRENT 判定生效代恢复），authority 之外的两个代际根（keyring / index）共用同一协议。理由：与架构文档 keyring 换代协议同构,一个协议两处用,不发明第二种原子性。
- 创建：五根由包内 `open` 动词按需建目录（S2）；清理：旧开发库不迁移（架构"全新 schema 策略"既定），backup 保留策略产品层裁决，不在本规范。
- **静态加密选型（WS3-S2，#16）**：派生 index generation 采用等价文件级 AES-256-GCM 代际信封，不采用 SQLCipher。索引只在内存构建，完整代序列化后先原子写密文信封并 fsync，再切 `CURRENT`；磁盘上禁止明文 SQLite/WAL/临时文件。每代密钥仍由 keyring `indexGenerations` 持有，旧代清理后销毁对应密钥。实现与 GCM 篡改/零明文落盘探针见 `storage/IndexGenerationStore.ts` 和 `authority-v2-probe.ts`。

### §7.2 keyring 代际文件格式骨架（S1 消费）

```jsonc
{
  "format": "velaros.memory.keyring.v2", // 严格校验，未知格式拒开
  "generation": 7,
  "createdAt": 1753300000000,
  "wrappingRootId": "wr-<hex>", // OS 安全存储中 wrapping root 的引用 id
  "keys": {
    "identity": "<wrapped>", // K_identity（§5）——永不轮换
    "matchRoot": "<wrapped>", // K_match_root（§4）——永不轮换
    "indexGenerations": { "<n>": "<wrapped>" }, // index 代际静态加密键
    "contentDeks": { "<blob_id>": "<wrapped>" }, // per-blob DEK
  },
  "integrity": "<sha256 hex of canonical(除本字段外全文)>", // 损坏检测（非防篡改，与 §2.3 措辞一致）
}
```

- `<wrapped>` = base64(wrapping root 加密后的 32 字节密钥)。机密性全部来自 wrapping（信封由 OS 安全存储守护），容器选 JSON：文件小、整文件原子重写模型、可诊断；二进制格式在此没有换取任何安全收益。
- **严格 parse**：未知顶层字段 = 拒绝加载。密钥文件的宽容解析是伪造注入面。
- 擦除剔除协议、代际保留数、与 storage generation 的成对回滚约束沿架构文档（S1 实现细化），本骨架只冻结**文件形态与字段命名**，S1 不得另起格式。
- **证明义务兑现（WS3-S1）**：`packages/memory/src/memory-tree/v2/storage/` 已落地换代/剔除机制与 `storage-v2-probe.ts`。探针在写新代→fsync→原子改写 CURRENT→删旧代的 **10 个原子步骤**前逐点注入崩溃，验证 CURRENT 判定的生效代恢复无损、已擦 DEK 不在任一存活代际残留且二次重开不复活；连同五根布局、备份隔离、严格 parse、GCM 篡改、root 轮换与 crypto-shred 共 **136 条冻结断言**，由 `bun run check` 链的 `check:memory-storage` 机械复跑。
- keyring 根整体**永不复制、永不入备份**（架构既定，重申为骨架约束）。

## §8 DiffChain v0 → 冻结版修订记录

本次 S0 同批落地的代码修订（`packages/memory/src/memory-tree/v2/DiffChain.ts`），即 §1.4 差异表 D1–D4 的实现：

1. `hashTreeStateV2` / `toSortedNodes` 排序改 `compareCodeUnit`（D1）。
2. `sortValue` 值域收紧 + `isPlainRecord` 原型检查 + 数组内 `undefined` 显式拒绝（D2）。
3. 新增导出 `TreeDiffGenesisEventHashV2`（D3）。
4. `hashTreeEventV2` 签名纳入 `baseVersion` 与可选 `identityChange`（恒序列化，缺省 `null`）（D4）。

v2 层零接线、零落库数据，修订无迁移面。

**回归门兑现物**（返修批 A：原冻结以现在时声称的探针不在库，此次补齐）：逐字节探针 `packages/memory/src/memory-tree/v2/treediff-v2-probe.ts` 固化附录 A fixture + 双锚点，**46 断言基线**（§1.1 值域拒绝 12 + 错误可分类 1 + §1.2/§1.3 canonical 向量 9 + 量化 3 + 创世哨兵 2 + §2.1 tree_hash 5 + §2.2 event_hash 7 + §3/§8 正逆重放·redact 7）。由 `bun run check` 链的 `check:memory-anchors`（`scripts/checks/memoryTreeDiffProbe.mjs`，走 `bun --conditions=source` 吃 TS 源）机械复跑，锚点/canonical 失配即判退——替补退役的 `check:schemas` 对本冻结面的锁位。附录 A.2 锚点为由本参考实现复算的当前金标（原冻结的 `9e1d…`/`da8f…` 是字段值未提交、不可复算的占位，已更正）。

## 附录 A：跨版本 fixture（探针逐字节断言）

任何触碰 §1/§2 的实现变更必须先过本 fixture；fixture 失配 = 规范破坏，不是"更新期望值"的理由。

**A.1 canonical 行为向量**

| 输入                                            | canonical 输出                                |
| ----------------------------------------------- | --------------------------------------------- |
| `{ b: [1, {y: null, x: 'é'}], a: -0, Z: true }` | `{"Z":true,"a":0,"b":[1,{"x":"é","y":null}]}` |
| `{ a: 1, b: undefined }`                        | `{"a":1}`                                     |
| `new Date(0)` / `10n` / `[undefined]` / `NaN`   | 一律 `VALIDATION` 抛错                        |

（`Z` 排在 `a` 前 = 码元序而非字典序 / locale 序的可见证据；`-0` → `0`。）

**A.2 状态与事件哈希向量（全字段 fixture，可纯从本文档复算）**

固定双节点树（root + leaf），全 14 字段冻结如下；本 fixture 与探针 `treediff-v2-probe.ts` 的 `TreeDiffV2ProbeFixture` 同源。锚点 = 下列 canonical 字节的 UTF-8 `SHA256`（小写 hex），可脱离代码手工复算（对抗校验批 A 的 D1 缺口整改：原冻结只给 leaf 两字段、其余 11 字段委托给不在库的探针，无法复算）。

| 字段                 | root 节点       | leaf 节点                                     |
| -------------------- | --------------- | --------------------------------------------- |
| `stableKey`          | `root`          | `concept:k2:00ff00ff00ff00ff00ff00ff00ff00ff` |
| `parentKey`          | `null`          | `root`                                        |
| `nodeType`           | `root`          | `concept`                                     |
| `namespace`          | `root`          | `concept`                                     |
| `subjectType`        | `root`          | `concept`                                     |
| `subjectId`          | `root`          | `k2:00ff00ff00ff00ff00ff00ff00ff00ff`         |
| `content.blobRef`    | `null`          | `0011223344556677889900aabbccddee`            |
| `content.commitment` | `c2:` + `00`×32 | `c2:` + `ab`×32                               |
| `content.redacted`   | `false`         | `false`                                       |
| `mainlineScore`      | `1`             | `0.5`                                         |
| `confidence`         | `1`             | `0.75`                                        |
| `activation`         | `1`             | `0.25`                                        |
| `firstSeenAt`        | `1700000000000` | `1700000000000`                               |
| `lastActiveAt`       | `1700000000000` | `1700000000000`                               |
| `visibilityState`    | `active`        | `active`                                      |

事件：`previousEventHash` = 创世哨兵（64 个 `0`），`version` 1，`baseVersion` 0，`identityChange` 缺省（恒序列化为 `null`），`ops` = `[add root, add leaf]`（保序；各 op 为 `{type:"add", before:[], after:[<节点>]}`）。

**tree_hash（§2.1）**——`hashTreeStateV2` 先按 `stableKey` 码元序排序节点（`concept:…` < `root` ⇒ leaf 在前），再取域文档 canonical。被哈希 UTF-8 字节：

```text
{"domain":"velaros.memory.tree-state.v2","nodes":[{"activation":0.25,"confidence":0.75,"content":{"blobRef":"0011223344556677889900aabbccddee","commitment":"c2:abababababababababababababababababababababababababababababababab","redacted":false},"firstSeenAt":1700000000000,"lastActiveAt":1700000000000,"mainlineScore":0.5,"namespace":"concept","nodeType":"concept","parentKey":"root","stableKey":"concept:k2:00ff00ff00ff00ff00ff00ff00ff00ff","subjectId":"k2:00ff00ff00ff00ff00ff00ff00ff00ff","subjectType":"concept","visibilityState":"active"},{"activation":1,"confidence":1,"content":{"blobRef":null,"commitment":"c2:0000000000000000000000000000000000000000000000000000000000000000","redacted":false},"firstSeenAt":1700000000000,"lastActiveAt":1700000000000,"mainlineScore":1,"namespace":"root","nodeType":"root","parentKey":null,"stableKey":"root","subjectId":"root","subjectType":"root","visibilityState":"active"}]}
```

```text
tree_hash = 560d5c3c9fc1be42df6366f68ca3cd45ea3536a77789c4d021dd6bfe89bab988
```

**event_hash（§2.2）**——`ops` 保提交序（不排序）。被哈希 UTF-8 字节：

```text
{"baseVersion":0,"domain":"velaros.memory.tree-diff.v2","identityChange":null,"ops":[{"after":[{"activation":1,"confidence":1,"content":{"blobRef":null,"commitment":"c2:0000000000000000000000000000000000000000000000000000000000000000","redacted":false},"firstSeenAt":1700000000000,"lastActiveAt":1700000000000,"mainlineScore":1,"namespace":"root","nodeType":"root","parentKey":null,"stableKey":"root","subjectId":"root","subjectType":"root","visibilityState":"active"}],"before":[],"type":"add"},{"after":[{"activation":0.25,"confidence":0.75,"content":{"blobRef":"0011223344556677889900aabbccddee","commitment":"c2:abababababababababababababababababababababababababababababababab","redacted":false},"firstSeenAt":1700000000000,"lastActiveAt":1700000000000,"mainlineScore":0.5,"namespace":"concept","nodeType":"concept","parentKey":"root","stableKey":"concept:k2:00ff00ff00ff00ff00ff00ff00ff00ff","subjectId":"k2:00ff00ff00ff00ff00ff00ff00ff00ff","subjectType":"concept","visibilityState":"active"}],"before":[],"type":"add"}],"previousEventHash":"0000000000000000000000000000000000000000000000000000000000000000","version":1}
```

```text
event_hash = db13996682f4b41248df3e3bb7b34d9cc6f3a676ce6c10b8bc58432ac89a9d1e
```

（更正记录：原冻结的 `9e1d6f79…` / `da8f08f9…` 由字段值从未提交的 fixture 得出，不可复算，本次返修作废；上列为参考实现 `DiffChain.ts` 的真实复算值，`check:memory-anchors` 门逐字节锁定。此更正仅恢复文档—代码—探针一致，**不改任何域字符串或被哈希字节布局，非 `.v2`→`.v3` 语义变更**。）

## 附录 B：诚实边界备忘（对抗校验批 A 的自认清单）

1. **`-0` 语义归一**：`-0` 哈希为 `0`，往返后符号位丢失——对评分与计数字段无语义损失，规范以"值域内 `-0 ≡ 0`"为立场，不视为缺陷。
2. **盲索引的固有泄露面**：② 类列暴露等值类结构（同键行数、分布），`claim_group_key` 同理暴露 (concept, predicate, topic) 分组基数——这是"可等值查询"的定义性代价，威胁模型承认而非掩盖；缓解 = 密钥在 keyring、列值不可逆。**披露对称性补记（批 A note③）**：① 类的 `stable_key` 同样暴露 join 等值类（同键即同实体，行间可据此连接），不是"只有 ② 类列泄露等值结构"。但泄露面对两类观察者不对称——对**非持钥者**，`stable_key` 是与随机不可区分的**代理键基线**（`K_identity` 保密时 HMAC 输出不可逆，只能看出"这些行属同一实体"，看不出实体是谁）；对**持钥者**，其泄露与不可轮换风险坍缩于本备忘 **B.3**（`K_identity` 全损即身份派生能力同死，与 DEK 全失同一事件）。故 ① 类等值可 join 是刻意保留的幂等/重放地基（§5.1），不构成超出 B.3 的新增泄露面。
3. **`K_identity` / `K_match_root` 单点不可轮换**：keyring 全损时身份派生与盲索引查询能力同死——但同一事件中 DEK 亦全死（正文全失），键能力损失不是新增的失败模式；降级路径 = 全库擦除 + 重灌。
4. **逆向重建的 `validateOps:false` 通道**：只豁免语义词表校验，strict 逐字节现场核对不豁免，且逆放产物永不落库——不构成绕过词表约束写入的口子。**具名不变量 INV-BR（批 A note⑤——从"调用方纪律"升格为机械前提）**：**任何持久化写路径禁止消费 `replayTreeDiffsBackwardV2` 的输出**。逆放产物（求逆后"恢复"的悬空 blobRef 等，见 §3.3）**只存在于内存重建视图**，是审计/展示用的临时投影，不满足正向创作事件的语义不变量（redacted=true 时 blobRef 必须为 null）；任何 diff 落库、快照物化、候选写回、索引/物化视图重建的写入侧一律以正向重放或提交期事件为源，不得以 backward 重放输出为源。此为 S3+ 接线时的机械前提（写路径的源必须是正向链，不是逆放视图），非仅调用方自觉；S3 落地时应把此不变量做成写路径的机械断言候选。
5. **单写者前提**：§6 的无空洞前缀性以数据根单写者为前提（kernel 判决既定）；该前提失效的场景（多进程）在 v2 显式出界。

### 批 A blocker/major 返修处置账（2026-07-24 二轮）

对抗校验批 A 五条 major 全部成立，已在正文闭合，此处留账（不是遗留缺口，是"改了什么/改在哪"的索引）：

- **B-A①③ 探针不在库 + 锚点不可复算（crypto/consistency）**：原冻结以现在时声称的 `treediff-v2-probe.ts` 与"32+ 断言复跑"在库/git 全历史中从不存在，锚点 `9e1d…`/`da8f…` 的 11 个节点字段值未提交、无法复算，且所引 `check:schemas` 已同日退役 ⇒ D1 类漂移无门可拦。**处置**：① 落地探针 `treediff-v2-probe.ts`（46 断言，附录 A fixture 同源）；② 附录 A.2 补全 14 字段 fixture + 被哈希 canonical 字节，锚点更正为真实复算值 `560d…`/`db13…`，可脱离代码手工 `SHA256` 复算；③ 新增 `check:memory-anchors` 门编入 `bun run check` 链，替补 `check:schemas` 在本冻结面的锁位。密码学构造本身经批 A 独立验证健全，本组是落地/完整性缺口，非构造缺陷。
- **B-A②④ frontier 终态前提三态一刀切（crypto/lifecycle）**：§6.2"跳过即计水位、无回补"的终态论证只覆盖 `erased`；`excluded`/`source_deleted` 是可逆态，其水位之下的复活在 I2 只进不退下永久漏整理。**处置**：§6.2 拆分三态（仅 `erased` 内在终态），冻结"复活即再采集"——可逆态撤销走再采集（新 `ingest_sequence` 高于 frontier），并升格为 §6.3 **I6** 不变量。
- **B-A⑤ C 案重灌不携带擦除态（lifecycle）**：§5.5"全部 stable_key 从头计算"对 erased 行两个分支都不成立（存活证据重导致擦除内容复活 / 无内容行算不出键）。**处置**：§5.5 补三条——"从头计算"定义域收窄为存活行；erased 以墓碑原样转录不重派生键；重灌携带擦除 deny-set（跨库延续 crypto-shred 不变量，与 I5 同机制）压制再生成。

> 上述三组更正均**不动**任何 `.v2` 域字符串或被哈希字节布局：①是文档—代码—探针一致性补齐，②④是 §6 序列层正确性补漏，⑤是 §5.5/§6.1 迁移—擦除接缝补漏。故不触发 `.v2`→`.v3` 语义版本推进。

### 批 A minor/note 处置账（2026-07-25 三轮）

批 A 遗留 8 条 minor/note + 1 条 §7.2 证明义务标注，逐条处置如下（均**不动** §1/§2 任何算法/字节语义，`check:memory-anchors` 46/46 保持绿）：

| #   | 评审条目（档）                                                       | 裁决                                 | 处置落点                                                                                                                                                                      |
| --- | -------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | §4.2 path 大小写折叠反向（minor）                                    | **修订**（采纳裁决方向）             | §4.2 新增 S4 采集层显式约束：归一化层保持平台无关不折叠；路径进归一化前必须先经采集层 `realpath`/FS 权威大小写 canonical 化，双表示在采集层收敛，不在密码学层引入平台相关折叠 |
| 2   | §4.2 NFKC 威胁刻画不完整（minor）                                    | **修订**（补威胁记述，不改算法）     | §4.2 新增威胁记述：NFKC 兼容折叠等值类宽于大小写/标点（`①→1`/`ﬁ→fi`/全角），外部来源可构造碰撞注入；缓解落 trust-tier 封顶而非归一化层                                        |
| 3   | stable_key 等值类披露不对称（note）                                  | **修订**                             | 附录 B.2 补句：`stable_key` 同样暴露 join 等值类；对非持钥者=随机代理键基线，对持钥者坍缩于 B.3                                                                               |
| 4   | §3.3 渲染判据窄于安全判据（minor）                                   | **修订**（采纳）                     | §3.3 渲染判据改以擦除状态位/deny-set 为权威（销毁只是最终态），交叉引用架构 erased deny 不变量，立为 S6 显式约束                                                              |
| 5   | B.4 逆放产物永不落库是调用方纪律（note）                             | **修订**（升格）                     | 附录 B.4 升格为具名不变量 INV-BR：任何持久化写路径禁止消费 backward 重放输出；S3+ 机械前提 + 断言候选                                                                         |
| 6   | g2 前缀注册表交叉引用错（minor）                                     | **修订**                             | §0 前缀注册表 `g2:` 行「§5.4」→「§5.2」（`claim_group_key` 实定义处）                                                                                                         |
| 7   | 「C 案」悬空标签 + clean-break 张力（minor）                         | **修订**（补定义框，照录已拍板三档） | §5.5 补 C 案定义框：从权威层 Evidence 重放重灌（非 schema 转换，与 clean-break 接缝写明）；C1 重灌/C2 边车尽力重放+已知损耗/C3 旧表只读归档、drop 押真机验收+用户签字         |
| 8   | 架构 event_hash 公式漂移（note）                                     | **修订**（加指针注，不重写正文）     | 架构第 1087 行加规范权威指针注：`event_hash` 覆盖字段以 spec §2.2（§1.4 D4）为准，4 字段示意已扩 6 字段                                                                       |
| +   | §7.2 keyring「已擦 DEK 跨代际剔除/换代崩溃可恢复」断言未证明（note） | **修订并兑现**                       | §7.2 先将证明义务钉给 S1；现由存储实现 + 10 崩溃点 / 136 断言探针兑现，并编入 `check:memory-storage`                                                                          |

八条无一驳回——均为文档一致性/威胁记述/接缝补齐/交叉引用级修订，不触及冻结的算法与字节布局，故不构成 `.v2`→`.v3` 语义变更。**门结果：`check:memory-anchors` 46/46 逐字节一致（改前改后均绿）。**

> 精确文件清单（供 `--only`）：`docs/memory-tree-spec-freeze.md`（条目 1–7 + §7.2 标注 + 本处置账）、`docs/memory-tree-product-architecture.md`（条目 8 指针注，第 1087 行）。两文件均未 stage/commit。
