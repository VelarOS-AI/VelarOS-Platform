# 记忆树第三轮独立评审报告

> 结论：`NEEDS REVISION`
> 日期：2026-07-13
> 范围：第二轮修订 1（TreeDiff 权威）、2（彻底清除）、8（并发与提交），并补充首次告知、场景走查与跨文档一致性检查
> 纪律：本报告只审查，不修改需求基线或候选架构正文

## A. 总体结论

第二轮修订抓住了原方案最重要的缺口，单树、九对象、TreeDiff 历史、受限清除和 CAS 方向均成立。但当前仍有两项 P0：跨 SQLite / FTS / LanceDB / 缓存的“单事务彻底清除”不可实现；保留明文派生哈希并直接改写历史 diff，无法同时满足不可恢复和可验证审计。修正后可进入工程 RFC。

## B. 阻塞问题

| 严重级别 | 问题 | 证据位置 | 为什么危险 | 建议修正 | 阻塞什么 |
| --- | --- | --- | --- | --- | --- |
| P0 | “彻底清除”被描述为跨存储单事务，但 SQLite/FTS 与 LanceDB 不共享事务域 | `memory-tree-product-architecture.md:822`；当前 `packages/memory/src/memory/domain/Mutation.ts:160-163`、`storage/Repository.ts:39-47` | 崩溃或 LanceDB 删除失败后，UI 可能显示已清除，但向量、缓存或日志仍残留；现有实现已经证明两库只能顺序协调 | 改为持久化 Erasure Saga：SQLite 事务先写 tombstone、闭包、redaction event、查询 deny-set 和任务状态；随后幂等清理 LanceDB/缓存/日志并验证。所有查询立即按 tombstone 过滤，只有验证完成才显示“已彻底清除” | R-021 隐私承诺、`eraseMemory` API、发布门槛 |
| P0 | 直接保留“内容哈希指纹”并改写历史 diff，不能证明内容不可恢复，且与 `payload_hash`/事件审计关系未定义 | `memory-tree-product-architecture.md:1053-1065`；`memory-tree-product-requirements.md:461-463` | 地点、偏好、短句等低熵内容可能被枚举；修改 `ops_json` 后 `payload_hash` 要么失效、要么被重写而失去不可篡改审计。保留可关联指纹也不能直接视为匿名或已清除 | 结构 diff 不保存敏感正文，只保存随机 commitment 与 `content_blob_ref`；正文独立加密，使用可销毁的每条内容密钥。清除时删除 blob/密钥并追加 redact event，不改写已提交结构事件。清除后只验证结构链，不再声称能验证已擦除原文 | TreeDiff 权威、物理清除、历史校验模型 |
| P1 | “条目级 + 自动闭包”没有定义 Claim 与 Evidence 的不同传播规则 | `memory-tree-product-requirements.md:238-241`；`memory-tree-product-architecture.md:816-825` | 删除一个共享 Evidence 时不应无条件墓碑化所有多证据 Claim；清除 Claim 时也不应默认反向擦除支持多个 Claim 的 Evidence。简单图遍历会过删或漏删 | RFC 定义 typed erasure closure：support-edge 移除、字段级 lineage、派生文本 taint、剩余证据重评。确认框展示闭包类别与数量；闭包计算结果固定后再执行 | `eraseMemory` 输入/预览/执行契约 |
| P1 | diff 合并压缩与“任意历史版本可重建”没有同时成立的规则 | `memory-tree-product-architecture.md:1062-1065` | 若折叠连续 diff 又保留中间锚点，没有中间操作就无法重建；若删除锚点，则产品历史粒度发生变化。长期从空树全量重放也会失控 | 明确版本保留策略；增加可丢弃的周期 checkpoint cache。细粒度 diff 在保留期内完整保存，远古历史若降采样必须由产品确认；压缩只能删除不再承诺可访问的中间版本 | 历史年轮、容量预算、恢复时延 |
| P1 | `run_id + frontier` 不是跨重试幂等键，CAS 失败策略也不足以避免长 Dream 饥饿 | `memory-tree-product-architecture.md:719-728` | retry 会产生新 run_id；持续用户纠正会让长 run 反复全量作废；只在阶段边界让出可能无法及时取消长模型调用 | 增加与 run_id 无关的 `input_fingerprint`；每个候选记录 read-set/write-set。无交集操作允许受限 rebase，主线/IdentityEpoch 必须重算。模型调用接 AbortSignal；连续 CAS 失败后缩小 frontier 批次并退避 | MemoryDream 幂等、成本和前台优先级 |
| P1 | 首次告知缺少可执行状态机 | `memory-tree-product-requirements.md:187-193` | “默认开启”与“告知是启用前置”之间存在竞态：首次启动到点击继续之间是否允许落盘 Evidence 未定义；也没有 notice 版本 | 定义 `pending_notice / enabled / disabled` 有效状态；`pending_notice` 不产生长期 Evidence、不启动 Dream。保存 `notice_version` 与 `acknowledged_at`；文案或数据范围实质变化时由政策决定是否重新告知 | R-017 知情前置、首次启动实现 |
| P1 | “物理清除”没有给系统管理备份、WAL、Lance 旧版本、远程 provider 和未来云副本划定可验证边界 | `memory-tree-product-architecture.md:822-823,1495-1519` | 本地查询不可见不等于介质上不可恢复；远程 provider 已接收的数据也不能由本地事务撤回 | 在 RFC 中声明 threat model 和覆盖范围：应用管理的 SQLite/WAL/Lance/缓存/日志/备份；远程披露单独记账；系统外备份和用户导出明确不在即时保证内。若继续使用“物理清除”，优先采用加密存储与 crypto-shred | 隐私文案、公开发行合规审阅 |

补充法律边界：欧盟 GDPR 第 17 条要求在适用条件下删除并停止处理，同时存在法定例外；若数据已向接收方披露，还涉及通知义务。EDPB 也明确指出可重新关联的假名化数据仍属于个人数据。因此，哈希或指纹不能未经评估就被写成“已经匿名/已经擦除”的证明。正式公开发行前仍需按产品已裁决的硬门槛完成专业审阅。

## C. 需求与架构矛盾

### C1. “一个事务”与实际存储边界冲突

- 需求承诺一次操作清理 Evidence、Claim、派生文本、账本、树、FTS 和向量。
- 当前架构继续复用 SQLite + LanceDB；当前代码明确把 SQLite 事务和 LanceDB 操作分开。
- 判断：产品要求可以保留，但架构必须从 ACID 单事务改成“即时不可见 + 可恢复清除 Saga + 完成验证”。

### C2. “不可恢复”与“保留明文指纹”冲突

- 需求要求历史内容成为不可恢复的 redacted。
- 架构保留内容哈希指纹，并没有定义是否加盐、HMAC、随机 commitment 或可销毁密钥。
- 判断：修改架构。树结构校验与内容完整性校验必须分层；擦除后只能继续验证结构和事件顺序，不能继续验证已经删除的原文。

### C3. append-only 历史与原地改写 diff 冲突

- TreeDiff 被定义为历史权威。
- 清除又要求改写历史 `ops_json` 内容本体。
- 判断：历史结构事件保持 append-only；敏感正文从一开始就外置，清除通过 blob/key 删除和新增 redact event 实现。

### C4. 首次告知与通用 Onboarding 的 owner 表述仍有轻微混淆

- R-017 写“首次启动的全产品引导”，随后又声明该告知不依赖通用 Onboarding。
- 判断：不是产品矛盾。工程命名应改为“首次启动 gate”，通用 Onboarding 以后只负责展示编排。

### C5. `moveMemoryBranch` API 名称容易违反“不手工塑造树”

- R-031 禁止用户直接改变真实树结构。
- Product API 暴露 `moveMemoryBranch`。
- 判断：区分 `pinBranchPresentation`（仅布局）和 `submitBranchScopeCorrection`（语义纠正）；不要保留含义不明的 move API。

## D. 领域模型审计

| 对象 | 权威性 | owner | 失效/清除 | 版本与重建 | 结论 |
| --- | --- | --- | --- | --- | --- |
| Evidence | 来源权威 | Evidence service + deterministic curator | source_deleted / excluded / erased | append-only 元数据；正文可被擦除 | 成立；需要字段级 lineage 与 ingest sequence |
| Concept | 稳定身份权威 | Concept service | merge/split/supersede；不因改名新建 | stable key + reconcile | 成立；stable key 待 RFC |
| Episode | 经历权威 | Episode service | 时间失效、降权或来源闭包重评 | 可由 Evidence 重建候选，但已确认边界需版本化 | 成立 |
| Claim | 当前认识权威 | Claim service | superseded/disputed/erased | 来源集合与认识状态必须版本化 | 成立；erase 需区分“删支撑”与“删主张正文” |
| Relation | 关系事实 | Relation service | 支撑变化后重评/失效 | typed edge + provenance | 成立；清除闭包依赖它但不能仅靠节点遍历 |
| NutrientSignal | 派生状态 | deterministic nutrient projector | 来源 Claim 变化即重算 | 无权威表，可增量缓存 | 修订正确；需 dependency index 避免全树重算 |
| IdentityEpoch | 版本化自我模型 | MemoryDream proposal + review + validator | 不原地覆盖；敏感正文可 redacted | immutable epoch + lineage | 成立；正文建议同样走 erasable content blob |
| TreeSnapshot | 版本锚点 | atomic commit owner | 不删除；可标记 redaction 状态 | 元数据权威，节点正文由 diff/checkpoint 重建 | 成立；需要 checkpoint cache |
| TreeDiff | 结构历史权威 | tree commit owner | append redact event，不原地改写结构事件 | append-only + canonical hash | 方向成立；敏感正文必须外置后才能真正自洽 |

## E. 十个场景走查

| # | 场景 | 结果 | 主要链路与缺口 |
| --- | --- | --- | --- |
| 1 | 任务暂停后恢复 | 条件通过 | Evidence → stable task Concept → 新 Episode → continues/reopens Relation → 原枝 TreeDiff。stable key 与 reconcile 在 RFC 冻结即可 |
| 2 | 全局偏好纠正为项目偏好 | 条件通过 | user_confirmed Evidence → supersede Claim → scope Concept 修正 → NutrientSignal 增量重算 → TreeDiff；需要 dependency index |
| 3 | 两条证据冲突 | 通过 | 两个 Claim/支撑并存，disputed 标记，召回携带冲突；无静默覆盖 |
| 4 | 新成长阶段 | 条件通过 | 深度 Dream → proposal → isolated review → validator → CAS commit。长 run 需补 AbortSignal/rebase/anti-starvation |
| 5 | 删除普通会话 | 条件通过 | source_deleted → support weight 重算，不物理删派生 Claim。传播算法仍需 RFC |
| 6 | 找回物品位置 | 通过 | index_only Evidence/Claim + observedAt/confidence；无原截图持久化 |
| 7 | 年轮返回现在 | 未通过 | 产品链路成立，但当前 diff 内容/哈希/压缩契约尚未自洽，不能保证长期可靠重放 |
| 8 | 隐藏树升级揭晓 | 通过 | local maturity × server entitlement → revealed；与内核最小切片兼容 |
| 9 | Dream 被前台任务打断 | 未通过 | 有 CAS 和阶段检查点，但长模型调用取消、连续冲突饥饿和重试幂等仍未闭合 |
| 10 | 远程 Dream 输入含敏感/秘密 | 条件通过 | deterministic local gate 必须先阻断 secret；最小 sensitive 可按用户配置发送。仍需 outbound disclosure ledger 与 provider 边界 |

## F. 缺失的工程契约

### 必须在 RFC 阶段冻结

1. Erasure Saga 状态机、闭包预览、幂等键、失败恢复和完成验证。
2. 内容外置、每条内容加密/密钥销毁、随机 commitment 与结构 hash 规范。
3. canonical serialization、diff event hash、`payload_hash` 与 redaction event 规则。
4. Claim/Evidence 不同的 typed erasure closure 与字段级 lineage。
5. checkpoint cache、diff 保留期、历史压缩和年轮可见粒度。
6. Dream `input_fingerprint`、read/write set、rebase、AbortSignal、CAS 重试与反饥饿策略。
7. 单调 Evidence ingest sequence/frontier 语义。
8. notice gate 状态、notice_version 与采集启动顺序。
9. 查询 facade 的 erased deny-set、snapshot cache 失效和 LanceDB 候选过滤不变量。
10. 系统管理备份、WAL、Lance 旧版本、日志和远程披露的清除边界。

### 可以在实现阶段决定

- P95 的最终具体数值。
- checkpoint 间隔的默认工程值。
- Dream 每批 frontier 大小和退避参数。
- Canvas 具体渲染后端与命中测试结构。
- NutrientSignal cache 的物理表或内存实现。

### 需要产品负责人重新确认

1. 远古历史是否必须保留每一次细粒度树版本，还是允许按月/阶段降采样。
2. “彻底清除”的用户承诺是否覆盖应用自己创建的本地备份，以及允许多长的后台清理完成窗口。

其余五项产品裁决无需重新打开。

## G. 复用、删除与迁移建议

- **直接复用**：SQLite 事务封装、FTS 与主表同事务更新、LanceDB failure fallback、query 先用 SQLite 候选 ID 过滤向量的形态。
- **重构后复用**：现有 vector index 状态与失败日志模式；升级为 generation + tombstone deny-set + purge job。
- **迁移期间保留**：当前 Memory/Knowledge 共用的 embedding 与路径 provider；Knowledge 域保持不动。
- **应当删除**：`memory:save` 直写、renderer 自动沉淀、前端临时相似度关系、每文件夹记忆入口。
- **需要进一步取证**：应用管理的数据库备份、诊断导出、崩溃报告和日志落盘位置是否会复制记忆正文。

## H. 建议的工程 RFC 目录

1. 目标、不变量与非目标
2. 权威数据、派生数据与内容 payload 分层
3. 九对象 schema 与 canonical serialization
4. TreeDiff、checkpoint、hash 与历史重建
5. Erasure Saga、typed closure 与 crypto-shred
6. MemoryDream pipeline、budget、run ledger 与模型端口
7. 并发、CAS、rebase、幂等和前台抢占
8. FTS/vector generation、查询 deny-set 与缓存失效
9. Notice gate、Settings 和治理 API
10. Recall facade、性能预算与降级
11. Storage generation、回滚、备份和崩溃恢复
12. 安全、注入、隐私和外部 provider 边界
13. Golden fixtures、故障注入和验收矩阵
14. 分阶段实施、删除旧链路与防回潮检查

## I. 仍需产品负责人回答的问题

只剩两个真正影响产品承诺的问题：

1. 年轮中的远古历史是否允许降低时间分辨率，例如只保留月度或成长阶段快照？
2. 用户点击“彻底清除”后，产品承诺是“立即在所有 VelarOS 查询面不可见，后台完成物理清理”，还是必须阻塞到所有应用管理副本都完成验证后才算成功？

## 附：文档卫生

- `memory-tree-revision-notes.md` 正文正确记录为 5 个待裁决问题和 5 项裁决；外部口径中的“6 项”应改为“5 项”。
- `memory-tree-review-prompt.md:67` 仍把“没有单条物理删除”写成绝对事实，且没有要求走查场景 9 的彻底清除。下一次外部评审前应改为引用 R 条目和 revision notes，避免再次复制冻结事实清单。
- 需求决策表中 5 项产品裁决已标为“已裁决”；第二轮架构修订仍标为“修订待复核”是正确状态，本报告结论暂不支持重新冻结。

## 外部规则参考

- [GDPR Article 17 — Right to erasure](https://eur-lex.europa.eu/eli/reg/2016/679/art_17/oj/eng)
- [EDPB — Anonymisation and pseudonymisation](https://www.edpb.europa.eu/topics/ai-and-technology/anonymisationpseudonymisation_en)
- [EDPB — Guidelines 01/2025 on Pseudonymisation](https://www.edpb.europa.eu/public-consultations/guidelines-012025-on-pseudonymisation_en)
