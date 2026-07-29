# 记忆树第五轮独立评审报告

> 结论：`NEEDS REVISION`
> 日期：2026-07-13
> 范围：第四轮修订后的 Erasure Saga、全量内容加密外置、Dream 并发、派生索引、物化基点与双哈希
> 纪律：本报告只审查，不修改需求基线、候选架构或既有产品裁决

## A. 总体结论

第四轮已经修正第三轮指出的两个原始 P0：清除不再假装跨 SQLite / LanceDB 单事务完成，历史也不再通过改写已提交 diff 来擦除正文。`redact` 推进树版本、固化 typed closure、查询 deny-set、后台幂等清理、随机化承诺与内容外置的方向全部成立，九对象模型和既有产品裁决无需推翻。

但当前仍不能进入 `READY FOR ENGINEERING RFC`。第五轮发现三个新的 P0，恰好都位于第四轮新增设计的接缝：

1. “全部语义正文外置”的不变量没有落实到权威 schema，多个表仍明确保留明文语义列。
2. FTS、向量和展示投影允许保存明文，却同时声称销毁内容密钥即可覆盖 WAL、旧页和应用管理备份；这两个承诺不能同时成立。
3. 树版本 CAS 只阻止擦除后的旧候选写回，不能阻止已经解密 Evidence 的 Dream 在擦除确认后继续向远程模型发起请求。

此外，keystore 代际、deny-set 物理结构、物化基点权威表和双哈希重新锚定仍缺少可实现契约。这些都属于架构修订，不需要产品负责人重新选型。

## B. P0 / P1 阻塞问题

| 严重级别 | 问题 | 证据位置 | 为什么危险 | 必须修正 | 阻塞什么 |
| --- | --- | --- | --- | --- | --- |
| P0 | 权威 schema 与“全部内容正文统一外置”互相矛盾 | `memory-tree-product-architecture.md:843-861,863-915,926-957,999-1041,1082-1090` | `canonical_name`、`description`、`alias`、Episode `title/summary`、Claim `value_json/summary`、IdentityEpoch `identity_statement/global_mainline`、TreeNode `title/summary` 都仍是行内明文语义；Evidence 的 `source_id/workspace_root` 也可能直接携带个人内容。按表清单实现会绕过 content key，擦除后仍可从 SQLite、WAL 和备份恢复 | 把所有可承载用户语义的列改为 `content_blob_ref + content_commitment` 或加密结构 payload；权威表只留真正的枚举、ID、时间、评分和不可逆随机标识。增加逐列数据分类矩阵，明确每列是否可能含个人内容、是否加密、是否进入索引与备份 | crypto-shred、R-021、场景 9、schema 冻结 |
| P0 | 明文派生索引使“密钥销毁覆盖全部应用副本”不成立 | `memory-tree-product-architecture.md:1089-1090,1135-1139,1150-1157,1504-1510`；当前 `packages/memory/src/memory/storage/Repository.ts:39-47`；基线策略见 `storage-schema.md` | 明文 FTS token/snippet、展示投影和向量本身都是内容派生物，不受 content key 销毁保护；行删除、WAL checkpoint 和 Lance prune 是逻辑清理，不等于旧页/旧文件不可恢复。测试版基线切换直接丢弃旧本地数据，不把开发期数据备份带入发布协议 | 在 RFC 前先冻结一种物理边界：推荐把 FTS、向量和明文投影移入独立、可整体丢弃且不入备份的 index generation，并为该 generation 定义可轮换的静态加密键；擦除时新建过滤后的 generation、原子切换并销毁旧 generation key。若不采用加密索引，就必须把对外承诺收窄为逻辑不可见和尽力清理，不能继续声称旧页与备份不可恢复 | 清除威胁模型、备份、FTS/vector 复用、公开发行隐私文案 |
| P0 | Erasure Saga 没有闭合 Dream 的远程发送竞态 | `memory-tree-product-architecture.md:690-700,722-733,827-830,1072-1076,1101-1106` | 版本推进、CAS 和 validator 只发生在候选提交侧。Dream 可能已解密 read-set、尚未发请求；此时清除第一段提交，随后旧 run 仍可把已擦内容发送给远程 provider，最后即使写回失败也已经发生新披露。AbortSignal 也没有被定义为清除事务的即时副作用 | 所有模型调用前先持久化候选 read-set；远程模型网关成为唯一披露 owner，并在真正网络发送边界校验 `privacy_generation + normalized deny targets`。清除第一段必须提升 privacy generation、向相交 run 广播 abort，并取得独占 disclosure barrier；已经越过发送边界的请求按“清除前披露”入账，未越过者必须取消。擦除确认返回后不得再有命中闭包的新发送 | 远程 Dream、R-021 即时保证、披露台账、并发契约 |
| P1 | keystore 只是“独立文件 + 紧凑重写”，不足以定义可证明的 crypto-shred | `memory-tree-product-architecture.md:1082-1090,1137-1139`；当前 `apps/desktop/src/main/storage/account/CloudAccountTokenStore.ts:3,29-51` | 原始 content key 若直接写入文件，删除重写同样会留下旧文件页；若为了 generation 回滚保留配对旧 keystore，其中仍可能存在已擦 key。现有 Electron `safeStorage` 只能证明项目已有“加密一个本地 secret”的能力，不能自动提供十万级 per-blob key 生命周期、代际回滚和安全销毁 | 冻结 envelope hierarchy：blob DEK、keyring generation、OS 安全存储中的 wrapping root 各自 owner；擦除如何从所有可回滚 keyring generation 移除 DEK；keyring 原子换根、崩溃恢复与 root 轮换；明确 app backup、OS Keychain/系统备份各自边界。禁止把原始 DEK 明文写入普通文件 | 内容密钥 schema、generation 回滚、恢复与故障注入 |
| P1 | `deny_set_json` 不适合作为所有查询面的实时拒绝索引 | `memory-tree-product-architecture.md:1092-1099,1403-1412`；当前 `packages/memory/src/memory/domain/Query.ts:111-126` | 每次查询扫描历史 saga JSON 会随擦除次数无界增长，难以索引、去重和验证；闭包审计快照与在线拒绝索引混成一个字段，也无法给缓存提供稳定 generation | `closure_json` 只保留确认时审计快照；新增规范化 `memory_erasure_targets(request_id, target_type, target_id, deny_generation, state)` 及索引，并在基表同步 `eligibility_state=erased`。维护单调 `privacy/deny_generation` 供查询缓存失效。沿用当前“SQLite 先筛 ID、Lance 后检索”的形态 | P95 查询预算、缓存失效、连续多次清除 |
| P1 | 双哈希定义自相矛盾，snapshot 没有绑定事件链头 | `memory-tree-product-architecture.md:1043-1080` | `event_hash` 一处写“链式纳入 tree_hash”，下一处又称两者各司其职；snapshot 只存 `tree_hash`，没有 `event_head_hash`，无法证明某个状态锚点对应哪条事件链。若哈希和事件都在同一可写数据库，攻击者可一起重算，最多是损坏检测，不能直接称“防篡改” | 明确定义 `tree_hash_v = H(canonical_state_v)`；`event_hash_v = H(domain || prev_event_hash || version || canonical_ops_v)`；snapshot 同时保存 `tree_hash` 和 `event_head_hash`。若没有数据库外的签名/MAC 根，只承诺完整性自检；需要抗恶意改写时，把周期锚点放到 OS keystore 或未来云端 | 历史自检、审计措辞、compaction verifier |
| P1 | “自包含物化基点”没有权威 schema 和重新锚定证明 | `memory-tree-product-architecture.md:1043-1080`；`memory-tree-product-requirements.md:474` | checkpoint 被定义为可丢弃缓存，不能在删除中间 diff 后充当新权威；现有表也没有保存 compaction 来源区间、旧链末端、新链起点、算法版本和 manifest。只保留一个旧末端哈希并不能独立验证已删除事件 | 新增权威 `memory_tree_bases` / `memory_tree_compactions`：`base_version`、自包含结构 blob/ref、`tree_hash`、`event_head_hash`、被压缩版本区间、旧段末端哈希、新锚哈希、canonical/compaction 版本、manifest hash。明确降采样后能证明的是“当前基点与保留链未损坏”，不是重验已经删除的细粒度历史 | 一年后降采样、年轮、灾难恢复 |
| P1 | 加密外置后的召回性能没有预算分解和基准门槛 | `memory-tree-product-architecture.md:1082-1090,1403-1412,1686-1694` | P95 `<150ms` 仍按旧的明文 SQLite/FTS 心智书写；新路径至少增加候选 key 查找、批量解密、承诺校验和可能的加密 index generation。冷启动、keystore 未热、十万 Evidence 下可能远超预算 | 把同步召回拆成索引候选、SQLite eligibility filter、top-K key 批取、top-K 解密/校验、projection hydration 五段预算；定义 warm/cold 两套基准、数据规模、K 值和失败降级。模型调用仍保持零同步网络 | RFC 性能验收、加密方案选型、普通聊天体验 |

## C. 三个关键接缝的判定

### C1. Erasure Saga 与 Dream：写回闭合，披露未闭合

第四轮用 `redact version + CAS + deny-set validator` 正确解决了“被擦内容重新长回树上”。这只覆盖 commit path，不覆盖 model dispatch path。

建议把并发顺序冻结为：

1. Dream 在任何解密和远程发送前登记本次候选的 normalized read-set 与观察到的 `privacy_generation`。
2. 远程 gateway 在一个短临界区内取得 disclosure read lease，复检 read-set、generation 和 tombstone，先落 `planned/sending` 台账再开始网络发送。
3. Erasure Saga 第一段取得 disclosure write barrier，提交墓碑、normalized targets、redact version 和新 generation，同时对相交 run 发 abort。
4. 已经越过网络发送边界的请求被视为清除前已披露，不能谎称撤回；尚未越过者全部取消。
5. 第一段提交并释放 barrier 后，任何观察旧 generation 的 gateway 调用都拒绝发送。

这条 barrier 不要求把网络请求包进 SQLite 事务；它只需要明确“发送发生在清除之前还是之后”的唯一线性化点。

### C2. 加密正文与明文索引：必须选清晰的物理边界

“索引是派生数据”只说明可以重建，不说明旧副本不可恢复。尤其是：

- FTS token 和 snippet 可以直接泄露姓名、地点、偏好与短句。
- embedding 不等于匿名数据，仍应按个人派生数据治理。
- 展示投影如果缓存标题/摘要，等于复制了一份正文。
- SQLite WAL checkpoint、row delete、Lance prune 只能证明正常 API 不再返回，不能自动证明介质残留消失。
- 当前被提议复用的 generation 协调器做目录级复制；若 index 和 authority 共根，备份排除派生索引的承诺无法由物理 copy 实现。

因此 RFC 不能只写“清理清单”，必须先画出独立的 authority/blob/keyring/index/backup 五个物理根，以及每个根的密钥、复制和销毁规则。

### C3. 物化基点与双哈希：需要可验证对象，不只是文字规则

可行的最小模型是：

```text
MaterializedBase N
  state_blob_ref
  tree_hash_N
  compacted_range = [A, N]
  prior_segment_event_head
  base_event_hash
  canonical_version
  compaction_version
  manifest_hash

Retained Diff N+1
  prev_event_hash = base_event_hash
  event_hash = H(domain || prev_event_hash || version || canonical_ops)

Snapshot N+1
  tree_hash
  event_head_hash = Diff(N+1).event_hash
```

删除 `[A, N)` 的细粒度事件后，系统可以验证 materialized base 未损坏、保留链连续、redact 占位仍在；不能再声称可以独立复验已删除区段的每一步变化。产品已经允许远古历史降采样，因此无需为后一项制造虚假审计承诺。

## D. 修订后场景走查

| # | 场景 | 结果 | 结论 |
| --- | --- | --- | --- |
| 1 | Dream 已生成候选，擦除随后提交，Dream 再写回 | 通过 | redact 推进版本，CAS 失败；rebase validator 再查 deny-set，候选不能提交 |
| 2 | Dream 已解密 Evidence、尚未发送远程请求，用户确认擦除 | 未通过 | 当前没有 dispatch barrier 或最终 generation 复检，擦除确认后仍可能发生新披露 |
| 3 | 远程请求已发出后用户确认擦除 | 条件通过 | 本地无法撤回是诚实边界；台账需保证该请求一定记录，并显示为清除前已披露 |
| 4 | 第一段已提交，应用在 Lance/FTS 清理前崩溃 | 条件通过 | 查询 deny-set 和启动续跑方向成立；normalized target 表与同步 FTS 去可见仍需补齐 |
| 5 | keyring 紧凑重写失败或只切了一半 | 未通过 | 尚无 keyring generation、原子换根和旧代 key 移除协议 |
| 6 | 擦除前的 generation 备份包含 SQLite FTS | 未通过 | 当前目录级复制形态会复制索引；“备份不含派生索引”没有物理布局支撑 |
| 7 | 一年后把细粒度 diff 压缩为月度基点 | 未通过 | 物化基点无权威表、manifest 与 event-head 绑定，重锚无法实现或验证 |
| 8 | 十万 Evidence 冷启动后首次普通召回 | 条件通过 | 算法链可成立，但 top-K 解密、keyring 冷读和 encrypted index 没有预算或 benchmark |
| 9 | 连续执行大量彻底清除 | 未通过 | `deny_set_json` 查询与缓存 generation 没有可扩展物理结构 |
| 10 | `pending_notice` 期间会话结束，用户之后确认 | 通过 | 不回补、证据从确认时刻起算已经在需求和架构中写死，无需再裁决 |

## E. 第五轮要求的最小修订包

不要重写整份架构，只需把以下七项补丁并入第四轮设计：

1. **schema 去明文**：逐表替换所有语义列，并附列级数据分类矩阵。
2. **五物理根图**：authority、encrypted blob、keyring、derived index、app backup 的路径、密钥和复制规则。
3. **index generation**：FTS/vector/projection 的备份排除、静态加密、重建、原子切换和旧代销毁。
4. **privacy generation + disclosure barrier**：使远程发送与擦除第一段有唯一先后顺序。
5. **normalized erasure targets**：JSON 留作审计，在线过滤走索引表和单调 generation。
6. **key hierarchy**：DEK/keyring/root 的包装、轮换、回滚和崩溃恢复。
7. **materialized base + hash spec**：权威表、manifest、canonical bytes、domain separation、snapshot event head 和审计措辞。

完成后再跑一次故障注入审查；若这七项自洽，第六轮应可以直接给出 `READY FOR ENGINEERING RFC`，无需再讨论产品愿景。

## F. 工程 RFC 前必须新增的验证门槛

1. 擦除与远程 dispatch 的确定性竞态测试：在“解密后/台账前/发送前/发送后/CAS 前”逐点暂停。
2. 第一段提交后，全查询面与所有新模型请求均无法命中 closure 的不变量测试。
3. FTS、vector、projection、run ledger、诊断日志和 app backup 的 canary 扫描；`verified` 前任一命中都必须失败。
4. keyring 原子换根故障注入：写新代、fsync、rename、删旧代每一步崩溃后都能恢复，且 erased DEK 不会随回滚复活。
5. materialized base golden fixture：压缩前后 `tree_hash` 相同，保留链 event head 可验证，redact 占位不丢失。
6. canonical serialization 跨版本 fixture：字段顺序、Unicode、数字和时间编码不会让同一状态产生不同 hash。
7. 十万 Evidence / 一万叶片下 warm/cold recall benchmark，分别测索引、过滤、key 批取、解密和 hydration。
8. 一万次 erasure request 下 normalized deny lookup 与缓存失效 benchmark。

## G. 复用判定更新

- **可以继续复用**：SQLite 事务封装、LanceDB 候选经 SQLite eligibility 过滤、MemoryDream 单 owner、TreeDiff 版本 CAS、现有 generation 的 marker/staging/原子换根思想。
- **已退役的开发期原型**：旧 `ChatStorageMigrationCoordinator` 的 marker/staging 思路只作历史参考，不再是当前可复用实现。
- **只能作为 seed**：Electron `safeStorage`。它适合保护少量 root/wrapping secret，不应直接等同于完整 content-key service。
- **必须新增**：MemoryErasureService、normalized erasure target repository、MemoryDisclosureGateway/privacy barrier、ContentKeyService、独立 index generation、materialized base/compaction repository。
- **仍然应该删除**：旧 memory graph/timeline、renderer 自动沉淀、`save_memory` 直写、旧 MemoryRecord/FTS/vector schema。第五轮没有推翻此前删除结论。

## H. 是否需要重新裁决产品问题

不需要。

第四轮已经明确：远古历史允许降采样；清除确认后即时不可见、后台验证完成才显示彻底清除；pending_notice 不回补；远程 provider 已收到的数据无法由本地撤回；普通用户和高级用户共享同一记忆内核。第五轮问题都是这些裁决的工程实现缺口，不应重新交给产品负责人兜底。

## I. 下一轮评审指令

建议给下一位评审者的指令：

> 从第五轮报告 B、C、F 三节开始，重点攻击：所有权威 schema 是否已经逐列消除明文语义；index generation 与 app backup 是否真的物理隔离；Erasure Saga 和远程模型 dispatch 是否有可线性化的 privacy barrier；keyring 回滚是否可能复活已擦 DEK；materialized base 是否有权威表、manifest 与 event-head 绑定。若上述五项成立，再核查十万 Evidence 冷/热召回预算，最后决定是否 `READY FOR ENGINEERING RFC`。
