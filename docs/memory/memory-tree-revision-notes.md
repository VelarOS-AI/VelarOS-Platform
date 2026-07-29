# 记忆树修订记录（第二 / 四 / 六轮修订）

> 状态：三轮修订均已并入需求与架构文档；第三轮与第五轮独立评审（均 NEEDS REVISION）的全部 P0 / P1 已处理，等待下一轮（第七轮）独立评审复核
> 日期：2026-07-13
> 本文是第二轮架构复审的修订索引：记录每项修订的动因、证据与影响面，供下一轮独立评审快速定位分歧点。修订内容本身以 [记忆树产品需求](./memory-tree-product-requirements.md) 与 [记忆树产品愿景与重构架构](./memory-tree-product-architecture.md) 的正文为准。
> 本轮复审同时完成了一次全代码库现状侦察（`packages/memory`、`apps/desktop/src/main/memory`、`packages/agent`、渲染层、存储与迁移基建），侦察结论摘录于文末。

> **2026-07-14 后续裁决变更（覆盖本文相关历史条目）**：R-017 的「首次启动记忆告知门」整体撤销——`pending_notice` 状态机、告知屏、告知确认时间、`notice_version` 重新告知政策全部移除。隐私知情由产品级隐私协议在用户使用产品之前一次性覆盖，应用内不再单独设记忆告知门；自动记忆运行态只保留 `enabled`（默认，从首次使用即开始）/ `disabled`（设置里关闭）。下文中一切「首次告知 / pending_notice / 首次启动 gate」的历史修订条目均以此裁决为准，视为已撤销。

## 修订总览

| # | 修订 | 层级 | 严重级 | 落点 |
| --- | --- | --- | --- | --- |
| 1 | 树版本历史存储权威改为 TreeDiff 链 | 架构 | P0（原方案历史回看不可实现） | 架构文档：投影章节、`memory_tree_snapshots`、新增 `memory_tree_diffs` |
| 2 | 确定性“彻底清除”治理通道 | 产品 + 架构 | P0（无秘密补救与法规出口） | R-011 / R-021 / 场景 9 / 删除语义 / product.md |
| 3 | 外部内容信任分级与注入防御 | 产品 + 架构 | P0（安全缺口） | 新增 R-041 / 来源信任分级节 / 复核操纵检查 |
| 4 | NutrientSignal 去除独立衰减态 | 领域模型 | P1（自相矛盾） | 需求统一模型节 / 架构 NutrientSignal 节 |
| 5 | 首次启动记忆告知 | 产品 | P1（知情缺口） | R-017 |
| 6 | 召回性能契约（同步零 LLM） | 架构 | P1（已被本项目实证的教训） | R-022 / 架构召回性能契约节 |
| 7 | 无模型时优雅降级 | 产品 + 架构 | P1（BYOK 现实未定义） | 新增 R-040 / Dream 运行时机节 |
| 8 | 并发与提交契约 | 架构 | P1 | 新增并发与提交契约节 |
| 9 | run ledger 卫生 | 架构 | P1（隐私旁路） | `memory_dream_runs` 节 |
| 10 | 向量索引版本化 | 架构 | P2 | 存储章节新增小节 |
| 11 | 评估与回归体系 | 架构 | P1 | 新增评估与回归体系章 |
| 12 | 最小可发布切片（召回先于 Canvas） | 路线 | P2 | 重构路线章开头 |
| 13 | 复用 / 删除表按真实代码 owner 落地 | 架构 | — | 复用表扩充 + 新增相邻记忆机制边界章 |
| 14 | 周边文档模型清单同步 | 文档一致性 | P2 | design-principles.md / kernel-evolution-plan.md / product.md |

## 各项修订的动因与论证

### 1. TreeDiff 链成为版本历史的存储权威

原方案存在一个会在实现期塌方的矛盾：`memory_tree_nodes` 是可变单行表；快照节又写“快照不必复制所有节点正文，可以保存结构版本和增量 diff，由稳定节点表重建”；同时 `TreeDiff` 被定义为“由两个已提交 snapshot 确定性计算”。三者合在一起：节点一旦被后续版本更新，旧版本的标题、摘要与结构就永久丢失，R-007 承诺的“回看当时真实提交的树形快照”在数学上不可实现，TreeDiff 也失去计算输入。

修正为事件溯源式设计：每次提交在同一事务写入自包含、可逆放的 diff（携带受影响节点完整前后 payload）；快照表退化为版本锚点（版本号、`tree_hash`、身份与主线引用）；当前树是物化视图，可从空树重放重建，历史版本可从当前视图逆向重建，双向重建结果都必须命中锚点哈希。diff 链同时天然是生长动画的数据源，避免了“动画数据”与“历史数据”双份存储。

对抗校验轮发现“可验证历史”与“可依法擦除”（修订 2）两条不变量在朴素设计下互斥（擦除改写历史 payload 会打破锚点校验），当时用“哈希指纹分层”解决。**该方案已被第三轮独立评审否决（明文派生哈希可被低熵内容字典枚举，且改写历史破坏审计），第四轮修订取代为：内容外置 + 逐条加密 + 随机化承诺 + append-only 结构历史 + redact event，见文末“第三轮评审与第四轮修订”。**

### 2. 确定性“彻底清除”通道

原冻结决定“记忆产品不提供单条永久删除”作为默认哲学成立，但绝对化后留下三个无解场景：secret redaction 漏网的秘密没有事后补救手段；法规（被遗忘权类）没有出口；强隐私诉求用户只剩“删掉整个数据库”一个选项。这不是审美问题，是信任与合规的结构缺口。

修正保持自然遗忘为唯一的日常遗忘模型，另开一条受限例外通道：入口在设置“记忆”Tab 的隐私治理区，不出现在树页面常规交互。对抗校验轮把擦除闭包从最初的三项扩展为完整集合（**“单事务完成”的执行模型已被第四轮修订取代为 Erasure Saga：立即不可见 + 后台幂等清理 + 验证，见文末**）——原表述为单事务完成：Evidence 摘要擦除、派生 Claim 墓碑化、所有可能复述该内容的派生文本清洗（身份阶段陈述、全局主线描述、压缩历史摘要、树节点标题与摘要，待下次生长重生成）、run ledger 与诊断日志相关候选清洗、向量与 FTS 行删除、树与索引重算；历史 diff 中内容本体改写为 redacted 占位而哈希指纹保留（见修订 1）。`eligibility_state` 增加 `erased`，Claim 的 `lifecycle_state` 同样承载 `erased` 墓碑。未来云端保险库的删除语义需与此对齐（本地清除必须能传播到云端副本，已在云端章节的“永久删除必须成为正式产品流程”留有锚点）。

### 3. 外部内容信任分级与注入防御

原方案对 prompt injection 只字未提，而污染链是完整的：网页 / 外部文件内容成为 Evidence → MemoryDream 阅读并提取 Claim → 营养与 Identity Epoch 被操纵。一个恶意网页理论上可以往用户的“AI 自我认知”里写字。

修正为四级来源信任（`user_stated` > `system_observed` > `agent_derived` > `external_content`）+ 三条防线：仅外部内容支撑的 Claim 封顶 `inferred` 低置信、禁入画像 / 营养 / 身份；整理模型把证据当数据，证据内指令无执行语义；隔离复核新增“提案是否被证据文本操纵”检查。配套注入攻击回归套件（评估章）与验收标准第 17 条。

### 4. NutrientSignal 去除独立衰减态

原文一边说营养“是可重建派生状态、必须可由 Claim 重算”，一边给它 `decayState` 字段。二者矛盾：自带时间态的对象重算即丢失信息，久之就退化成脱离证据的隐藏画像缓存——恰好是这个对象被发明出来要防止的东西。修正：衰减、强化、沉睡只发生在 Claim / Episode / Relation 上；营养是这些权重的确定性函数，无权威表，可选缓存可随时整体重建。

### 5. 首次启动记忆告知

默认开启自动记忆（R-017）叠加健康 / 财务 / 情绪 / 关系允许入库（R-023），而全流程没有任何知情时刻，在 GDPR 特殊类别数据语境下有实质合规风险，也违背架构文档自己写的“建立在用户所有权上，而不是信息不对称上”。修正为最轻的形态：首次启动引导中一屏说明 + 继续，记录确认时间，不做授权问卷、不反复出现。“默认开启”与“无感”都保留，只是建立在知情之上。

### 6. 召回性能契约

这条直接来自本项目的实证教训：现有系统曾把 LLM 重排放进召回同步路径，产生数秒级延迟，最终被整体移除，重构为“工具路径纯 embedding + 回合开始异步严格选择注入”（现状 `TurnRecallCoordinator` + `MemoryRelevanceSelector`，4 秒硬超时、失败降级、空选合法）。新系统的树路径召回如果不带硬约束，同样的错误会重犯一遍。修正为显式契约：同步路径零 LLM、零远程网络、P95 < 150ms（数值可在工程冻结时校准，约束方向不可退让）；模型参与一律异步零阻塞；深层召回是显式模式。

### 7. 无模型时优雅降级（R-040）

VelarOS 是 BYOK 产品，新用户可能长期没有配置任何 provider。原方案整条链路（提炼、整理、embedding、成熟度）在无模型时的行为未定义。修正：确定性采集永续，模型提炼安静积压，配置后补整理；不伪造成熟度、不报错、不催促。

### 8. 并发与提交契约

原方案有租约与暂停恢复的意向，但没有可实现的提交规则。补齐：树版本 CAS 提交、用户纠正同步优先（Dream 在安全检查点让位并基于新版本重算）、检查点对齐 pipeline 阶段边界、孤儿 run 启动时标记 failed、物化视图哈希自检失败时从 diff 链重放重建。**第三轮评审指出 `run_id + frontier` 不是跨重试幂等键、CAS 全量作废会饿死长 run，第四轮修订升级为：`input_fingerprint` 幂等键、候选级 read / write set 与受限 rebase（主线与 Identity Epoch 除外）、模型调用 AbortSignal、连续冲突时缩小 frontier 批次并退避。**

### 9. run ledger 卫生

运行账本保存候选与 diff 用于诊断，若不设约束，它就是一条绕过隐私模型的旁路（validator 拒绝的敏感候选反而躺在日志里）。补齐：账本经过同一确定性 redaction、不存证据原文、失败 run 候选带 TTL。

### 10–12. 向量索引版本化 / 评估体系 / 最小切片

- 向量行携带 `(provider, model, dimensions, content_revision, index_generation)`；模型切换只切 active profile，旧向量保留，不删除、不重建、不回填。查询只进入完全相同的 profile，禁止跨模型候选/分数合并；切回旧 profile 后原向量自然可见。新内容只写当前 profile，显式手动补建和隐私擦除是独立入口。
- 评估体系（确定性重放、golden 证据集、召回离线 eval、注入套件、衰减模拟、diff 链一致性自检）从“Phase 2 顺带提一句 fixtures”提升为独立章：MemoryDream 的产出质量不可能靠人工盯梢，可重放性是这个系统能不能调试的分水岭。
- 最小可发布切片 = Phase 1–3 + 树路径召回；Canvas 页面与召回解耦，可并行或后置。树成熟前本来就不可见（R-018），视觉系统不应阻塞记忆内核上线。

### 13. 复用 / 删除表与相邻机制边界（基于全码侦察）

复用表新增 15 行真实代码 owner（详见架构文档），关键判断：

- **保持不动**：knowledge 兄弟域、`shared/` 混合检索基建、`Embeddings` 注入式基础设施、`recall_context` / `distill_context` 句柄体系（会话内工作记忆，与长期树分层，交点只在证据采集）。
- **复用形态**：`TurnRecallCoordinator` 第八源注入模式、`DeterministicCurator` 脱敏正则作为隐私入口种子；旧 chat generation 协调器已在测试版基线整理中退役。
- **删除**：renderer 侧自动沉淀（采集职责移到 main 侧证据桥，顺带修复“浏览器 / 系统空间会话从不自动沉淀”的现状不平等）、`save_memory` 绕过 curation 的直写路径（被禁的平行写入管线，现状真实存在）、编码记忆辅助器（其唯一写入口的生产者已消失，半死链路）、每文件夹记忆入口、关系 / 时间双视图与前端相似度连线。
- **新造**：揭晓 gate——现有 entitlement 全是服务端计划位，树成熟度是本地信号，`revealed` 由本地 policy 组合计算，成熟度不上报云端。

### 14. 周边文档同步

- `design-principles.md` 原则 6 与 `kernel-evolution-plan.md` Phase 6 的模型清单是 6 元素旧版（缺 NutrientSignal / IdentityEpoch / TreeSnapshot / TreeDiff），已同步为九对象版。
- `product.md` 记忆树章节的删除语义已与“彻底清除”修订对齐。
- **尚未同步**：`docs/memory-tree-review-prompt.md` 内嵌的“已冻结的产品事实”复述在本轮修订后已过时；建议该文档改为按 R 条目引用而不是复述清单（每次修订都要三处同步是维护负担）。

## 对抗校验轮（同日，修订并入后执行）

三个独立校验员对修订后的文档做了内部一致性、跨文档一致性与代码事实三路攻击，共报告 1 个 P0、约 8 个 P1、约 14 个 P2，全部已在同轮修补。要点：

- **P0**：擦除改写历史与 `tree_hash` 锚点校验互斥 → 当时以哈希指纹分层解决（该方案后被第三轮评审否决，第四轮已取代，见文末）。
- **P1**：擦除闭包漏掉派生文本（身份陈述 / 主线描述 / 压缩摘要 / 节点标题）与 run ledger → 扩入单事务（见修订 2）；R-022“零网络”与远程 embedding 矛盾 → 改为“不同步等待网络 + 确定性降级”，并把“异步模型选择”明确为允许的第二层（否则现有 TurnRecallCoordinator 复用形态违宪）；R-040“提炼”一词混指两种职责 → 拆分为“最小 Evidence 片段确定性产出”与“模型候选提取”；R-017 告知屏与 R-027“Onboarding 后置”时序冲突 → 告知屏独立轻量实现、随第一阶段交付；“所有树版本可从证据层重建”是与 diff 权威矛盾的旧措辞 → 收窄为“当前树可重建，历史唯一来源是 diff 链”；三强度契约与 episode / relation 表结构不咬合 → 契约收窄 + episodes 表补列；Claim 的 erased 墓碑无字段承载 → lifecycle_state 枚举定案并含 erased。
- **P2**（拣要）：TreeSnapshot 逻辑定义与存储定义分层标注；信任等级落为 `memory_evidence.trust_level` 列并按“内容作者而非采集通道”确定性判定；认识状态梯子统一为 `user_confirmed > observed > derived > inferred`（`disputed` 并列）；隐藏树用户的治理动线补齐（记忆 Tab 内标题级检索列表，不呈现树形与身份）；FTS 补派生地位条款；用户显式补建 / 维护并入 Dream 租约，模型切换不进入调度；diff ops 补 `split`；树投影数据层从 Phase 4 前移到 Phase 3（否则最小切片声明不可执行）；“快速记忆清洗模型”改名“快速候选整理模型”；Product API 补 `eraseMemory`；决策表旧行与冻结行状态同步。
- 代码事实核查：修订记录与架构文档引用的 8 项现状（TurnRecallCoordinator、Selector、save_memory 直写、useChatMemoryBridge、编码记忆辅助器断供、迁移协调器、entitlement 形态、前端相似度连线）全部属实，无一失实。

## 侦察确认的关键现状（供下一轮评审直接引用）

1. 记忆树目前是纯文档态：全仓源码零命中 memory-tree / MemoryDream / IdentityEpoch。现有代码世界是 `MemoryRecord` + `fact/preference/feedback/reference/procedure` kind + metadata 内嵌 scope。
2. 代码里实际存在四套独立“记忆”机制：长期记忆（SQLite + LanceDB）、编码记忆辅助器（读长期记忆拼 prompt 段）、句柄召回体系（聊天存档）、回合自动注入（TurnRecallCoordinator）。架构文档新增“相邻记忆机制边界”章逐一定去向。
3. “多套写入管线”反模式已被证实存在：`save_memory` 直写不走 curation，IPC 与自动沉淀走 curation，各自维护合并规则。
4. Memory 页图谱的“关系”是前端即时算的向量相似度（且 cap 前 20 条记忆），正是新架构明令删除的“前端临时关系真相”。
5. 自动沉淀由 renderer 发起且要求 `workspaceRoot` 非空——浏览器与系统空间会话在现状下从不自动沉淀。
6. 当前只保留 `MigrationManager` 承担正式版本的表内演进；跨库 generation 变更需在出现真实发布需求时重新设计。
7. 现有 Settings 只有一个记忆开关（`autoMemoryEnabled`）；“记忆”顶层 Tab 是全新建设。
8. Canvas 无三方图形库（仅 d3）；`CodeGraphCanvas` 是自绘 canvas 的现成范本。

## 有意不改的冻结决定（复审后维持）

- 单树、单全局主线、营养层、身份跃迁的世界观：模型上成立，且比“多树/多主线”产品复杂度低一个量级。
- 树成熟后揭晓、entitlement 只控可见性：与最小切片策略互相成全。
- 自然遗忘为默认遗忘模型：彻底清除是例外治理通道，不推翻 R-021 的哲学。
- 三级 MemoryDream、模型只提案、重大变化隔离复核、原子提交：结构正确，本轮只是补齐并发与卫生契约。
- 不做旧数据迁移（R-014）：侦察确认无生产用户数据，clean break 成立。

## 产品负责人裁决（2026-07-13 已全部裁决）

原第二轮修订留下 5 个待裁决问题，产品负责人已当面裁决，全部并入需求与架构文档正文：

1. **彻底清除粒度**：条目级（单条 Claim 或 Evidence）+ 系统自动扩展闭包；执行前一次明确二次确认，不做重交互。（落点：R-021、`eraseMemory` API）
2. **首次告知**：直白简短的事实句式，零修辞；告知内容含 Dream 消耗额度说明。邀请制阶段不做分地区合规审阅，正式公开发行前完成合规审阅是硬门槛。（落点：R-017）
3. **Dream 成本**：三级整理默认携带 token 预算档位（如每日上限），对所有用户生效，普通用户无感、高级设置可调。（落点：R-008、设置章节）
4. **文件夹记忆视图**：直接删除，无过渡形态；会话级视图由树的作用域过滤与分支聚焦承接，未揭晓用户走设置治理列表。（落点：复用表）
5. **深层召回入口**：不设专用 UI 按钮；自然语言触发或普通召回无果自动升级并在回答中声明。（落点：R-022、召回性能契约）

## 第三轮评审与第四轮修订（2026-07-13）

第三轮独立评审（[完整报告](./memory-tree-third-round-review.md)）结论 `NEEDS REVISION`：九对象模型与五项产品裁决无需推翻，但第二轮的擦除设计存在两项 P0。第四轮修订全部处理完毕：

### P0-1：跨库单事务不可实现 → Erasure Saga

SQLite / FTS 与 LanceDB 不共享事务域（现有代码 `Mutation.ts` / `Repository.ts` 已证明两库只能顺序协调），“单事务彻底清除”是写不出来的原语。取代设计：**第一段**在权威库单事务写入墓碑、固化闭包、redact event 与查询 deny-set——所有查询面从此刻起立即过滤；**第二段**后台幂等清理向量、FTS、缓存、账本、派生文本、内容密文与密钥，逐面跑验证探针；全部通过才置 `verified`。崩溃自动续跑。新增 `memory_erasure_requests` 表与 `previewMemoryErasure` / `getMemoryErasureStatus` API。

### P0-2：明文派生哈希不能证明不可恢复 → 内容外置 + crypto-shred

第二轮的“哈希指纹分层”被否决：低熵内容（地点、偏好、短句）可被字典枚举验证；改写历史 diff 又破坏 append-only 审计；且 GDPR / EDPB 语境下可关联指纹不能当擦除或匿名证明。取代设计：敏感正文从写入起外置为逐条加密的内容 blob（`memory_content_blobs`），密钥独立存放（第六轮已再取代：密钥不落任何 SQLite 表，只存在于 keyring 物理根的三层信封中）；结构 diff 只存 `content_blob_ref` 与随机化承诺 `content_commitment`（随机数参与计算，销毁后不可枚举）；结构历史 append-only 永不改写，清除=销毁密文与密钥+追加 redact event。`tree_hash` 只覆盖结构与承诺，擦除后只验证结构，不再声称能验证已删原文。密钥分离的红利：WAL、旧页、应用备份里残留的都是密文，销毁密钥即全部失效，无需追杀每个副本。

### P1 五项

- **typed erasure closure**：Evidence 与 Claim 传播规则分开（证据擦除→仍有独立支撑的结论只重评不连坐；结论擦除→不反向擦除共享证据）；派生文本按字段级 lineage taint 判定；确认框展示固化闭包的类别与数量。
- **diff 压缩与历史保留**：产品裁决落地（近一年细粒度、远古降采样月度 + 成长阶段 + 重要主枝）；checkpoint cache 加速远古重建；压缩只删不再承诺可访问的中间版本。
- **Dream 幂等与反饥饿**：`input_fingerprint` 取代 `run_id + frontier`；候选级 read / write set 与受限 rebase（主线 / Identity Epoch 必须重算）；AbortSignal 即时取消；连续 CAS 失败缩批退避。
- **首次告知状态机**：`pending_notice / enabled / disabled`；pending 期间不落长期 Evidence、不启动 Dream；`notice_version` + 重新告知政策。工程命名“首次启动 gate”（评审 C4）。
- **清除威胁模型**：即时保证（查询面）/ 后台保证（应用管理副本）/ 明确排除（OS 级备份、用户导出）/ 远程披露台账（`memory_outbound_disclosures`）；对外措辞统一为 crypto-erasure，不声称匿名化。

### 其余采纳

- C5：`moveMemoryBranch` 拆为 `pinBranchPresentation`（纯布局）与 `submitBranchScopeCorrection`（语义纠正提案）；merge / split 注明走提案链。
- 两项新产品裁决并入（历史保留粒度、清除承诺形态），全部产品问题清零。
- 文档卫生：外部口径应为“5 个问题、5 项裁决”（此前口头表述“6 项”系把合规子问题多计一项）；review-prompt 的内嵌事实清单已降级为导读并修正过时条目，新增彻底清除走查场景。

### 第四轮修订的对抗校验补丁（同日第二遍）

第四轮修订并入后又跑了一遍三路对抗校验（架构内部 / 需求内部 / 报告覆盖度），抓到 2 个 P0 级残留与一批 P1/P2，全部同轮修补：

- **nonce 明文列**：`commitment_nonce` 原以独立列写进 blobs 表——备份里明文 nonce + 结构链承诺值即可字典枚举低熵内容，恰是 P0-2 要堵的攻击。改为封装进加密信封，校验必须先持密钥解密。
- **Evidence 层哈希残留**：`memory_evidence.content_hash` 与 R-020 的“内容哈希”是漏改的明文派生哈希，同步改为随机化承诺，墓碑化时行内内容派生字段一并清空。
- **统一外置裁定**：加密外置从“敏感正文”扩大到全部内容正文（不限隐私级）——场景 9 的核心就是误分类，隐私分级不能影响可擦除性；派生索引（FTS / 向量 / 物化视图 / checkpoint）持明文但可重建且在清理清单内；应用管理备份只含权威表与密文，不含派生索引与 keystore，密钥销毁即覆盖备份。
- **redact 落点与写回竞态**：redact 定为结构事件的一种，擦除第一段提交只含 redact 操作的新树版本——版本必然推进，进行中 Dream 的 CAS 必然失败，validator deny-set 复检兜底，写回竞态双重闭合。
- **双哈希口径**：`tree_hash` = 状态哈希（锚点校验），`event_hash` = 链式审计哈希；降采样保留版本转为自包含物化基点，审计链重新锚定，redact 语义在基点保留。
- **执行 owner 与电源门控**：新增 `MemoryErasureService`；第二段清理走 DreamCoordinator 的高优先级独立通道，不受暂停 / 电源 / 充电策略门控。
- **其余**：saga 增加可观测 `stalled` 态；第一段事务补 NutrientSignal 重算；`memory_dream_runs` 补 `input_fingerprint` 与候选 read / write set 落点；keystore 换根原子性与“永不入备份”定案；`diff_summary` 限定为结构统计；pending_notice 空窗会话不回补（自确认时刻起算）；架构可见性状态轴与 Dream 触发条件同步 `pending_notice`；“任意历史版本可重建”收窄为“仍承诺保留的版本”；R-011 术语改加密擦除；实施前问题补 Evidence ingest sequence（第三轮 F#7 漏项）。

## 第五轮评审与第六轮修订（2026-07-13）

第五轮独立评审（[完整报告](./memory-tree-fifth-round-review.md)）确认：第三轮两项原始 P0 已修复，Erasure Saga / redact 版本推进 / 随机化承诺 / 内容外置方向全部成立，九对象模型与七项产品裁决无需重开。但发现三项新 P0，恰好都在第四轮新设计的接缝上；第六轮按其“七项最小补丁包”完成修订：

### 三项 P0 的修正

1. **权威 schema 明文残留**：第四轮宣布“统一外置”却没有执行到字段清单——`canonical_name`、`alias`、Episode `title/summary`、Claim `value_json/summary`、IdentityEpoch 陈述、树节点文本全是行内明文。第六轮逐表替换为 blob 密文引用 + 随机化承诺 + 等值盲索引（HMAC，身份归并与作用域过滤不再依赖明文），`predicate` 收紧为受控词表，并新增列级数据分类矩阵（①纯结构 / ②盲索引 / ③语义正文 / ④派生投影），schema 冻结时逐列归类。
2. **明文派生索引 vs 备份承诺**：FTS token、向量、展示投影是内容派生物，不受 DEK 销毁保护；generation 协调器目录级复制也无法保证“备份不含索引”。第六轮定义五个物理根（authority / blobs / keyring / index / backup），备份边界由物理布局保证；派生索引装入按代际管理、静态加密的 index generation——擦除先行删 + deny 过滤立即生效，随后 generation 轮换、销毁旧代密钥兜底介质残留；LanceDB 向量行不携带明文内容列。
3. **擦除后远程披露竞态**：CAS 只闭合写回，不能阻止已解密的 Dream run 在擦除确认后继续外发。第六轮新增 `MemoryDisclosureGateway` 作为唯一远程披露 owner + 单调 `privacy_generation`：Dream 外发前登记 read-set 与世代，gateway 在发送边界短临界区复检并先记账后发送；擦除第一段递增世代、广播 abort、取得 write barrier——擦除确认返回后不再有命中闭包的新披露，已越界请求如实记为“清除前已披露”。

### 五项 P1 的修正

- **keystore 代际**：升级为 DEK / keyring generation / wrapping root 三层信封（`ContentKeyService` 唯一 owner）；擦除从所有保留代际重写剔除 DEK，原子换代每步崩溃可恢复，已擦密钥在任何回滚路径不复活；`safeStorage` 只作保护 root 的 seed。
- **deny-set 物理结构**：`closure_json` 降级为审计快照；在线过滤走规范化 `memory_erasure_targets` 索引表 + 单调 `deny_generation`，saga verified 后目标退役，防无界增长。
- **双哈希矛盾**：定案公式 `tree_hash = H(canonical_state)`、`event_hash = H(domain ‖ prev ‖ version ‖ ops)`，快照同时存 `tree_hash` 与 `event_head_hash`；同库存放时对外只承诺完整性自检，不称防篡改（外部锚点为可选后续）。
- **物化基点权威化**：新增 `memory_tree_bases` / `memory_tree_compactions` 权威表（compacted_range、旧链末端、新链起点、manifest）；与可丢弃的 checkpoint cache 明确区分；压缩后的诚实审计边界写死。
- **加密召回预算**：同步召回拆五段（索引候选 → eligibility 过滤 → top-K 取键 → 解密校验 → hydration）分段设预算，warm / cold 双基准 + 规模标定 + 确定性降级；解密只在 top-K。

### 配套

- 评估体系新增第五轮 F 节的全部验证门槛（披露竞态逐点暂停测试、canary 扫描、keyring 换代故障注入、基点 golden fixture、canonical 跨版本 fixture、双规模基准）。
- 复用表更新：generation 协调器降为“复用模式不可复用实现”；`safeStorage` 只作 seed；Runtime 新增 `MemoryDisclosureGateway` 与 `ContentKeyService`。
- 实施前问题补 #17–#19（index 轮换策略、盲索引密钥归属、披露闸门原语）。
- 第五轮 H 节确认：全部为工程缺口，产品裁决不重开。

### 第六轮修订的对抗校验补丁（同日第二遍）

七项补丁并入后又跑一遍双路对抗校验，抓到 1 个 P0 级漏网与 3 个 P1，全部同轮修补：

- **run ledger 明文漏网**（第五轮 P0#1 的同类残留实例）：`memory_dream_runs.error` 与候选 / diff 正文原以明文躺在权威库——`error` 拆为枚举 `error_code` + `error_blob_ref`，候选正文按 ③ 类走 blob 密文，账本卫生段同步收紧。
- **聊天注入旁路诚实化**：召回内容注入会话历史后随对话发往 chat provider 不经披露闸门——不变量收窄为“记忆域披露”，擦除时作废未消费注入并从后续回合剔除，已入历史副本按“清除前已披露”列入威胁模型例外。
- **generation 协调器旧表述**：改为只覆盖 authority / blobs 两根，index 排除、keyring 遵循三层信封协议；“keystore”术语清零。
- **其余**：`identity_change_json` 声明去正文；发送边界定义为台账进入 `sending` 且与 barrier 互斥；用户显式向量补建声明过闸门；第一段墓碑清空补盲索引；`deny_generation` ≡ `privacy_generation`（同一计数器）定死；aliases 补承诺、evidence 补 `source_match_key`、`result_ref` / `role` / `relation` 归类标注；`memory_tree_nodes` 从权威表清单挪出；FTS / 向量重建表述改为“权威库 + blob（需 DEK）+ 墓碑排除”；披露台账补 `state` 列；manifest 定义落地（存于 state blob，哈希入 #12 规范）；R-021 补“清除中时长随索引规模变化”的产品提示。

## 给下一轮评审者的核查建议

按第五轮报告 I 节的指令核查第六轮补丁：

- 所有权威 schema 是否已经逐列消除明文语义（对照列级分类矩阵，逐表核对 ③ 类列是否全部为 blob 引用 + 承诺 + 盲索引）。
- index generation 与 app backup 是否真的物理隔离（五物理根布局能否由 generation 协调器按根执行）。
- Erasure Saga 与远程模型 dispatch 是否有可线性化的 privacy barrier（闸门临界区、abort 广播与台账状态机是否闭环）。
- keyring 回滚是否可能复活已擦 DEK（三层信封 + 全代际重写剔除是否覆盖所有回滚路径）。
- materialized base 是否有权威表、manifest 与 event-head 绑定（压缩后的验证语义是否诚实）。
- 上述五项成立后，核查十万 Evidence 冷 / 热召回五段预算的可实现性，再决定是否 `READY FOR ENGINEERING RFC`。
- P95、TTL、批次、迟滞阈值、K 值等数值均为待校准参数，不要作为矛盾攻击；方向性约束（零 LLM、异步、append-only、crypto-shred、立即不可见、唯一披露 owner）才是冻结对象。
- 九对象模型与七项产品裁决已过五轮评审，无新证据不要重新打开。
