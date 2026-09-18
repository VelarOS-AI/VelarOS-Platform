# 长期记忆不变量登记

每一条都是本单元对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式分五档：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。

INV-1 到 INV-14 是原 `@velaros-ai/memory` 的登记，编号照旧：记忆整包并进本单元、四个工具换成代码面的 `velar:memory` 之后，
INV-1 到 INV-5 说的就是这四个操作，措辞跟着改，承诺本身不变。模型面这一层新添的承诺接在后面，从 INV-15 起。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | save 写下的证据来源固定是 `agent_tool`、信任级封顶 `agent_derived`：模型自报的「用户已确认」铸不出 `user_stated` | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 去重键是「作用域 + 类别 + 标题 + 正文」：同一空间里这四样都相同的内容再写一次不会多出一条，措辞变了就是新的一条 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 后端拒收（证据的作用域没有对应的可写根）时当场如实报错，绝不回一句「已记下」 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | get 与 archive 用同一条可见性读门：当前空间看不见的 id 一律 `NOT_FOUND`，不读也不改 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 归档不是删除：普通召回看不到、`deep` 召回仍找得到，同一来源再采集不会让它复活 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 作用域可见性只有一个判据 `memoryScopes.isVisible`：操作的读门、后端过滤与宿主自己过滤召回结果时用的是同一份规则 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 文件权威层的条目只能是本作用域根下 `entries/` 里的 `.md`：越界 id 与越界索引行一律当作不存在 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 任何后端落盘前经同一道证据清洗：秘密打码、标题与正文截断、空内容拒收 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 解析权威层时跳过派生索引与缺必备动词（`capture` / `recall` / `inspect` / `archive`）的后端：宁可判「这一档没装」，也不让半个权威层静默丢数据 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 写入的作用域根必须与证据的作用域一致：找不到根就拒收，不静默落进别的池子 | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 派生索引的角色在类型上钉死为 `derived-index`：可写成 `authority` 的派生索引等于给自己开后门 | 类型 | `contract/requires.ts::MemoryDerivedIndexBackend` |
| INV-12 | `./memory/contracts` 的整条引用链不碰 Node 内置模块，渲染进程可以直接加载 | 门禁 | `check:module-ownership` |
| INV-13 | 记忆单元不 import 知识单元、宿主包与 Electron，反过来知识单元也不 import 记忆单元：记忆与知识永不合并是域宪章级的判决 | 门禁 | `check:memory-boundaries` |
| INV-14 | 回合召回不阻塞发送：可等待入口在硬预算内返回，失败、超时、并发都回空；同一条记忆每会话只注入一次、每轮有上限（**未验证**：要真实会话与计时，留给宿主接线那一轮的真机验收） | 文字 | |
| INV-15 | 入参在做事之前核对：类别只认类别表里的（旧别名不宣传也不收）、标题与正文非空且不超上限、摘要与来源与任务键与标签不超上限、limit 是 1 到上限的整数、deep 是布尔、id 非空；不合法当场 `VALIDATION`，端口一次都不调 | 测试 | `spec/acceptance.test.ts` |
| INV-16 | 召回的条数由模型面定：有话题默认 10、没有话题默认 20、最多 50；不给 deep 就只找在用的；召回按当前空间的作用域收敛，global 作用域才代表「全部」 | 测试 | `spec/acceptance.test.ts` |
| INV-17 | 交给模型的只有声明里的字段：行身份、概念 id、显著度、快照版本不往外带；证据 id 叫 sources；树上的位置只有树档有，空路径不出现；召回的每条都带着记下的内容，不折叠成摘要 | 测试 | `spec/acceptance.test.ts` |
| INV-18 | 写入回执照后端说：有整理管线（dream）的是 consolidating 并回 treeVersion，没有的是 immediate、不带 treeVersion | 测试 | `spec/acceptance.test.ts` |
| INV-19 | 归档没归到（记忆目录只读）时 `archived` 为假，不说已经归档 | 测试 | `spec/acceptance.test.ts` |
| INV-20 | 文件分工与对外边界不塌：四个操作在一个操作文件里、空间端口的每个方法都有操作在调；合同、类型、常量分开且接口成员有中文说明；实现一类一文件、类实现接口、按登记分层引用 | 门禁 | `check:module-ownership` |
| INV-21 | 模型面是 `velar:memory`：声明从源码生成、只放出四个操作，随包发布的声明（`VelarMemoryModule`）与生成物是同一份；空间端口与调用上下文不进模型面；参数面没有 userConfirmed、trustLevel、sourceType 这类让模型自报身份的旋钮；模型写的程序照这份声明调到真实操作 | 测试 | `spec/acceptance.test.ts` |
| INV-22 | 声明里写给模型的数字与取值就是常量表里的：类别（`MemoryEvidenceCategories`）、各字段的上限与召回的缺省条数（`MemoryInputLimits`）；改常量不改说明（或反过来）过不了验收 | 测试 | `spec/acceptance.test.ts` |
| INV-23 | 代码模版（`template.js`）是日常用法的示例程序（只是示例，模型按需要改写、不要求照着写），import 只写一次；它整份照生成的真实声明过类型检查，不嵌进声明，随模型面发布、按需读（`velar:program` 的 template）；每个函数在真的文件档记忆库上照写法跑通由 `test/template.test.ts` 核对 | 测试 | `spec/acceptance.test.ts` |
