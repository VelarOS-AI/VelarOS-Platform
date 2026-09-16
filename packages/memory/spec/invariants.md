# 长期记忆不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/system/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | `memory:save` 写下的证据来源固定是 `agent_tool`、信任级封顶 `agent_derived`：模型自报的「用户已确认」铸不出 `user_stated` | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 去重键是「作用域 + 类别 + 标题 + 正文」：同一空间里这四样都相同的内容再写一次不会多出一条，措辞变了就是新的一条 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 后端拒收（证据的作用域没有对应的可写根）时当场如实报错，绝不回一句「已记下」 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | `memory:get` 与 `memory:archive` 用同一条可见性读门：当前空间看不见的 id 一律 `NOT_FOUND`，不读也不改 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 归档不是删除：普通召回看不到、`deep` 召回仍找得到，同一来源再采集不会让它复活 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 作用域可见性只有一个判据 `memoryScopes.isVisible`：工具读门、后端过滤与宿主自己过滤召回结果时用的是同一份规则 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 文件权威层的条目只能是本作用域根下 `entries/` 里的 `.md`：越界 id 与越界索引行一律当作不存在 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 任何后端落盘前经同一道证据清洗：秘密打码、标题与正文截断、空内容拒收 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 解析权威层时跳过派生索引与缺必备动词（`capture` / `recall` / `inspect` / `archive`）的后端：宁可判「这一档没装」，也不让半个权威层静默丢数据 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 写入的作用域根必须与证据的作用域一致：找不到根就拒收，不静默落进别的池子 | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 派生索引的角色在类型上钉死为 `derived-index`：可写成 `authority` 的派生索引等于给自己开后门 | 类型 | `src/contract/requires.ts::MemoryDerivedIndexBackend` |
| INV-12 | `./contracts` 的整条引用链不碰 Node 内置模块，渲染进程可以直接加载 | 门禁 | `check:module-ownership` |
| INV-13 | 记忆包不 import 知识包、宿主包与 Electron：记忆与知识永不合并是域宪章级的判决 | 门禁 | `check:memory-boundaries` |
| INV-14 | 回合召回不阻塞发送：可等待入口在硬预算内返回，失败、超时、并发都回空；同一条记忆每会话只注入一次、每轮有上限（**未验证**：要真实会话与计时，留给宿主接线那一轮的真机验收） | 文字 | |
